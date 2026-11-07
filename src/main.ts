/*
 * ioBroker.blink
 * Adapter lifecycle only - Blink API in lib/api, object tree in lib/model, helpers in lib/util.
 *
 * Phase 2: login with 2FA, encrypted session, token refresh, backoff. Polling follows in phase 3.
 */

import * as utils from '@iobroker/adapter-core';
import {
    AbortedError,
    CredentialsRejectedError,
    RateLimitedError,
    SessionExpiredError,
    TwoFactorRejectedError,
    describeError,
} from './lib/api/errors';
import { HttpClient } from './lib/api/http';
import { OAuthFlow, newHardwareId } from './lib/api/oauth';
import type { Session, TokenSet } from './lib/api/types';
import {
    decodePending,
    decodeSession,
    encodePending,
    encodeSession,
    type SecretCodec,
} from './lib/model/session-store';
import { TEST_ORIGIN_ENV, normalizeEmail, normalizePin, pollIntervalSeconds, testOrigin } from './lib/util/config';

/** First retry after a failed login, doubled up to RETRY_MAX_S (audit B.11.4) */
const RETRY_START_S = 60;
const RETRY_MAX_S = 1800;
/** Random start delay, so many instances restarting together do not hit the cloud at once (audit B.11.1) */
const START_JITTER_MS = 2_000;
/** The access token is renewed this long before it expires */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Shortest wait before a scheduled refresh */
const REFRESH_MIN_DELAY_MS = 60_000;

type LoginState =
    | 'ok'
    | 'connecting'
    | 'twoFactorRequired'
    | 'twoFactorRejected'
    | 'credentialsRejected'
    | 'rateLimited'
    | 'error'
    | 'noConfig';

class Blink extends utils.Adapter {
    private readonly abort = new AbortController();
    private oauth: OAuthFlow | undefined;
    private session: Session | undefined;
    private timer: ioBroker.Timeout | undefined;
    private retrySeconds = RETRY_START_S;
    private email = '';
    private pollSeconds = 0;
    private connecting = false;
    private expiredRetried = false;
    private loginState: LoginState | undefined;
    private readonly codec: SecretCodec = {
        encrypt: value => this.encrypt(value),
        decrypt: value => this.decrypt(value),
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'blink',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const email = normalizeEmail(this.config.email);
        if (!email || !this.config.password) {
            await this.setLoginState('noConfig');
            this.log.error(
                'Please enter the e-mail address and password of your Blink account in the instance settings.',
            );
            return;
        }
        this.email = email;
        this.pollSeconds = pollIntervalSeconds(this.config.pollInterval);

        const origin = testOrigin(process.env[TEST_ORIGIN_ENV]);
        if (origin) {
            this.log.warn(`Test mode: all requests go to ${origin}`);
        }
        this.oauth = new OAuthFlow(new HttpClient({ testOrigin: origin, signal: this.abort.signal }));
        await this.setLoginState('connecting');
        this.schedule(Math.floor(Math.random() * START_JITTER_MS), () => this.connect());
    }

    /**
     * Runs a single chained timer - retry, refresh and (later) polling never overlap (audit B.11.2).
     *
     * @param ms - Delay
     * @param task - Task to run
     */
    private schedule(ms: number, task: () => Promise<void>): void {
        this.clearTimeout(this.timer);
        this.timer = this.setTimeout(() => {
            this.timer = undefined;
            void task();
        }, ms);
    }

    /** Restores the session or logs in. */
    private async connect(): Promise<void> {
        if (this.connecting || !this.oauth) {
            return;
        }
        this.connecting = true;
        try {
            const retryAt = Number((await this.getStateAsync('auth.retryAt'))?.val) || 0;
            if (retryAt > Date.now()) {
                await this.setLoginState('rateLimited');
                this.log.warn(`Blink rate limit active, next login attempt at ${new Date(retryAt).toLocaleString()}`);
                this.schedule(retryAt - Date.now(), () => this.connect());
                return;
            }

            this.session = decodeSession((await this.getStateAsync('auth.session'))?.val, this.codec);
            if (this.session) {
                try {
                    await this.ensureFresh();
                    await this.oauth.account(this.session.accessToken);
                    await this.online();
                    return;
                } catch (err) {
                    if (!(err instanceof SessionExpiredError)) {
                        throw err;
                    }
                    this.log.info(`${err.message} - logging in again`);
                    await this.dropSession();
                }
            }
            await this.login();
        } catch (err) {
            await this.handleFailure(err);
        } finally {
            this.connecting = false;
        }
    }

