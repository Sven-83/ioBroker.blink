/*
 * Endpoints and client identity of the (unofficial) Blink cloud API.
 * The OAuth flow imitates the iOS app, the same way the community clients do (audit B.11.8).
 */

export const OAUTH_ORIGIN = 'https://api.oauth.blink.com';
export const OAUTH_AUTHORIZE_PATH = '/oauth/v2/authorize';
export const OAUTH_SIGNIN_PATH = '/oauth/v2/signin';
export const OAUTH_2FA_PATH = '/oauth/v2/2fa/verify';
export const OAUTH_TOKEN_PATH = '/oauth/token';

export const REST_DEFAULT_ORIGIN = 'https://rest-prod.immedia-semi.com';
export const TIER_INFO_PATH = '/api/v1/users/tier_info';

export const CLIENT_ID = 'ios';
export const APP_BRAND = 'blink';
export const APP_VERSION = '50.1';
export const SCOPE = 'client';
export const REDIRECT_URI = 'immedia-blink://applinks.blink.com/signin/callback';
export const DEVICE_BRAND = 'Apple';
export const DEVICE_MODEL = 'iPhone16,1';
export const DEVICE_OS_VERSION = '26.1';

export const UA_BROWSER =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
export const UA_APP = 'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';

/** Timeout of a single request (audit B.10.15) */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Redirect hops followed while looking for the authorization code */
export const MAX_REDIRECTS = 5;
/** Wait time when Blink rate-limits the login without saying how long */
export const RATE_LIMIT_FALLBACK_S = 600;

/**
 * REST origin of a Blink region ("tier"). Only short alphanumeric tiers are accepted,
 * so a manipulated answer can never send the token to another host.
 *
 * @param tier - Tier from /api/v1/users/tier_info, e.g. "e006"
 */
export function restOriginForTier(tier: unknown): string {
    return typeof tier === 'string' && /^[a-z0-9]{2,8}$/.test(tier)
        ? `https://rest-${tier}.immedia-semi.com`
        : REST_DEFAULT_ORIGIN;
}
