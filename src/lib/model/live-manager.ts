/*
 * Live image of one camera at a time. The way of the data: Blink stream server (IMMI) -> ffmpeg -> MJPEG -> viewers.
 *
 * A live session keeps a battery camera awake, so it ends by itself: after the time limit and when nobody watches.
 * There is deliberately no fallback to repeated snapshots: each of them would wake the camera, and at about nine
 * seconds per image that is no live image.
 */

import { randomBytes } from 'node:crypto';
import { AbortedError, describeError } from '../api/errors';
import type { BlinkDevice } from '../api/homescreen';
import { ImmiClient, describeServer, isCertificateError, parseImmiServer, type ImmiSocket } from '../api/immi';
import { FrameSplitter } from '../util/mjpeg';
import { LiveServer, type ListenOptions } from './live-server';
import type { ObjectTree } from './tree';

/** Outcome of a live session */
export type LiveResult =
    | 'running'
    | 'ended'
    | 'idle'
    | 'failed'
    | 'certificate'
    | 'noFfmpeg'
    | 'offline'
    | 'unsupported'
    | 'disabled'
    | 'busy'
    | 'rejected';

/** Session ends if nobody watches for this long */
export const LIVE_IDLE_MS = 20_000;
/** Session ends if no image has come after this long */
export const LIVE_FIRST_FRAME_MS = 30_000;
/** Images per second */
export const LIVE_FPS = 10;
/** Width of the images */
export const LIVE_WIDTH = 1280;

/** Answer of Blink to the start of a session */
export interface LiveStart {
    /** Value of the field "server" */
    server: unknown;
    /** Stream token */
    token: string | undefined;
    /** Command ID, if Blink gave one */
    commandId: number | undefined;
}

/** The part of a process the manager needs */
export interface LiveProcess {
    /** Input */
    stdin: {
        write(data: Buffer): unknown;
        end(): unknown;
        on(event: 'error', listener: () => void): unknown;
    };
    /** Output */
    stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
    /** Messages */
    stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
    /** Registers an event handler */
    on(event: 'exit', listener: () => void): unknown;
    /** Registers an event handler */
    on(event: 'error', listener: (err: Error) => void): unknown;
    /** Ends the process */
    kill(): unknown;
}

