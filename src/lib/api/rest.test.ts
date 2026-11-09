import { expect } from 'chai';
import { ApiError, BusyError, RateLimitedError, SessionExpiredError } from './errors';
import { HttpClient } from './http';
import { OAuthFlow, newHardwareId } from './oauth';
import { RestClient, imageUrl } from './rest';
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
    stats: Record<string, number>;
    requests: { method: string; path: string }[];
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

describe('api/rest imageUrl', () => {
    const origin = 'https://rest-e006.immedia-semi.com';

    it('completes a path and adds the file ending', () => {
        expect(imageUrl('/media/1/a?ts=5', origin)).to.equal(`${origin}/media/1/a.jpg?ts=5`);
        expect(imageUrl('/media/1/a.jpg', origin)).to.equal(`${origin}/media/1/a.jpg`);
    });

    it('accepts other hosts of the Blink cloud', () => {
        expect(imageUrl('https://rest-prod.immedia-semi.com/a.jpg', origin)).to.equal(
            'https://rest-prod.immedia-semi.com/a.jpg',
        );
    });

    it('never lets the token leave the Blink cloud', () => {
        expect(imageUrl('https://evil.example/a.jpg', origin)).to.equal(undefined);
        expect(imageUrl('//evil.example/a.jpg', origin)).to.equal(undefined);
        expect(imageUrl('https://immedia-semi.com.evil.example/a.jpg', origin)).to.equal(undefined);
        expect(imageUrl('https://evilimmedia-semi.com/a.jpg', origin)).to.equal(undefined);
        expect(imageUrl('http://rest-e006.immedia-semi.com/a.jpg', origin), 'plain http').to.equal(undefined);
    });
});

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

    it('arms over the current path and follows the command', async () => {
        const id = await rest.setArmed(session, 1001, false);
        expect(id).to.be.a('number');
        expect(cloud.stats.armNew).to.equal(1);
        expect(cloud.stats.armOld).to.equal(0);
        expect(await rest.commandStatus(session, 1001, id!)).to.equal('done');
    });

    it('uses the older path only if the current one is unknown', async () => {
        cloud.config.armNewPathStatus = 404;
        const id = await rest.setArmed(session, 1001, false);
        expect(id).to.be.a('number');
        expect(cloud.stats.armNew).to.equal(1);
        expect(cloud.stats.armOld).to.equal(1);
    });

    it('does not send a command twice after any other error', async () => {
        cloud.config.armNewPathStatus = 500;
        const err = await rejection(rest.setArmed(session, 1001, false));
        expect((err as ApiError).status).to.equal(500);
        expect(cloud.stats.armOld).to.equal(0);
    });

    it('recognises a busy system and a running or failed command', async () => {
        cloud.config.armBusyCount = 1;
        expect(await rejection(rest.setArmed(session, 1001, false))).to.be.instanceOf(BusyError);

        cloud.config.armDelayMs = 60_000;
        const running = await rest.setArmed(session, 1001, false);
        expect(await rest.commandStatus(session, 1001, running!)).to.equal('running');

        cloud.config.armDelayMs = 0;
        cloud.config.armCommandFails = true;
        const failed = await rest.setArmed(session, 1001, false);
        expect(await rest.commandStatus(session, 1001, failed!)).to.equal('failed');
    });

    it('rejects a rejected token on commands as an expired session', async () => {
        cloud.revokeAll();
        expect(await rejection(rest.setArmed(session, 1001, false))).to.be.instanceOf(SessionExpiredError);
    });

    it('asks each device family over its own path', async () => {
        await rest.snapshot(session, 1001, 'camera', 3001);
        await rest.snapshot(session, 1001, 'mini', 3002);
        await rest.snapshot(session, 1001, 'doorbell', 3003);
        expect(cloud.stats.snapshot).to.equal(3);
        const paths = cloud.requests.filter(item => item.path.endsWith('/thumbnail')).map(item => item.path);
        expect(paths).to.deep.equal([
            '/network/1001/camera/3001/thumbnail',
            `/api/v1/accounts/${cloud.accountId}/networks/1001/owls/3002/thumbnail`,
            `/api/v1/accounts/${cloud.accountId}/networks/1001/doorbells/3003/thumbnail`,
        ]);
    });

    it('returns the command ID of a snapshot and recognises a busy system', async () => {
        expect(await rest.snapshot(session, 1001, 'camera', 3001)).to.be.a('number');
        cloud.config.snapshotBusyCount = 1;
        expect(await rejection(rest.snapshot(session, 1001, 'camera', 3001))).to.be.instanceOf(BusyError);
    });

    it('counts a finished command with an error status as failed', async () => {
        cloud.config.commandAnswer = { complete: true, status: 2102 };
        expect(await rest.commandStatus(session, 1001, 1)).to.equal('failed');
        cloud.config.commandAnswer = { complete: true, status: 0, status_code: 908 };
        expect(await rest.commandStatus(session, 1001, 1), 'seen live').to.equal('done');
        cloud.config.commandAnswer = { complete: false, status: 0, status_code: 908 };
        expect(await rest.commandStatus(session, 1001, 1), 'seen live').to.equal('running');
    });

    it('downloads an image', async () => {
        const image = await rest.downloadImage(session, '/media/3001/thumb-1?ts=1700000000');
        expect(image.subarray(0, 3)).to.deep.equal(Buffer.from([0xff, 0xd8, 0xff]));
        expect(image.toString('latin1')).to.contain('fake-3001-1');
    });

    it('refuses an image outside of the Blink cloud without a request', async () => {
        const before = cloud.stats.image;
        const err = await rejection(rest.downloadImage(session, 'https://evil.example/a.jpg'));
        expect(err).to.be.instanceOf(ApiError);
        expect(cloud.stats.image).to.equal(before);
    });

    it('reports a missing image and an expired session', async () => {
        cloud.config.imageStatus = 404;
        expect(await rejection(rest.downloadImage(session, '/media/3001/thumb-1'))).to.be.instanceOf(ApiError);
        cloud.config.imageStatus = 200;
        cloud.revokeAll();
        expect(await rejection(rest.downloadImage(session, '/media/3001/thumb-1'))).to.be.instanceOf(
            SessionExpiredError,
        );
    });

    it('refuses an answer that is not a JPEG', async () => {
        cloud.config.imageBody = '<html>maintenance</html>';
        const err = await rejection(rest.downloadImage(session, '/media/3001/thumb-1'));
        expect((err as Error).message).to.contain('not a JPEG');
    });
});
