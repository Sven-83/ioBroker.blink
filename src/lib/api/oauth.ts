/*
 * OAuth 2.0 login with PKCE (RFC 7636) and optional 2FA against api.oauth.blink.com.
 * Flow and parameters as used by the iOS app (known from community clients, e.g. Pischleuder1/ioBroker.blink, MIT).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    APP_BRAND,
    APP_VERSION,
    CLIENT_ID,
    DEVICE_BRAND,
    DEVICE_MODEL,
    DEVICE_OS_VERSION,
    MAX_REDIRECTS,
    OAUTH_2FA_PATH,
    OAUTH_AUTHORIZE_PATH,
    OAUTH_ORIGIN,
    OAUTH_SIGNIN_PATH,
    OAUTH_TOKEN_PATH,
    REDIRECT_URI,
    REST_DEFAULT_ORIGIN,
    SCOPE,
    TIER_INFO_PATH,
    UA_APP,
    UA_BROWSER,
    restOriginForTier,
} from './constants';
import {
    ApiError,
    CredentialsRejectedError,
    RateLimitedError,
    SessionExpiredError,
    TwoFactorRejectedError,
} from './errors';
import { CookieJar, field, parseJson, retryAfterMs, type HttpClient, type HttpResponse } from './http';
import type { PendingLogin, TokenSet, TwoFactorChallenge } from './types';

/** Result of the first login step */
export type LoginResult =
    { kind: 'tokens'; tokens: TokenSet } | { kind: 'twoFactor'; pending: PendingLogin; challenge: TwoFactorChallenge };

/** Account data from tier_info */
export interface AccountInfo {
    /** Blink account ID */
    accountId: number;
    /** REST origin of the account's region */
    restOrigin: string;
}

const BROWSER_HEADERS = {
    'User-Agent': UA_BROWSER,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** New random hardware ID in the format of the iOS app */
export function newHardwareId(): string {
    return randomUUID().toUpperCase();
}

/** PKCE verifier and S256 challenge */
export function newPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: pkceChallenge(verifier) };
}

/**
 * S256 challenge of a verifier.
 *
 * @param verifier - PKCE verifier
 */
export function pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Masks a phone number or e-mail address for the log, e.g. +49******67.
 *
 * @param value - Destination from the 2FA answer
 */
export function maskDestination(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    const at = value.indexOf('@');
    if (at > 0) {
        return `${value[0]}***${value.slice(at)}`.replace(/@[^.]+/, '@***');
    }
    return value.length > 5 ? `${value.slice(0, 3)}******${value.slice(-2)}` : '***';
}

/**
 * CSRF token of the sign-in page.
 *
 * @param html - Body of GET /oauth/v2/signin
 */