    /** Full login, resumes a pending 2FA login when a code is configured. */
    private async login(): Promise<void> {
        const oauth = this.oauth!;
        const started = Date.now();
        const pin = normalizePin(this.config.pin);
        const pending = decodePending((await this.getStateAsync('auth.pending'))?.val, this.codec);
        const hardwareId = await this.hardwareId(pending?.hardwareId);

        let tokens: TokenSet;
        if (pending && pin) {
            this.log.info('Sending the 2FA code to Blink');
            tokens = await oauth.verifyTwoFactor(pending, pin);
        } else if (pending) {
            // a code was already sent - a new login would only trigger another SMS
            await this.setLoginState('twoFactorRequired');
            this.log.warn(
                'Blink is waiting for the 2FA code. Enter it in the instance settings (2FA code) and save, ' +
                    'or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).',
            );
            return;
        } else {
            this.log.info('Logging in to Blink');
            const result = await oauth.start(this.email, this.config.password, hardwareId);
            if (result.kind === 'twoFactor') {
                if (pin) {
                    tokens = await oauth.verifyTwoFactor(result.pending, pin);
                } else {
                    await this.setState('auth.pending', encodePending(result.pending, this.codec), true);
                    await this.setLoginState('twoFactorRequired');
                    const { channel, destination } = result.challenge;
                    const via = [channel, destination].filter(Boolean).join(' to ');
                    this.log.warn(
                        `Blink sent a 2FA code${via ? ` (${via})` : ''}. Enter it within 10 minutes in the instance ` +
                            'settings (2FA code) and save, or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).',
                    );
                    return;
                }
            } else {
                tokens = result.tokens;
            }
        }
        await this.completeLogin(tokens, hardwareId, !!pin);
        this.log.debug(`Login took ${Date.now() - started} ms`);
    }

    /**
     * Stores the new session and goes online - or restarts once to remove the used 2FA code from the settings.
     *
     * @param tokens - New tokens
     * @param hardwareId - Hardware ID of the login
     * @param removePin - The 2FA code from the settings was used
     */
    private async completeLogin(tokens: TokenSet, hardwareId: string, removePin: boolean): Promise<void> {
        const account = await this.oauth!.account(tokens.accessToken);
        this.session = { ...tokens, hardwareId, ...account };
        await this.saveSession();
        await this.setState('auth.pending', '', true);
        await this.setState('auth.retryAt', 0, true);
        this.log.info('Logged in to Blink');
        if (removePin && this.config.pin) {
            this.log.info('Removing the used 2FA code from the settings - the adapter restarts once');
            await this.updateConfig({ pin: '' });
            return;
        }
        await this.online();
    }

    /** Renews the access token when it expires soon. */
    private async ensureFresh(): Promise<void> {
        const session = this.session;
        if (!session || session.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
            return;
        }
        if (!session.refreshToken) {
            throw new SessionExpiredError('no refresh token');
        }
        const tokens = await this.oauth!.refresh(session.refreshToken, session.hardwareId);
        this.session = { ...session, ...tokens };
        await this.saveSession();
        this.log.debug('Access token renewed');
    }

    /** Connected: reset the backoff and plan the next token refresh. */
    private async online(): Promise<void> {
        this.retrySeconds = RETRY_START_S;
        this.expiredRetried = false;
        await this.setState('info.connection', true, true);
        await this.setLoginState('ok');
        const delay = Math.max(
            REFRESH_MIN_DELAY_MS,
            (this.session?.expiresAt ?? 0) - Date.now() - REFRESH_MARGIN_MS + 1_000,
        );
        this.schedule(delay, () => this.refreshCycle());
        this.log.debug(
            `Next token refresh in ${Math.round(delay / 60_000)} min, polling (phase 3) every ${this.pollSeconds} s`,
        );
    }

    private async refreshCycle(): Promise<void> {
        try {
            await this.ensureFresh();
            await this.online();
        } catch (err) {
            await this.handleFailure(err);
        }
    }

