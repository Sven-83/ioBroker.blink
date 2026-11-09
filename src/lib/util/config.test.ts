import { expect } from 'chai';
import {
    POLL_DEFAULT_S,
    POLL_JITTER_MS,
    POLL_MAX_S,
    POLL_MIN_S,
    IMAGE_RETENTION_DEFAULT_H,
    IMAGE_RETENTION_MAX_H,
    LIVE_MAX_DEFAULT_S,
    LIVE_MAX_MAX_S,
    LIVE_MAX_MIN_S,
    LIVE_PORT_DEFAULT,
    ffmpegCommand,
    imageRetentionHours,
    liveBindAddress,
    liveMaxSeconds,
    livePort,
    normalizeEmail,
    normalizePin,
    pollDelayMs,
    pollIntervalSeconds,
} from './config';

describe('util/config live image', () => {
    it('clamps the time limit and has a default', () => {
        expect(liveMaxSeconds(60)).to.equal(60);
        expect(liveMaxSeconds(5)).to.equal(LIVE_MAX_MIN_S);
        expect(liveMaxSeconds(99_999)).to.equal(LIVE_MAX_MAX_S);
        expect(liveMaxSeconds('abc')).to.equal(LIVE_MAX_DEFAULT_S);
    });

    it('stays on this computer unless a valid address is set', () => {
        expect(liveBindAddress('203.0.113.5')).to.equal('203.0.113.5');
        expect(liveBindAddress('::1')).to.equal('::1');
        for (const value of [undefined, '', 'tablet', '999.1.1.1', 42]) {
            expect(liveBindAddress(value), String(value)).to.equal('127.0.0.1');
        }
    });

    it('accepts only ports above the system range', () => {
        expect(livePort(9000)).to.equal(9000);
        for (const value of [undefined, 'abc', 80, 70_000]) {
            expect(livePort(value), String(value)).to.equal(LIVE_PORT_DEFAULT);
        }
    });

    it('starts only a program called ffmpeg', () => {
        const absolute = process.platform === 'win32' ? 'C:\\tools\\ffmpeg.exe' : '/usr/bin/ffmpeg';
        expect(ffmpegCommand('')).to.equal('ffmpeg');
        expect(ffmpegCommand(undefined)).to.equal('ffmpeg');
        expect(ffmpegCommand(absolute)).to.equal(absolute);
        for (const value of [
            'rm',
            'ffmpeg',
            '/bin/sh',
            'C:\\Windows\\System32\\cmd.exe',
            '../ffmpeg',
            'ffmpeg; rm -rf /',
        ]) {
            expect(ffmpegCommand(value), value).to.equal(undefined);
        }
    });
});

describe('util/config', () => {
    it('clamps the retention of images and has a default', () => {
        expect(imageRetentionHours(48)).to.equal(48);
        expect(imageRetentionHours(99_999)).to.equal(IMAGE_RETENTION_MAX_H);
        for (const value of [undefined, null, '', 'abc', 0, -1]) {
            expect(imageRetentionHours(value), String(value)).to.equal(IMAGE_RETENTION_DEFAULT_H);
        }
    });

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
