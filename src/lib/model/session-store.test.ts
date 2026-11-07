import { expect } from 'chai';
import type { PendingLogin, Session } from '../api/types';
import {
    PENDING_MAX_AGE_MS,
    decodePending,
    decodeSession,
    encodePending,
    encodeSession,
    type SecretCodec,
} from './session-store';

/** Reversible stand-in for the adapter encryption: the stored value must not contain the plain JSON */
const codec: SecretCodec = {
    encrypt: value => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
};

const session: Session = {
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    expiresAt: 1_000_000,
    hardwareId: '00000000-0000-4000-8000-000000000001',
    accountId: 4242,
    restOrigin: 'https://rest-e006.immedia-semi.com',
};

const pending: PendingLogin = {
    cookies: { sid: 'abc' },
    csrfToken: 'csrf',
    verifier: 'verifier',
    hardwareId: session.hardwareId,
    signinPath: '/oauth/v2/signin',
    createdAt: 5_000,
};

describe('model/session-store', () => {
    it('round-trips a session through the codec', () => {
        const stored = encodeSession(session, codec);
        expect(stored).not.to.include('fake-access');
        expect(decodeSession(stored, codec)).to.deep.equal(session);
    });

    it('ignores empty, damaged and manipulated values', () => {
        expect(decodeSession('', codec)).to.equal(undefined);
        expect(decodeSession(undefined, codec)).to.equal(undefined);
        expect(decodeSession('not-base64-json', codec)).to.equal(undefined);
        const throwing: SecretCodec = {
            encrypt: codec.encrypt,
            decrypt: () => {
                throw new Error('bad secret');
            },
        };
        expect(decodeSession(encodeSession(session, codec), throwing)).to.equal(undefined);
        // a REST origin outside Blink would receive the token - must be refused
        const evil = encodeSession({ ...session, restOrigin: 'https://evil.example' }, codec);
        expect(decodeSession(evil, codec)).to.equal(undefined);
    });

    it('keeps a pending login only for a limited time', () => {
        const stored = encodePending(pending, codec);
        expect(decodePending(stored, codec, pending.createdAt + 1_000)).to.deep.equal(pending);
        expect(decodePending(stored, codec, pending.createdAt + PENDING_MAX_AGE_MS + 1)).to.equal(undefined);
    });
});