    /**
     * Error handling without login loops (audit B.11.5): rejected credentials stop, rate limits wait,
     * other errors retry with exponential backoff.
     *
     * @param err - Caught error
     */
    private async handleFailure(err: unknown): Promise<void> {
        if (err instanceof AbortedError) {
            return;
        }
        await this.setState('info.connection', false, true);

        if (err instanceof CredentialsRejectedError) {
            await this.setLoginState('credentialsRejected');
            this.log.error(`${err.message}. No further attempts - check the instance settings.`);
            return;
        }
        if (err instanceof TwoFactorRejectedError) {
            await this.setLoginState('twoFactorRejected');
            this.log.error(`${err.message}. Enter the current code from Blink.`);
            if (this.config.pin) {
                await this.updateConfig({ pin: '' });
            }
            return;
        }
        if (err instanceof RateLimitedError) {
            const retryAt = Date.now() + err.retryAfterMs;
            await this.setState('auth.retryAt', retryAt, true);
            await this.setLoginState('rateLimited');
            this.log.warn(`${err.message} - waiting until ${new Date(retryAt).toLocaleString()}`);
            this.schedule(err.retryAfterMs, () => this.connect());
            return;
        }
        if (err instanceof SessionExpiredError) {
            await this.dropSession();
            if (!this.expiredRetried) {
                this.expiredRetried = true;
                this.log.info(`${err.message} - logging in again`);
                this.schedule(1_000, () => this.connect());
                return;
            }
        }

        await this.setLoginState('error');
        this.log.warn(`Blink login failed: ${describeError(err)}. Next attempt in ${this.retrySeconds} s`);
        this.schedule(this.retrySeconds * 1000, () => this.connect());
        this.retrySeconds = Math.min(this.retrySeconds * 2, RETRY_MAX_S);
    }

    /**
     * sendTo commands: verifyPin.
     *
     * @param obj - Message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj?.command !== 'verifyPin') {
            return;
        }
        const reply = (result: Record<string, unknown>): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
        };
        const message = obj.message as { pin?: unknown } | undefined;
        const pin = normalizePin(typeof message?.pin === 'number' ? String(message.pin) : message?.pin);
        const pending = decodePending((await this.getStateAsync('auth.pending'))?.val, this.codec);
        if (!pin) {
            return reply({ success: false, error: 'invalid code (4 to 8 digits)' });
        }
        if (!pending || !this.oauth || this.connecting) {
            return reply({ success: false, error: 'no login is waiting for a 2FA code' });
        }
        this.connecting = true;
        try {
            const tokens = await this.oauth.verifyTwoFactor(pending, pin);
            await this.completeLogin(tokens, pending.hardwareId, false);
            reply({ success: true });
        } catch (err) {
            await this.handleFailure(err);
            reply({ success: false, error: describeError(err) });
        } finally {
            this.connecting = false;
        }
    }

    /**
     * Stored hardware ID, or a new one (kept across logins so Blink recognises the "device").
     *
     * @param preferred - Hardware ID of a pending login
     */
    private async hardwareId(preferred: string | undefined): Promise<string> {
        if (preferred) {
            return preferred;
        }
        const stored = (await this.getStateAsync('auth.hardwareId'))?.val;
        if (typeof stored === 'string' && stored) {
            try {
                const id = this.decrypt(stored);
                if (/^[0-9A-F-]{36}$/.test(id)) {
                    return id;
                }
            } catch {
                // damaged value - create a new ID below
            }
        }
        const id = newHardwareId();
        await this.setState('auth.hardwareId', this.encrypt(id), true);
        return id;
    }

    private async saveSession(): Promise<void> {
        if (this.session) {
            await this.setState('auth.session', encodeSession(this.session, this.codec), true);
        }
    }

    private async dropSession(): Promise<void> {
        this.session = undefined;
        await this.setState('auth.session', '', true);
    }

    private async setLoginState(state: LoginState): Promise<void> {
        if (state !== this.loginState) {
            this.loginState = state;
            await this.setState('info.loginState', state, true);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            this.abort.abort();
            this.clearTimeout(this.timer);
            this.timer = undefined;
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Blink(options);
} else {
    // otherwise start the instance directly
    (() => new Blink())();
}