export function extractCsrf(html: string): string | undefined {
    const script = html.match(/<script[^>]*id=["']oauth-args["'][^>]*>([\s\S]*?)<\/script>/i);
    if (script) {
        const token = field(parseJson(script[1]), 'csrf-token');
        if (typeof token === 'string' && token) {
            return token;
        }
    }
    const json = html.match(/"csrf-token"\s*:\s*"([^"]+)"/);
    if (json) {
        return json[1];
    }
    const input = html.match(/name=["']csrf-token["'][^>]*value=["']([^"']+)["']/);
    return input?.[1];
}

/**
 * Authorization code from a redirect target (custom scheme of the app).
 *
 * @param location - Location header
 */
export function codeFromLocation(location: string | undefined): string | undefined {
    if (!location) {
        return undefined;
    }
    const match = location.match(/[?&]code=([^&#]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
}

function authorizeQuery(challenge: string, hardwareId: string): string {
    return new URLSearchParams({
        app_brand: APP_BRAND,
        app_version: APP_VERSION,
        client_id: CLIENT_ID,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        device_brand: DEVICE_BRAND,
        device_model: DEVICE_MODEL,
        device_os_version: DEVICE_OS_VERSION,
        hardware_id: hardwareId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
    }).toString();
}

/**
 * Path + query of a Location on the OAuth host, undefined for other targets.
 *
 * @param location - Location header
 */
function oauthPath(location: string): string | undefined {
    if (location.startsWith('/')) {
        return location;
    }
    try {
        const url = new URL(location);
        return url.origin === OAUTH_ORIGIN ? `${url.pathname}${url.search}` : undefined;
    } catch {
        return undefined;
    }
}

function isTwoFactorChallenge(response: HttpResponse): boolean {
    if (response.status === 412) {
        return true;
    }
    if (response.status !== 202) {
        return false;
    }
    const body = parseJson(response.body);
    return Array.isArray(field(body, 'tsv_methods')) || field(body, 'tsv_state') !== undefined;
}

function challengeOf(response: HttpResponse): TwoFactorChallenge {
    const body = parseJson(response.body);
    const channel = field(body, 'tsv_state');
    const next = Number(field(body, 'next_time_in_secs'));
    return {
        channel: typeof channel === 'string' ? channel : undefined,
        destination: maskDestination(field(body, 'phone') ?? field(body, 'email')),
        nextCodeInS: Number.isFinite(next) && next > 0 ? next : undefined,
    };
}

/** OAuth flow of one Blink account */
export class OAuthFlow {
    /**
     * @param http - HTTP client
     */
    public constructor(private readonly http: HttpClient) {}

    /**
     * Steps 1-3: authorize, sign-in page, credentials. Returns tokens or a pending 2FA login.
     *
     * @param email - Account e-mail
     * @param password - Account password
     * @param hardwareId - Stored hardware ID (new one if missing)
     */
    public async start(email: string, password: string, hardwareId: string): Promise<LoginResult> {
        const cookies = new CookieJar();
        const { verifier, challenge } = newPkcePair();

        const authorize = await this.get(`${OAUTH_AUTHORIZE_PATH}?${authorizeQuery(challenge, hardwareId)}`, cookies);
        let signinPath = (authorize.location && oauthPath(authorize.location)) || OAUTH_SIGNIN_PATH;
        let page = await this.get(signinPath, cookies);
        for (let hop = 0; page.status >= 300 && page.status < 400 && page.location && hop < MAX_REDIRECTS; hop++) {
            const next = oauthPath(page.location);
            if (!next) {
                break;
            }
            signinPath = next;
            page = await this.get(signinPath, cookies);
        }
        const csrfToken = extractCsrf(page.body);
        if (!csrfToken) {
            throw new ApiError('Reading the Blink sign-in page (no CSRF token)', page.status);
        }

        const signin = await this.http.request(`${OAUTH_ORIGIN}${signinPath}`, {
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                Accept: '*/*',
                Origin: OAUTH_ORIGIN,
                Referer: `${OAUTH_ORIGIN}${signinPath}`,
            },
            form: { username: email, password, 'csrf-token': csrfToken },
            cookies,
        });

        if (signin.status === 429) {
            throw new RateLimitedError(retryAfterMs(signin));
        }
        if (isTwoFactorChallenge(signin)) {
            return {
                kind: 'twoFactor',
                pending: {
                    cookies: cookies.toJSON(),
                    csrfToken,
                    verifier,
                    hardwareId,
                    signinPath,
                    createdAt: Date.now(),
                },
                challenge: challengeOf(signin),
            };
        }
        if (signin.status === 401 || signin.status === 403 || /invalid_user_credentials/i.test(signin.body)) {
            throw new CredentialsRejectedError();
        }
        if (signin.status >= 400) {
            throw new ApiError('Blink sign-in', signin.status);
        }
        const tokens = await this.finish(cookies, verifier, hardwareId, signin.location);
        return { kind: 'tokens', tokens };
    }

    /**
     * Step 3b: sends the 2FA code of a pending login and finishes it.
     *
     * @param pending - Pending login from start()
     * @param pin - 2FA code
     */
    public async verifyTwoFactor(pending: PendingLogin, pin: string): Promise<TokenSet> {
        const cookies = new CookieJar(pending.cookies);
        const response = await this.http.request(`${OAUTH_ORIGIN}${OAUTH_2FA_PATH}`, {
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                Accept: '*/*',
                Origin: OAUTH_ORIGIN,
                Referer: `${OAUTH_ORIGIN}${pending.signinPath}`,
            },
            form: { '2fa_code': pin, 'csrf-token': pending.csrfToken, remember_me: 'false' },
            cookies,
        });
        if (response.status === 429) {
            throw new RateLimitedError(retryAfterMs(response));
        }
        if (response.status >= 400) {
            throw new TwoFactorRejectedError(response.status);
        }
        return this.finish(cookies, pending.verifier, pending.hardwareId, response.location);
    }

    /**
     * New tokens from the refresh token.
     *
     * @param refreshToken - Stored refresh token
     * @param hardwareId - Stored hardware ID
     */
    public async refresh(refreshToken: string, hardwareId: string): Promise<TokenSet> {
        const response = await this.http.request(`${OAUTH_ORIGIN}${OAUTH_TOKEN_PATH}`, {
            method: 'POST',
            headers: { 'User-Agent': UA_APP, Accept: '*/*' },
            form: {
                app_brand: APP_BRAND,
                client_id: CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                hardware_id: hardwareId,
                scope: SCOPE,
            },
        });
        if (response.status === 429) {
            throw new RateLimitedError(retryAfterMs(response));
        }
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw new SessionExpiredError(`refresh rejected (HTTP ${response.status})`);
        }
        return this.tokensOf(response, 'Token refresh', refreshToken);
    }

    /**
     * Account ID and region of the logged-in user.
     *
     * @param accessToken - Access token
     */
    public async account(accessToken: string): Promise<AccountInfo> {
        const response = await this.http.request(`${REST_DEFAULT_ORIGIN}${TIER_INFO_PATH}`, {
            headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA_APP, Accept: 'application/json' },
        });
        if (response.status === 401) {
            throw new SessionExpiredError('access token rejected');
        }
        if (response.status !== 200) {
            throw new ApiError('Reading the Blink account', response.status);
        }
        const body = parseJson(response.body);
        const accountId = Number(field(body, 'account_id'));
        if (!Number.isInteger(accountId) || accountId <= 0) {
            throw new ApiError('Reading the Blink account (no account ID)', response.status);
        }
        return { accountId, restOrigin: restOriginForTier(field(body, 'tier')) };
    }

    private get(path: string, cookies: CookieJar): Promise<HttpResponse> {
        return this.http.request(`${OAUTH_ORIGIN}${path}`, { headers: BROWSER_HEADERS, cookies });
    }

    /**
     * Steps 4-5: finds the authorization code (redirects, then the bare and the full authorize URL)
     * and exchanges it for tokens.
     *
     * @param cookies - Cookie jar of the login
     * @param verifier - PKCE verifier
     * @param hardwareId - Hardware ID
     * @param location - Location of the sign-in or 2FA answer
     */
    private async finish(
        cookies: CookieJar,
        verifier: string,
        hardwareId: string,
        location: string | undefined,
    ): Promise<TokenSet> {
        const candidates = [
            ...(location ? [location] : []),
            OAUTH_AUTHORIZE_PATH,
            `${OAUTH_AUTHORIZE_PATH}?${authorizeQuery(pkceChallenge(verifier), hardwareId)}`,
        ];
        let code: string | undefined;
        for (const candidate of candidates) {
            let target: string | undefined = candidate;
            for (let hop = 0; target && hop <= MAX_REDIRECTS && !code; hop++) {
                code = codeFromLocation(target);
                const path: string | undefined = code ? undefined : oauthPath(target);
                if (!path) {
                    break;
                }
                target = (await this.get(path, cookies)).location;
            }
            if (code) {
                break;
            }
        }
        if (!code) {
            throw new ApiError('Blink login (no authorization code)', 0);
        }

        const response = await this.http.request(`${OAUTH_ORIGIN}${OAUTH_TOKEN_PATH}`, {
            method: 'POST',
            headers: { 'User-Agent': UA_APP, Accept: '*/*' },
            form: {
                app_brand: APP_BRAND,
                client_id: CLIENT_ID,
                code,
                code_verifier: verifier,
                grant_type: 'authorization_code',
                hardware_id: hardwareId,
                redirect_uri: REDIRECT_URI,
                scope: SCOPE,
            },
        });
        return this.tokensOf(response, 'Token exchange', undefined);
    }

    private tokensOf(response: HttpResponse, what: string, previousRefresh: string | undefined): TokenSet {
        if (response.status !== 200) {
            throw new ApiError(what, response.status);
        }
        const body = parseJson(response.body);
        const accessToken = field(body, 'access_token');
        if (typeof accessToken !== 'string' || !accessToken) {
            throw new ApiError(`${what} (no access token)`, response.status);
        }
        const refreshToken = field(body, 'refresh_token');
        const expiresIn = Number(field(body, 'expires_in'));
        return {
            accessToken,
            refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : previousRefresh,
            expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        };
    }
}
