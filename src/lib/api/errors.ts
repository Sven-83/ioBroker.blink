/*
 * Error classes of the Blink client. Messages never contain tokens, passwords or e-mail addresses.
 */

/** Base class of all expected Blink errors */
export class BlinkError extends Error {
    /**
     * @param message - Error message
     */
    public constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** Blink rejected e-mail address or password - do not retry automatically (audit B.11.5) */
export class CredentialsRejectedError extends BlinkError {
    /** Creates the error */
    public constructor() {
        super('Blink rejected the e-mail address or password');
    }
}

/** Blink rejected the 2FA code */
export class TwoFactorRejectedError extends BlinkError {
    /**
     * @param status - HTTP status
     */
    public constructor(status: number) {
        super(`Blink rejected the 2FA code (HTTP ${status})`);
    }
}

/** Blink asks to wait before the next login or 2FA attempt */
export class RateLimitedError extends BlinkError {
    public readonly retryAfterMs: number;

    /**
     * @param retryAfterMs - Wait time in ms
     */
    public constructor(retryAfterMs: number) {
        super(`Blink rate limit, next attempt in ${Math.ceil(retryAfterMs / 1000)} s`);
        this.retryAfterMs = retryAfterMs;
    }
}

/** The stored session is no longer valid (refresh rejected) - a new login is needed */
export class SessionExpiredError extends BlinkError {
    /**
     * @param reason - Why the session is no longer valid
     */
    public constructor(reason: string) {
        super(`Blink session expired: ${reason}`);
    }
}

/** Unexpected HTTP status or answer */
export class ApiError extends BlinkError {
    public readonly status: number;

    /**
     * @param what - Failed action
     * @param status - HTTP status
     */
    public constructor(what: string, status: number) {
        super(`${what} failed (HTTP ${status})`);
        this.status = status;
    }
}

/** The adapter is shutting down */
export class AbortedError extends BlinkError {
    /** Creates the error */
    public constructor() {
        super('Request aborted');
    }
}

/**
 * Short, log-safe description of any error.
 *
 * @param err - Caught value
 */
export function describeError(err: unknown): string {
    if (err instanceof BlinkError) {
        return err.message;
    }
    if (err instanceof Error) {
        if (err.name === 'TimeoutError') {
            return 'request timed out';
        }
        const cause = (err as Error & { cause?: { code?: unknown } }).cause;
        const code = cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
        return `${err.message}${code}`;
    }
    return String(err);
}
