import { expect } from 'chai';
import { CredentialsRejectedError, RateLimitedError, SessionExpiredError, TwoFactorRejectedError } from './errors';
import { HttpClient } from './http';
import {
    OAuthFlow,
    codeFromLocation,
    extractCsrf,
    maskDestination,
    newHardwareId,
    newPkcePair,
    pkceChallenge,
} from './oauth';
import { restOriginForTier } from './constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain JS test helper shared with the integration test
const { startFakeBlink } = require('../../../test/lib/fake-blink') as {
    startFakeBlink: (options?: Record<string, unknown>) => Promise<FakeBlink>;
};

interface FakeBlink {
    origin: string;
    email: string;
    password: string;
    pin: string;
    accountId: number;
    stats: Record<string, number>;
    config: Record<string, unknown>;
    revokeAll(): void;
    close(): Promise<void>;
}

describe('api/oauth helpers', () => {
    it('creates a valid PKCE pair', () => {
        const { verifier, challenge } = newPkcePair();
        expect(verifier).to.match(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge).to.equal(pkceChallenge(verifier));
        // S256 = base64url(SHA-256): FIPS 180-2 test vector for "abc"
        expect(pkceChallenge('abc')).to.equal('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    });

    it('creates hardware IDs in the app format', () => {
        expect(newHardwareId()).to.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it('finds the CSRF token in all known page variants', () => {
        expect(extractCsrf('<script id="oauth-args" type="application/json">{"csrf-token":"a1"}</script>')).to.equal(
            'a1',
        );
        expect(extractCsrf('window.x = {"csrf-token":"b2"}')).to.equal('b2');
        expect(extractCsrf('<input name="csrf-token" value="c3">')).to.equal('c3');
        expect(extractCsrf('<html></html>')).to.equal(undefined);
    });

    it('reads the code from the app redirect', () => {
        expect(codeFromLocation('immedia-blink://applinks.blink.com/signin/callback?code=x%2By&state=1')).to.equal(
            'x+y',
        );
        expect(codeFromLocation('/oauth/v2/signin')).to.equal(undefined);
        expect(codeFromLocation(undefined)).to.equal(undefined);
    });

    it('masks phone numbers and e-mail addresses', () => {
        expect(maskDestination('+491701234567')).to.equal('+49******67');
        expect(maskDestination('someone@example.invalid')).to.equal('s***@***.invalid');
        expect(maskDestination('')).to.equal(undefined);
        expect(maskDestination(42)).to.equal(undefined);
    });

    it('accepts only plain region names for the REST host', () => {
        expect(restOriginForTier('e006')).to.equal('https://rest-e006.immedia-semi.com');
        expect(restOriginForTier('evil.com/x')).to.equal('https://rest-prod.immedia-semi.com');
        expect(restOriginForTier(undefined)).to.equal('https://rest-prod.immedia-semi.com');
    });
});

describe('api/oauth against the fake cloud', function () {
    this.timeout(10_000);
    let fake: FakeBlink;
    let flow: OAuthFlow;
    const hardwareId = '00000000-0000-4000-8000-000000000001';

    afterEach(async () => {
        await fake?.close();
    });

    async function start(options: Record<string, unknown> = {}): Promise<void> {
        fake = await startFakeBlink(options);
        flow = new OAuthFlow(new HttpClient({ testOrigin: fake.origin }));
    }

    it('logs in without 2FA and reads the account', async () => {
        await start();
        const result = await flow.start(fake.email, fake.password, hardwareId);
        expect(result.kind).to.equal('tokens');
        if (result.kind !== 'tokens') {
            return;
        }
        expect(result.tokens.accessToken).to.match(/^fake-access-/);
        expect(result.tokens.expiresAt).to.be.greaterThan(Date.now() + 3_600_000);
        const account = await flow.account(result.tokens.accessToken);
        expect(account).to.deep.equal({ accountId: fake.accountId, restOrigin: 'https://rest-e006.immedia-semi.com' });
    });

    it('rejects a wrong password', async () => {
        await start();
        await expect(flow.start(fake.email, 'wrong', hardwareId)).to.be.rejectedWith(CredentialsRejectedError);
    });

    for (const variant of ['412', 'tsv']) {
        it(`returns a pending login for 2FA (${variant}) and completes it with the code`, async () => {
            await start({ twoFactor: variant });
            const result = await flow.start(fake.email, fake.password, hardwareId);
            expect(result.kind).to.equal('twoFactor');
            if (result.kind !== 'twoFactor') {
                return;
            }
            if (variant === 'tsv') {
                expect(result.challenge).to.deep.equal({ channel: 'sms', destination: '+49******99', nextCodeInS: 60 });
            }
            // the pending login survives a JSON round trip (it is stored between restarts)
            const pending = JSON.parse(JSON.stringify(result.pending)) as typeof result.pending;
            const tokens = await flow.verifyTwoFactor(pending, fake.pin);
            expect(tokens.accessToken).to.match(/^fake-access-/);
            expect(fake.stats.codesSent).to.equal(1);
        });
    }

    it('rejects a wrong 2FA code', async () => {
        await start({ twoFactor: 'tsv' });
        const result = await flow.start(fake.email, fake.password, hardwareId);
        if (result.kind !== 'twoFactor') {
            throw new Error('2FA expected');
        }
        await expect(flow.verifyTwoFactor(result.pending, '000000')).to.be.rejectedWith(TwoFactorRejectedError);
    });

    it('reports the 2FA rate limit with the wait time', async () => {
        await start({ twoFactor: 'tsv', rateLimit2fa: true });
        const result = await flow.start(fake.email, fake.password, hardwareId);
        if (result.kind !== 'twoFactor') {
            throw new Error('2FA expected');
        }
        const err = (await flow.verifyTwoFactor(result.pending, fake.pin).catch((e: unknown) => e)) as RateLimitedError;
        expect(err).to.be.instanceOf(RateLimitedError);
        expect(err.retryAfterMs).to.equal(120_000);
    });

    it('refreshes the tokens and detects a revoked session', async () => {
        await start();
        const result = await flow.start(fake.email, fake.password, hardwareId);
        if (result.kind !== 'tokens') {
            throw new Error('tokens expected');
        }
        const renewed = await flow.refresh(result.tokens.refreshToken!, hardwareId);
        expect(renewed.accessToken).not.to.equal(result.tokens.accessToken);
        // the old refresh token was used up
        await expect(flow.refresh(result.tokens.refreshToken!, hardwareId)).to.be.rejectedWith(SessionExpiredError);
        fake.revokeAll();
        await expect(flow.account(renewed.accessToken)).to.be.rejectedWith(SessionExpiredError);
    });
});
