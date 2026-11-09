import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { request, type IncomingMessage } from 'node:http';
import { AbortedError, ApiError } from '../api/errors';
import type { BlinkDevice } from '../api/homescreen';
import { buildMessage } from '../api/immi';
import {
    LIVE_FIRST_FRAME_MS,
    LIVE_IDLE_MS,
    LiveManager,
    ffmpegArgs,
    type LiveHost,
    type LiveStart,
} from './live-manager';
import { ObjectTree } from './tree';

const CAM = 5;
const ACTIVE = `cameras.${CAM}.liveActive`;
const RESULT = `cameras.${CAM}.liveResult`;
const SERVER = 'immis://stream-test.immedia-semi.com:443/TX__IMDS?client_id=250';
const JPEG = Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]);

function device(overrides: Partial<BlinkDevice> = {}): BlinkDevice {
    return {
        id: CAM,
        kind: 'camera',
        name: 'Test',
        type: undefined,
        networkId: 1,
        serial: 'SERIAL',
        status: 'done',
        enabled: true,
        batteryLow: false,
        batteryLevel: 3,
        batteryVoltage: undefined,
        temperature: undefined,
        wifi: undefined,
        lfr: undefined,
        thumbnail: undefined,
        ...overrides,
    };
}

class FakeSocket extends EventEmitter {
    public written: Buffer[] = [];
    public destroyed = false;

    public write(data: Buffer): void {
        this.written.push(data);
    }

    public destroy(): void {
        this.destroyed = true;
        this.emit('close');
    }
}

class FakeProcess extends EventEmitter {
    public stdinData: Buffer[] = [];
    public killed = false;
    public stdinEnded = false;
    public stdout = new EventEmitter();
    public stderr = new EventEmitter();
    public stdin = {
        write: (data: Buffer): void => {
            this.stdinData.push(data);
        },
        end: (): void => {
            this.stdinEnded = true;
        },
        on: (): void => undefined,
    };

    public kill(): void {
        this.killed = true;
    }
}

interface Script {
    enabled?: boolean;
    online?: boolean;
    ffmpeg?: boolean;
    device?: BlinkDevice | undefined;
    start?: LiveStart | Error;
    connectThrows?: Error;
}

interface Timer {
    run: () => void;
    ms: number;
    active: boolean;
}

