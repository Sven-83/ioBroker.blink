import { expect } from 'chai';
import { ApiError, RateLimitedError, SessionExpiredError } from './errors';
import { HttpClient } from './http';
import { OAuthFlow, newHardwareId } from './oauth';
import { RestClient } from './rest';
import type { Session } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain JS test helper shared with the integration test
const { startFakeBlink } = require('../../../test/lib/fake-blink') as {
    startFakeBlink: (options?: Record<string, unknown>) => Promise<FakeBlink>;
};

interface FakeBlink {
    origin: string;
    email: string;
    password: string;
    accountId: number;
    config: Record<string, unknown>;
    revokeAll(): void;
    close(): Promise<void>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected a rejection');
}

describe('api/rest', () => {
    let cloud: FakeBlink;
    let rest: RestClient;
    let session: Session;

    beforeEach(async () => {
        cloud = await startFakeBlink();
        const http = new HttpClient({ testOrigin: cloud.origin });
        rest = new RestClient(http);
        const hardwareId = newHardwareId();
        const result = await new OAuthFlow(http).start(cloud.email, cloud.password, hardwareId);
        if (result.kind !== 'tokens') {
            throw new Error('login without 2FA expected');
        }
        session = {
            ...result.tokens,
            hardwareId,
            accountId: cloud.accountId,
            restOrigin: 'https://rest-e006.immedia-semi.com',
        };
    });

    afterEach(async () => {
        await cloud.close();
    });

    it('reads the homescreen', async () => {
        const homescreen = await rest.homescreen(session);
        expect(homescreen.networks).to.have.length(1);
        expect(homescreen.syncModules).to.have.length(1);
        expect(homescreen.devices.map(device => device.kind)).to.deep.equal(['camera', 'mini', 'doorbell']);
    });

    it('reports a rejected token as an expired session', async () => {
        cloud.revokeAll();
        expect(await rejection(rest.homescreen(session))).to.be.instanceOf(SessionExpiredError);
    });

    it('takes the wait time of a rate limit from the Retry-After header', async () => {
        cloud.config.homescreenStatus = 429;
        const err = await rejection(rest.homescreen(session));
        expect(err).to.be.instanceOf(RateLimitedError);
        expect((err as RateLimitedError).retryAfterMs).to.equal(120_000);
    });

    it('reports server errors with the status', async () => {
        cloud.config.homescreenStatus = 503;
        const err = await rejection(rest.homescreen(session));
        expect(err).to.be.instanceOf(ApiError);
        expect((err as ApiError).status).to.equal(503);
    });

    it('rejects an answer that is not a homescreen', async () => {
        cloud.config.homescreen = { message: 'maintenance' };
        expect(await rejection(rest.homescreen(session))).to.be.instanceOf(ApiError);
    });
});
