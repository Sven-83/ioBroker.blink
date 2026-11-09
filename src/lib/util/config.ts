/*
 * Validation of the instance config.
 */

import { isIP } from 'node:net';
import { basename, isAbsolute } from 'node:path';

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

/** Limits of a live session in seconds: it keeps a battery camera awake */
export const LIVE_MAX_DEFAULT_S = 120;
export const LIVE_MAX_MIN_S = 30;
export const LIVE_MAX_MAX_S = 600;
/** Port of the live image */
export const LIVE_PORT_DEFAULT = 8766;

/**
 * Time limit of a live session from the config, clamped to the allowed range.
 *
 * @param value - Value from the instance config
 */
export function liveMaxSeconds(value: unknown): number {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return LIVE_MAX_DEFAULT_S;
    }
    return Math.min(Math.max(seconds, LIVE_MAX_MIN_S), LIVE_MAX_MAX_S);
}

/**
 * Address of the server of the live image (audit B.10.20): this computer only, unless the user decides otherwise.
 *
 * @param value - Value from the instance config
 */
export function liveBindAddress(value: unknown): string {
    const address = typeof value === 'string' ? value.trim() : '';
    return isIP(address) ? address : '127.0.0.1';
}

/**
 * Port of the server of the live image.
 *
 * @param value - Value from the instance config
 */
export function livePort(value: unknown): number {
    const port = Math.round(Number(value));
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : LIVE_PORT_DEFAULT;
}

/**
 * Program to start for ffmpeg (audit B.10.21): the plain name, or the absolute path of a program called ffmpeg.
 *
 * @param value - Value from the instance config
 * @returns The program, undefined if the value is not acceptable
 */
export function ffmpegCommand(value: unknown): string | undefined {
    const path = typeof value === 'string' ? value.trim() : '';
    if (!path) {
        return 'ffmpeg';
    }
    return isAbsolute(path) && /^ffmpeg(\.exe)?$/i.test(basename(path)) ? path : undefined;
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