function setup(script: Script = {}): {
    manager: LiveManager;
    writes: [string, ioBroker.StateValue][];
    starts: number[];
    stops: number[];
    sockets: FakeSocket[];
    processes: FakeProcess[];
    spawned: string[][];
    timers: Timer[];
    messages: string[];
    ready: () => void;
} {
    const writes: [string, ioBroker.StateValue][] = [];
    const starts: number[] = [];
    const stops: number[] = [];
    const sockets: FakeSocket[] = [];
    const processes: FakeProcess[] = [];
    const spawned: string[][] = [];
    const timers: Timer[] = [];
    const messages: string[] = [];
    const result = { ready: (): void => undefined };
    const tree = new ObjectTree({
        writeObject: () => Promise.resolve(),
        writeState: (id, value) => {
            writes.push([id, value]);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve([]),
        info: () => undefined,
    });
    const host: LiveHost = {
        enabled: () => script.enabled ?? true,
        online: () => script.online ?? true,
        device: () => ('device' in script ? script.device : device()),
        ffmpegAvailable: () => Promise.resolve(script.ffmpeg ?? true),
        spawnFfmpeg: args => {
            spawned.push(args);
            const process = new FakeProcess();
            processes.push(process);
            return process;
        },
        start: item => {
            starts.push(item.id);
            const answer = script.start ?? { server: SERVER, token: 'STREAM-TOKEN', commandId: 77 };
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
        stop: (_network, command) => {
            stops.push(command);
            return Promise.resolve();
        },
        connect: (_host, _port, ready) => {
            if (script.connectThrows) {
                throw script.connectThrows;
            }
            result.ready = ready;
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        setTimer: (run, ms) => {
            const timer: Timer = { run, ms, active: true };
            timers.push(timer);
            return timer;
        },
        clearTimer: timer => {
            if (timer) {
                (timer as Timer).active = false;
            }
        },
        listen: () => ({ host: '127.0.0.1', port: 0 }),
        maxMs: () => 120_000,
        debug: message => messages.push(message),
        warn: message => messages.push(message),
    };
    return {
        manager: new LiveManager(host, tree),
        writes,
        starts,
        stops,
        sockets,
        processes,
        spawned,
        timers,
        messages,
        get ready() {
            return result.ready;
        },
    };
}

function last(writes: [string, ioBroker.StateValue][], id: string): ioBroker.StateValue | undefined {
    return writes.filter(([key]) => key === id).pop()?.[1];
}

function viewer(port: number, path: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const call = request({ host: '127.0.0.1', port, path, agent: false }, resolve);
        call.on('error', reject);
        call.end();
    });
}

/** Lets the steps after a finished promise run */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function runTimer(timers: Timer[], ms: number): void {
    const timer = timers.filter(item => item.active && item.ms === ms).pop();
    expect(timer, `active timer of ${ms} ms`).to.not.equal(undefined);
    timer?.run();
}

describe('model/live-manager ffmpegArgs', () => {
    it('reads from the input, writes images to the output, has a time limit and no audio', () => {
        const args = ffmpegArgs(120);
        expect(args).to.include.members(['pipe:0', 'pipe:1', '-an']);
        expect(args[args.indexOf('-t') + 1]).to.equal('120');
        expect(args[args.indexOf('-f', args.indexOf('-c:v')) + 1]).to.equal('image2pipe');
    });
});

describe('model/live-manager', () => {
    let current: LiveManager | undefined;

    const use = (script: Script = {}): ReturnType<typeof setup> => {
        const context = setup(script);
        current = context.manager;
        return context;
    };

    afterEach(() => {
        current?.shutdown();
        current = undefined;
    });

    it('starts: asks Blink, gives access with a token, states follow', async () => {
        const { manager, writes, starts, spawned } = use();
        const access = await manager.start(CAM);

        expect(access.result).to.equal('running');
        expect(access.port).to.be.greaterThan(0);
        expect(access.path).to.match(new RegExp(`^/live/${CAM}\\.mjpeg\\?token=[0-9a-f]{64}$`));
        expect(access.expiresAt).to.be.greaterThan(Date.now());
        expect(starts).to.deep.equal([CAM]);
        expect(spawned).to.have.lengthOf(1);
        expect(last(writes, ACTIVE)).to.equal(true);
        expect(last(writes, RESULT)).to.equal('running');
    });

    it('keeps the token out of states and log', async () => {
        const { manager, writes, messages } = use();
        const access = await manager.start(CAM);
        const token = access.path?.split('token=')[1] ?? 'missing';
        await manager.stop(CAM);
        const dump = JSON.stringify([writes, messages]);
        expect(dump).to.not.contain(token);
        expect(dump).to.not.contain('STREAM-TOKEN');
    });

    it('is switched off by default: no wake-up', async () => {
        const { manager, writes, starts } = use({ enabled: false });
        expect((await manager.start(CAM)).result).to.equal('disabled');
        expect(starts).to.deep.equal([]);
        expect(last(writes, RESULT)).to.equal('disabled');
    });

    it('does not wake a camera without ffmpeg', async () => {
        const { manager, starts, spawned } = use({ ffmpeg: false });
        expect((await manager.start(CAM)).result).to.equal('noFfmpeg');
        expect(starts).to.deep.equal([]);
        expect(spawned).to.deep.equal([]);
    });

    it('does not wake an offline camera', async () => {
        const { manager, starts } = use({ device: device({ status: 'offline' }) });
        expect((await manager.start(CAM)).result).to.equal('offline');
        expect(starts).to.deep.equal([]);
    });

    it('refuses while not connected, and without camera, network or serial number', async () => {
        expect((await use({ online: false }).manager.start(CAM)).result).to.equal('rejected');
        expect((await use({ device: undefined }).manager.start(CAM)).result).to.equal('rejected');
        expect((await use({ device: device({ networkId: undefined }) }).manager.start(CAM)).result).to.equal(
            'rejected',
        );
        expect((await use({ device: device({ serial: undefined }) }).manager.start(CAM)).result).to.equal('rejected');
    });

    it('reports a camera without a live image and tells Blink', async () => {
        const { manager, stops, spawned } = use({ start: { server: 'rtsps://x', token: 'T', commandId: 8 } });
        expect((await manager.start(CAM)).result).to.equal('unsupported');
        expect(spawned).to.deep.equal([]);
        expect(stops).to.deep.equal([8]);
    });

    it('never connects to a host outside of Blink', async () => {
        const server = 'immis://evil.example/TX__IMDS?client_id=250';
        const { manager, sockets } = use({ start: { server, token: 'T', commandId: 8 } });
        expect((await manager.start(CAM)).result).to.equal('unsupported');
        expect(sockets).to.deep.equal([]);
    });

    it('reports an answer without a token as unsupported', async () => {
        const { manager } = use({ start: { server: SERVER, token: undefined, commandId: undefined } });
        expect((await manager.start(CAM)).result).to.equal('unsupported');
    });

    it('reports errors of Blink and can start again', async () => {
        const failed = use({ start: new ApiError('Asking Blink for a live image', 500) });
        expect((await failed.manager.start(CAM)).result).to.equal('failed');
        expect(last(failed.writes, ACTIVE)).to.not.equal(true);
        expect((await failed.manager.start(CAM)).result).to.equal('failed');
    });

    it('passes on a shutdown', async () => {
        const { manager } = use({ start: new AbortedError() });
        let error: unknown;
        try {
            await manager.start(CAM);
        } catch (err) {
            error = err;
        }
        expect(error).to.be.instanceOf(AbortedError);
    });

    it('gives a second viewer the running session, without waking the camera again', async () => {
        const { manager, starts } = use();
        const first = await manager.start(CAM);
        const second = await manager.start(CAM);
        expect(second).to.deep.equal(first);
        expect(starts).to.have.lengthOf(1);
    });

    it('runs one session at a time', async () => {
        const { manager, starts } = use();
        await manager.start(CAM);
        expect((await manager.start(6)).result).to.equal('busy');
        expect(starts).to.have.lengthOf(1);
    });

    it('uses a new token for each session', async () => {
        const { manager } = use();
        const first = await manager.start(CAM);
        await manager.stop(CAM);
        const second = await manager.start(CAM);
        expect(second.path).to.not.equal(first.path);
    });

    it('sends the stream token only after the connection is verified', async () => {
        const context = use();
        await context.manager.start(CAM);
        expect(context.sockets[0].written).to.deep.equal([]);
        context.ready();
        expect(Buffer.concat(context.sockets[0].written).toString('latin1')).to.contain('STREAM-TOKEN');
    });

    it('moves the video through ffmpeg to the viewer', async () => {
        const context = use();
        const access = await context.manager.start(CAM);
        const response = await viewer(access.port!, access.path!);
        context.sockets[0].emit('data', buildMessage(0x00, 1, Buffer.from('TS')));
        expect(context.processes[0].stdinData[0].toString()).to.equal('TS');

        const received = new Promise<string>(resolve => {
            let text = '';
            response.on('data', (chunk: Buffer) => {
                text += chunk.toString('latin1');
                if (text.includes('A')) {
                    resolve(text);
                }
            });
        });
        context.processes[0].stdout.emit('data', JPEG);
        expect(await received).to.contain('image/jpeg');
        response.destroy();
    });

    describe('end of a session', () => {
        const expectEnded = async (context: ReturnType<typeof setup>, result: string): Promise<void> => {
            await settle();
            expect(last(context.writes, RESULT)).to.equal(result);
            expect(last(context.writes, ACTIVE)).to.equal(false);
            expect(context.processes[0].killed, 'ffmpeg ended').to.equal(true);
            expect(context.sockets[0].destroyed, 'connection closed').to.equal(true);
            expect(
                context.timers.filter(timer => timer.active && timer.ms !== 10_000),
                'timers',
            ).to.deep.equal([]);
            expect(context.stops).to.deep.equal([77]);
        };

        it('ends on request', async () => {
            const context = use();
            await context.manager.start(CAM);
            await context.manager.stop(CAM);
            await expectEnded(context, 'ended');
        });

        it('ignores a stop for another camera', async () => {
            const context = use();
            await context.manager.start(CAM);
            await context.manager.stop(6);
            expect(context.processes[0].killed).to.equal(false);
        });

        it('ends at the time limit', async () => {
            const context = use();
            await context.manager.start(CAM);
            runTimer(context.timers, 120_000);
            await expectEnded(context, 'ended');
        });

        it('ends if nobody ever watches', async () => {
            const context = use();
            await context.manager.start(CAM);
            runTimer(context.timers, LIVE_IDLE_MS);
            await expectEnded(context, 'idle');
        });

        it('keeps running while somebody watches, ends after the last viewer', async () => {
            const context = use();
            const access = await context.manager.start(CAM);
            const response = await viewer(access.port!, access.path!);
            await settle();
            expect(context.timers.filter(timer => timer.active && timer.ms === LIVE_IDLE_MS)).to.deep.equal([]);

            response.destroy();
            await new Promise(resolve => setTimeout(resolve, 50));
            runTimer(context.timers, LIVE_IDLE_MS);
            await expectEnded(context, 'idle');
        });

        it('ends if no image comes', async () => {
            const context = use();
            await context.manager.start(CAM);
            runTimer(context.timers, LIVE_FIRST_FRAME_MS);
            await expectEnded(context, 'failed');
        });

        it('stops waiting for the first image when it comes', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.processes[0].stdout.emit('data', JPEG);
            expect(context.timers.filter(timer => timer.active && timer.ms === LIVE_FIRST_FRAME_MS)).to.deep.equal([]);
        });

        it('ends when ffmpeg ends', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.processes[0].emit('exit');
            await expectEnded(context, 'ended');
        });

        it('ends if ffmpeg cannot start', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.processes[0].emit('error', new Error('spawn failed'));
            await expectEnded(context, 'failed');
        });

        it('ends when Blink closes the connection', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.sockets[0].destroy();
            await expectEnded(context, 'ended');
        });

        it('ends on a connection error', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.sockets[0].emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
            context.sockets[0].destroy();
            await expectEnded(context, 'failed');
        });

        it('reports a refused certificate, and the token was never sent', async () => {
            const context = use();
            await context.manager.start(CAM);
            const failure = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
            context.sockets[0].emit('error', failure);
            context.sockets[0].destroy();
            await expectEnded(context, 'certificate');
            expect(context.sockets[0].written).to.deep.equal([]);
            expect(context.messages.join()).to.contain('certificate');
        });

        it('closes the image for its viewers', async () => {
            const context = use();
            const access = await context.manager.start(CAM);
            await context.manager.stop(CAM);
            let error: unknown;
            try {
                await viewer(access.port!, access.path!);
            } catch (err) {
                error = err;
            }
            expect(error).to.be.instanceOf(Error);
        });

        it('ends at once when the adapter shuts down, without asking Blink', async () => {
            const context = use();
            await context.manager.start(CAM);
            context.manager.shutdown();
            await settle();
            expect(context.processes[0].killed).to.equal(true);
            expect(context.sockets[0].destroyed).to.equal(true);
            expect(context.stops).to.deep.equal([]);
            expect(context.timers.filter(timer => timer.active && timer.ms !== 10_000)).to.deep.equal([]);
        });

        it('can start again afterwards', async () => {
            const context = use();
            await context.manager.start(CAM);
            await context.manager.stop(CAM);
            expect((await context.manager.start(CAM)).result).to.equal('running');
            expect(context.starts).to.have.lengthOf(2);
        });
    });
});
