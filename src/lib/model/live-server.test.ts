import { expect } from 'chai';
import { request, type IncomingMessage } from 'node:http';
import { LIVE_MAX_CLIENTS, LiveServer } from './live-server';

const CAM = 5;
const TOKEN = 'a'.repeat(64);

function get(port: number, path: string, method = 'GET'): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const call = request({ host: '127.0.0.1', port, path, method, agent: false }, resolve);
        call.on('error', reject);
        call.end();
    });
}

function firstData(response: IncomingMessage): Promise<string> {
    return new Promise(resolve => {
        response.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1')));
    });
}

describe('model/live-server', () => {
    let server: LiveServer;
    let port: number;
    let counts: number[];
    const open: IncomingMessage[] = [];
    const path = `/live/${CAM}.mjpeg?token=${TOKEN}`;

    const connect = async (): Promise<IncomingMessage> => {
        const response = await get(port, path);
        response.on('error', () => undefined);
        open.push(response);
        return response;
    };

    beforeEach(async () => {
        counts = [];
        server = new LiveServer(count => counts.push(count));
        port = await server.start({ host: '127.0.0.1', port: 0 }, CAM, TOKEN);
    });

    afterEach(async () => {
        for (const response of open.splice(0)) {
            response.destroy();
        }
        await server.stop();
    });

    it('serves the image with the right token', async () => {
        const response = await connect();
        expect(response.statusCode).to.equal(200);
        expect(response.headers['content-type']).to.match(/^multipart\/x-mixed-replace; boundary=/);
    });

    it('sends no CORS header and forbids caching', async () => {
        const response = await connect();
        expect(response.headers['access-control-allow-origin']).to.equal(undefined);
        expect(response.headers['cache-control']).to.equal('no-store');
    });

    it('refuses a missing or wrong token', async () => {
        expect((await get(port, `/live/${CAM}.mjpeg`)).statusCode).to.equal(401);
        expect((await get(port, `/live/${CAM}.mjpeg?token=wrong`)).statusCode).to.equal(401);
        expect((await get(port, `/live/${CAM}.mjpeg?token=${'b'.repeat(64)}`)).statusCode).to.equal(401);
    });

    it('serves nothing else: no other camera, path or method', async () => {
        expect((await get(port, `/live/6.mjpeg?token=${TOKEN}`)).statusCode).to.equal(404);
        expect((await get(port, `/?token=${TOKEN}`)).statusCode).to.equal(404);
        expect((await get(port, `/../../etc/passwd?token=${TOKEN}`)).statusCode).to.equal(404);
        expect((await get(port, path, 'POST')).statusCode).to.equal(404);
    });

    it('sends images to the viewers', async () => {
        const response = await connect();
        const data = firstData(response);
        server.broadcast(Buffer.from('FRAME'));
        const text = await data;
        expect(text).to.contain('--blinklive');
        expect(text).to.contain('Content-Type: image/jpeg');
    });

    it('starts a late viewer with the last image', async () => {
        server.broadcast(Buffer.from('FRAME'));
        const response = await connect();
        let text = '';
        for await (const chunk of response) {
            text += (chunk as Buffer).toString('latin1');
            if (text.includes('FRAME')) {
                break;
            }
        }
        expect(text).to.contain('FRAME');
    });

    it('counts the viewers', async () => {
        const response = await connect();
        expect(counts).to.deep.equal([1]);
        const gone = new Promise(resolve => {
            const check = (): void => {
                if (counts.length > 1) {
                    resolve(undefined);
                } else {
                    setTimeout(check, 10);
                }
            };
            check();
        });
        response.destroy();
        await gone;
        expect(counts).to.deep.equal([1, 0]);
    });

    it('limits the number of viewers', async () => {
        for (let index = 0; index < LIVE_MAX_CLIENTS; index++) {
            expect((await connect()).statusCode).to.equal(200);
        }
        expect((await get(port, path)).statusCode).to.equal(503);
    });

    it('is gone after the session, and so is the token', async () => {
        await connect();
        await server.stop();
        let error: unknown;
        try {
            await get(port, path);
        } catch (err) {
            error = err;
        }
        expect(error).to.be.instanceOf(Error);
    });

    it('accepts a new token for the next session, not the old one', async () => {
        await server.stop();
        const next = 'c'.repeat(64);
        port = await server.start({ host: '127.0.0.1', port: 0 }, CAM, next);
        expect((await get(port, path)).statusCode).to.equal(401);
        const response = await get(port, `/live/${CAM}.mjpeg?token=${next}`);
        open.push(response);
        expect(response.statusCode).to.equal(200);
    });

    it('reports a port that is taken', async () => {
        const other = new LiveServer(() => undefined);
        let error: unknown;
        try {
            await other.start({ host: '127.0.0.1', port }, CAM, TOKEN);
        } catch (err) {
            error = err;
        }
        expect((error as { code?: string }).code).to.equal('EADDRINUSE');
    });
});
