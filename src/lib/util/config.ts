/*
 * Validation of the instance config.
 */

/**
 * Polling interval limits in seconds. Blink wakes battery cameras for some requests,
 * so the default stays moderate (audit B.11.16).
 */
export const POLL_DEFAULT_S = 60;
export const POLL_MIN_S = 30;
export const POLL_MAX_S = 3600;

/**
 * Polling interval from the config, clamped to the allowed range.
 *
 * @param value - Value from the instance config
 */
export function pollIntervalSeconds(value: unknown): number {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return POLL_DEFAULT_S;
    }
    return Math.min(Math.max(seconds, POLL_MIN_S), POLL_MAX_S);
}

/**
 * Trimmed e-mail address, or undefined if it does not look like one.
 *
 * @param value - Value from the instance config
 */
export function normalizeEmail(value: unknown): string | undefined {
    const email = typeof value === 'string' ? value.trim() : '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/**
 * 2FA code from the config: digits only, 4 to 8 of them, otherwise undefined.
 *
 * @param value - Value from the instance config
 */
export function normalizePin(value: unknown): string | undefined {
    const pin = typeof value === 'string' ? value.replace(/\s+/g, '') : '';
    return /^\d{4,8}$/.test(pin) ? pin : undefined;
}
