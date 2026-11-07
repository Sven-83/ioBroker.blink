/*
 * Serialises session and pending login for the encrypted auth.* states (audit B.10, never plain text).
 */

import type { PendingLogin, Session } from '../api/types';

/** encrypt/decrypt of the adapter (system secret) */
export interface SecretCodec {
    /** Encrypts with the system secret */
    encrypt(value: string): string;
    /** Decrypts with the system secret */
    decrypt(value: string): string;
}

/** A pending 2FA login is resumed only within this time; afterwards a new login is started */
export const PENDING_MAX_AGE_MS = 10 * 60_000;

function decode(value: unknown, codec: SecretCodec): Record<string, unknown> | undefined {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(codec.decrypt(value)) as unknown;
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Encrypted state value of a session.
 *
 * @param session - Session to store
 * @param codec - Adapter encrypt/decrypt
 */
export function encodeSession(session: Session, codec: SecretCodec): string {
    return codec.encrypt(JSON.stringify(session));
}

/**
 * Session from the encrypted state value, undefined if missing or damaged.
 *
 * @param value - State value
 * @param codec - Adapter encrypt/decrypt
 */
export function decodeSession(value: unknown, codec: SecretCodec): Session | undefined {
    const raw = decode(value, codec);
    if (
        !raw ||
        !isText(raw.accessToken) ||
        !isText(raw.hardwareId) ||
        !isText(raw.restOrigin) ||
        typeof raw.expiresAt !== 'number' ||
        typeof raw.accountId !== 'number' ||
        !/^https:\/\/rest-[a-z0-9]{2,8}\.immedia-semi\.com$/.test(raw.restOrigin)
    ) {
        return undefined;
    }
    return {
        accessToken: raw.accessToken,
        refreshToken: isText(raw.refreshToken) ? raw.refreshToken : undefined,
        expiresAt: raw.expiresAt,
        hardwareId: raw.hardwareId,
        accountId: raw.accountId,
        restOrigin: raw.restOrigin,
    };
}

/**
 * Encrypted state value of a pending login.
 *
 * @param pending - Pending login
 * @param codec - Adapter encrypt/decrypt
 */
export function encodePending(pending: PendingLogin, codec: SecretCodec): string {
    return codec.encrypt(JSON.stringify(pending));
}

/**
 * Pending login from the encrypted state value; undefined if missing, damaged or too old.
 *
 * @param value - State value
 * @param codec - Adapter encrypt/decrypt
 * @param now - Current time (tests)
 */
export function decodePending(value: unknown, codec: SecretCodec, now = Date.now()): PendingLogin | undefined {
    const raw = decode(value, codec);
    if (
        !raw ||
        !isText(raw.csrfToken) ||
        !isText(raw.verifier) ||
        !isText(raw.hardwareId) ||
        !isText(raw.signinPath) ||
        typeof raw.createdAt !== 'number' ||
        raw.cookies === null ||
        typeof raw.cookies !== 'object' ||
        now - raw.createdAt > PENDING_MAX_AGE_MS
    ) {
        return undefined;
    }
    const cookies: Record<string, string> = {};
    for (const [name, cookie] of Object.entries(raw.cookies as Record<string, unknown>)) {
        if (typeof cookie === 'string') {
            cookies[name] = cookie;
        }
    }
    return {
        cookies,
        csrfToken: raw.csrfToken,
        verifier: raw.verifier,
        hardwareId: raw.hardwareId,
        signinPath: raw.signinPath,
        createdAt: raw.createdAt,
    };
}
