import { expect } from 'chai';
import {
    POLL_DEFAULT_S,
    POLL_JITTER_MS,
    POLL_MAX_S,
    POLL_MIN_S,
    normalizeEmail,
    normalizePin,
    pollDelayMs,
    pollIntervalSeconds,
} from './config';

describe('util/config', () => {
    it('clamps the polling interval', () => {
        expect(pollIntervalSeconds(120)).to.equal(120);
        expect(pollIntervalSeconds(5)).to.equal(POLL_MIN_S);
        expect(pollIntervalSeconds(99_999)).to.equal(POLL_MAX_S);
        expect(pollIntervalSeconds('90')).to.equal(90);
    });

    it('falls back to the default for invalid intervals', () => {
        for (const value of [undefined, null, '', 'abc', 0, -10, Number.NaN]) {
            expect(pollIntervalSeconds(value), String(value)).to.equal(POLL_DEFAULT_S);
        }
    });

    it('adds a bounded jitter to the polling delay', () => {
        expect(pollDelayMs(60, () => 0)).to.equal(60_000);
        expect(pollDelayMs(60, () => 0.999_999)).to.equal(60_000 + POLL_JITTER_MS - 1);
    });

    it('accepts and trims e-mail addresses', () => {
        expect(normalizeEmail('  user@example.invalid ')).to.equal('user@example.invalid');
        expect(normalizeEmail('no-at-sign')).to.equal(undefined);
        expect(normalizeEmail('a b@example.invalid')).to.equal(undefined);
        expect(normalizeEmail(42)).to.equal(undefined);
    });

    it('accepts only numeric 2FA codes', () => {
        expect(normalizePin(' 123 456 ')).to.equal('123456');
        expect(normalizePin('12ab56')).to.equal(undefined);
        expect(normalizePin('123')).to.equal(undefined);
        expect(normalizePin(undefined)).to.equal(undefined);
    });
});
