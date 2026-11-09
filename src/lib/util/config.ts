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

/** Retention limits of images in hours (audit B.10.22) */
export const IMAGE_RETENTION_DEFAULT_H = 24;
export const IMAGE_RETENTION_MIN_H = 1;
export const IMAGE_RETENTION_MAX_H = 720;

/**
 * Retention period of images from the config, clamped to the allowed range.
 *
 * @param value - Value from the instance config
 */
export function imageRetentionHours(value: unknown): number {
    const hours = Math.round(Number(value));
    if (!Number.isFinite(hours) || hours <= 0) {
        return IMAGE_RETENTION_DEFAULT_H;
    }
    return Math.min(Math.max(hours, IMAGE_RETENTION_MIN_H), IMAGE_RETENTION_MAX_H);
}

/** Largest random addition to the polling interval (audit B.11.1) */
export const POLL_JITTER_MS = 5_000;

/**
 * Delay until the next poll: the interval plus a random jitter.
 *
 * @param seconds - Polling interval
 * @param random - Random source, 0 to below 1
 */
export function pollDelayMs(seconds: number, random: () => number = Math.random): number {
    return seconds * 1000 + Math.floor(random() * POLL_JITTER_MS);
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

/** Environment variable that points the client to a local fake cloud (integration test only) */
export const TEST_ORIGIN_ENV = 'BLINK_TEST_ORIGIN';

/**
 * Origin for the integration test. Only plain http on the loopback address is accepted,
 * so the variable can never send credentials or tokens to another host.
 *
 * @param value - Value of the environment variable
 */
export function testOrigin(value: string | undefined): string | undefined {
    return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : undefined;
}