/** What the manager needs from the adapter */
export interface LiveHost {
    /** Live image is switched on in the settings */
    enabled(): boolean;
    /** The adapter is connected to the Blink cloud */
    online(): boolean;
    /** Device of the last homescreen */
    device(cameraId: number): BlinkDevice | undefined;
    /** ffmpeg can be started */
    ffmpegAvailable(): Promise<boolean>;
    /** Starts ffmpeg, without a shell */
    spawnFfmpeg(args: string[]): LiveProcess;
    /** Asks Blink for a session */
    start(device: BlinkDevice, networkId: number): Promise<LiveStart>;
    /** Tells Blink that a session has ended */
    stop(networkId: number, commandId: number): Promise<void>;
    /** Opens a verified connection to a stream server */
    connect(host: string, port: number, ready: () => void): ImmiSocket;
    /** Who issued the certificate of a stream server, for the log. Sends nothing to the server */
    describeCertificate(host: string, port: number): Promise<string>;
    /** Starts a timer */
    setTimer(run: () => void, ms: number): unknown;
    /** Stops a timer */
    clearTimer(timer: unknown): void;
    /** Where the server of the live image listens */
    listen(): ListenOptions;
    /** Time limit of a session */
    maxMs(): number;
    /** Log message on level debug */
    debug(message: string): void;
    /** Log message on level info: start, first image and end of a session, so they are known without debug */
    info(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

/** What the caller gets for a running session */
export interface LiveAccess {
    /** Outcome */
    result: LiveResult;
    /** TCP port of the image */
    port?: number;
    /** Path of the image with the token of this session. Does not belong into states or the log */
    path?: string;
    /** End of the session at the latest */
    expiresAt?: number;
}

interface Session {
    cameraId: number;
    networkId: number;
    commandId: number | undefined;
    streamHost: string;
    streamPort: number;
    port: number;
    token: string;
    expiresAt: number;
    started: number;
    firstFrame: boolean;
    process: LiveProcess | undefined;
    immi: ImmiClient | undefined;
    limit: unknown;
    idle: unknown;
    noFrame: unknown;
}

/**
 * Arguments of ffmpeg: MPEG-TS from the input, single JPEG files to the output. No audio.
 *
 * @param maxSeconds - Time limit, as a second safeguard next to the timer of the adapter
 */
export function ffmpegArgs(maxSeconds: number): string[] {
    return [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
        // with the defaults ffmpeg collects about five seconds of video first, and that delay then stays
        '-probesize',
        '256k',
        '-analyzeduration',
        '500000',
        '-f',
        'mpegts',
        '-i',
        'pipe:0',
        '-t',
        String(maxSeconds),
        '-an',
        '-vf',
        `fps=${LIVE_FPS},scale=${LIVE_WIDTH}:-2`,
        '-c:v',
        'mjpeg',
        '-q:v',
        '7',
        '-f',
        'image2pipe',
        'pipe:1',
    ];
}

/** Runs the live session */
export class LiveManager {
    private session: Session | undefined;
    private starting = false;
    private readonly server: LiveServer;

    /**
     * @param host - Adapter functions
     * @param tree - Object tree
     */
    public constructor(
        private readonly host: LiveHost,
        private readonly tree: ObjectTree,
    ) {
        this.server = new LiveServer(count => this.onClients(count));
    }

    /**
     * Starts the live image of a camera, or gives access to the one that is running.
     *
     * @param cameraId - Camera ID
     */
    public async start(cameraId: number): Promise<LiveAccess> {
        const running = this.session;
        if (running?.cameraId === cameraId) {
            return this.access(running);
        }
        if (running || this.starting) {
            return this.refuse(cameraId, 'busy');
        }
        if (!this.host.enabled()) {
            return this.refuse(cameraId, 'disabled');
        }
        if (!this.host.online()) {
            return this.refuse(cameraId, 'rejected');
        }
        const device = this.host.device(cameraId);
        if (device?.networkId === undefined || !device.serial) {
            this.host.warn(`Camera ${cameraId}: Blink does not report this camera, its network or its serial number`);
            return this.refuse(cameraId, 'rejected');
        }
        if (device.status === 'offline') {
            return this.refuse(cameraId, 'offline');
        }

        this.starting = true;
        try {
            // checked first: without ffmpeg the camera must not be woken for nothing
            if (!(await this.host.ffmpegAvailable())) {
                this.host.warn('Live image: ffmpeg not found. Install it or set its path in the instance settings.');
                return await this.refuse(cameraId, 'noFfmpeg');
            }
            return await this.open(device, device.networkId, device.serial);
        } catch (err) {
            // first of all: the server must not stay open, also not if the adapter shuts down right now
            await this.server.stop();
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.warn(`Camera ${cameraId}: live image not started: ${describeError(err)}`);
            return await this.refuse(cameraId, 'failed');
        } finally {
            this.starting = false;
        }
    }

    /**
     * Ends the live image of a camera.
     *
     * @param cameraId - Camera ID
     */
    public async stop(cameraId: number): Promise<void> {
        if (this.session?.cameraId === cameraId) {
            await this.end('ended');
        }
    }

    /** The adapter shuts down: processes and connections end at once, Blink is not asked anymore */
    public shutdown(): void {
        const session = this.session;
        this.session = undefined;
        if (session) {
            this.release(session);
            void this.server.stop();
        }
    }

    private async refuse(cameraId: number, result: LiveResult): Promise<LiveAccess> {
        // emptied, so that the same result twice in a row is visible as a new result
        await this.tree.setValue(`cameras.${cameraId}.liveResult`, '');
        await this.tree.setValue(`cameras.${cameraId}.liveResult`, result);
        return { result };
    }

    private access(session: Session): LiveAccess {
        return {
            result: 'running',
            port: session.port,
            path: `/live/${session.cameraId}.mjpeg?token=${session.token}`,
            expiresAt: session.expiresAt,
        };
    }

    private async open(device: BlinkDevice, networkId: number, serial: string): Promise<LiveAccess> {
        const token = randomBytes(32).toString('hex');
        const port = await this.server.start(this.host.listen(), device.id, token);
        const start = await this.host.start(device, networkId);
        const immiServer = parseImmiServer(start.server);
        if (!immiServer || !start.token) {
            this.host.warn(
                `Camera ${device.id}: Blink offers no live image for this camera ` +
                    `(${describeServer(start.server)}, token ${start.token ? 'given' : 'missing'})`,
            );
            await this.server.stop();
            if (start.commandId !== undefined) {
                await this.tellBlink(networkId, start.commandId);
            }
            return this.refuse(device.id, 'unsupported');
        }

        const maxMs = this.host.maxMs();
        const now = Date.now();
        const session: Session = {
            cameraId: device.id,
            networkId,
            commandId: start.commandId,
            streamHost: immiServer.host,
            streamPort: immiServer.port,
            port,
            token,
            expiresAt: now + maxMs,
            started: now,
            firstFrame: false,
            process: undefined,
            immi: undefined,
            limit: undefined,
            idle: undefined,
            noFrame: undefined,
        };
        this.session = session;
        this.host.info(`Camera ${session.cameraId}: live image started, waiting for the first image`);

        const process = this.host.spawnFfmpeg(ffmpegArgs(Math.ceil(maxMs / 1000)));
        session.process = process;
        const splitter = new FrameSplitter();
        process.stdin.on('error', () => undefined);
        process.stdout.on('data', chunk => {
            for (const frame of splitter.push(chunk)) {
                this.onFrame(session, frame);
            }
        });
        process.stderr.on('data', chunk => this.host.debug(`ffmpeg: ${chunk.toString('utf8').trim()}`));
        process.on('error', err => {
            this.host.warn(`Live image: ffmpeg: ${describeError(err)}`);
            this.endSession(session, 'failed');
        });
        process.on('exit', () => this.endSession(session, 'ended'));

        const immi = new ImmiClient({
            server: immiServer,
            token: start.token,
            serial,
            connect: (host, tcpPort, ready) => this.host.connect(host, tcpPort, ready),
            onVideo: chunk => {
                process.stdin.write(chunk);
            },
            onClose: err => this.onImmiClose(session, err),
            setTimer: (run, ms) => this.host.setTimer(run, ms),
            clearTimer: timer => this.host.clearTimer(timer),
        });
        session.immi = immi;

        session.limit = this.host.setTimer(() => this.endSession(session, 'ended'), maxMs);
        session.idle = this.host.setTimer(() => this.endSession(session, 'idle'), LIVE_IDLE_MS);
        session.noFrame = this.host.setTimer(() => {
            this.host.warn(`Camera ${device.id}: no live image from Blink`);
            this.endSession(session, 'failed');
        }, LIVE_FIRST_FRAME_MS);

        await this.tree.setValue(`cameras.${device.id}.liveResult`, '');
        await this.tree.setValue(`cameras.${device.id}.liveResult`, 'running');
        await this.tree.setValue(`cameras.${device.id}.liveActive`, true);
        immi.open();
        return this.access(session);
    }

    private onFrame(session: Session, frame: Buffer): void {
        if (this.session !== session) {
            return;
        }
        if (!session.firstFrame) {
            session.firstFrame = true;
            this.host.clearTimer(session.noFrame);
            this.host.info(`Camera ${session.cameraId}: first live image after ${Date.now() - session.started} ms`);
        }
        this.server.broadcast(frame);
    }

    private onImmiClose(session: Session, err: Error | undefined): void {
        if (this.session !== session) {
            return;
        }
        if (isCertificateError(err)) {
            this.host.warn(
                `Camera ${session.cameraId}: the certificate of the Blink stream server was not accepted, ` +
                    `the stream token was not sent (${describeError(err)})`,
            );
            this.host
                .describeCertificate(session.streamHost, session.streamPort)
                .then(text => this.host.warn(`Camera ${session.cameraId}: certificate of the stream server: ${text}`))
                .catch((failure: unknown) => this.host.debug(`Certificate not readable: ${describeError(failure)}`));
            this.endSession(session, 'certificate');
            return;
        }
        if (err) {
            this.host.warn(`Camera ${session.cameraId}: live connection lost: ${describeError(err)}`);
        }
        this.endSession(session, err ? 'failed' : 'ended');
    }

    private onClients(count: number): void {
        const session = this.session;
        if (!session) {
            return;
        }
        this.host.clearTimer(session.idle);
        session.idle = count > 0 ? undefined : this.host.setTimer(() => this.endSession(session, 'idle'), LIVE_IDLE_MS);
    }

    private endSession(session: Session, result: LiveResult): void {
        if (this.session === session) {
            this.end(result).catch((err: unknown) => this.host.debug(`Live image not ended: ${describeError(err)}`));
        }
    }

    private release(session: Session): void {
        this.host.clearTimer(session.limit);
        this.host.clearTimer(session.idle);
        this.host.clearTimer(session.noFrame);
        session.immi?.close();
        session.process?.stdin.end();
        session.process?.kill();
    }

    private async end(result: LiveResult): Promise<void> {
        const session = this.session;
        if (!session) {
            return;
        }
        this.session = undefined;
        this.release(session);
        await this.server.stop();
        await this.tree.setValue(`cameras.${session.cameraId}.liveActive`, false);
        await this.tree.setValue(`cameras.${session.cameraId}.liveResult`, result);
        this.host.info(
            `Camera ${session.cameraId}: live image ended after ${Date.now() - session.started} ms: ${result}`,
        );
        if (session.commandId !== undefined) {
            await this.tellBlink(session.networkId, session.commandId);
        }
    }

    private async tellBlink(networkId: number, commandId: number): Promise<void> {
        try {
            await this.host.stop(networkId, commandId);
        } catch (err) {
            if (!(err instanceof AbortedError)) {
                this.host.debug(`Blink not told about the end of the live image: ${describeError(err)}`);
            }
        }
    }
}
