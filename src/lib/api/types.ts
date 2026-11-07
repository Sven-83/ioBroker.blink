/*
 * Data kept between requests and restarts. Stored encrypted in states (lib/model/session-store).
 */

/** Tokens from /oauth/token */
export interface TokenSet {
    /** Bearer token for the REST API */
    accessToken: string;
    /** Token to get a new access token without password */
    refreshToken: string | undefined;
    /** Epoch ms when the access token expires */
    expiresAt: number;
}

/** Logged-in session */
export interface Session extends TokenSet {
    /** Random device ID sent to Blink; kept across logins so Blink recognises the "phone" */
    hardwareId: string;
    /** Blink account ID (part of most REST paths) */
    accountId: number;
    /** REST origin of the account's region, e.g. https://rest-e006.immedia-semi.com */
    restOrigin: string;
}

/** Login waiting for the 2FA code */
export interface PendingLogin {
    /** Cookies of the OAuth host */
    cookies: Record<string, string>;
    /** CSRF token of the sign-in page */
    csrfToken: string;
    /** PKCE verifier */
    verifier: string;
    /** Hardware ID used for this login */
    hardwareId: string;
    /** Path of the sign-in page (Referer of the 2FA request) */
    signinPath: string;
    /** Epoch ms */
    createdAt: number;
}

/** What Blink said about the 2FA challenge (no personal data except a masked destination) */
export interface TwoFactorChallenge {
    /** Channel of the code, e.g. "sms" */
    channel: string | undefined;
    /** e.g. "+49******67" */
    destination: string | undefined;
    /** Seconds until a new code can be requested */
    nextCodeInS: number | undefined;
}
