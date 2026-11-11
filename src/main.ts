/*
 * ioBroker.blink
 * Adapter lifecycle only - Blink API in lib/api, object tree in lib/model, helpers in lib/util.
 *
 * Phase 6: login with 2FA, encrypted session, token refresh, backoff, polling, arm/disarm with readback, snapshots,
 * live image.
 */

import * as utils from '@iobroker/adapter-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
    AbortedError,
    ApiError,
    CredentialsRejectedError,
    RateLimitedError,
    SessionExpiredError,
    TwoFactorRejectedError,
    describeError,
} from './lib/api/errors';
import { HttpClient } from './lib/api/http';
import type { BlinkDevice, Homescreen } from './lib/api/homescreen';
import { pinnedCertificateError, type ImmiSocket } from './lib/api/immi';
import { describeMediaPage, parseMediaPage } from './lib/api/media';
import { STREAM_CERT_PEM } from './lib/api/stream-certificate';
import { OAuthFlow, newHardwareId } from './lib/api/oauth';
import { RestClient } from './lib/api/rest';
import type { Session, TokenSet } from './lib/api/types';
import {
    decodePending,
    decodeSession,
    encodePending,
    encodeSession,
    type SecretCodec,
} from './lib/model/session-store';
import { ArmQueue, MOTION_SWITCH } from './lib/model/arm-queue';
import { ArmSelection, CONTROL_IDS, SELECTION_KEY } from './lib/model/arm-selection';
import { BATTERY_STATE, BatteryWarner, batteryTestText } from './lib/model/battery-warner';
import { ClipStore } from './lib/model/clip-store';
import { ImageStore } from './lib/model/image-store';
import { LiveManager } from './lib/model/live-manager';
import { MotionTracker } from './lib/model/motion';
import { SnapshotQueue } from './lib/model/snapshot-queue';
import { ObjectTree } from './lib/model/tree';
import {
    TEST_ORIGIN_ENV,
    ffmpegCommand,
    imageRetentionHours,
    liveBindAddress,
    liveMaxSeconds,
    livePort,
    normalizeEmail,
    normalizePin,
    notifyInstance,
    notifyUsers,
    pollDelayMs,
    pollIntervalSeconds,
    testOrigin,
} from './lib/util/config';

/** First retry after a failed login, doubled up to RETRY_MAX_S (audit B.11.4) */
const RETRY_START_S = 60;
const RETRY_MAX_S = 1800;
/** Longest wait for the messenger instance to answer */
const NOTIFY_TIMEOUT_MS = 15_000;
/** Random start delay, so many instances restarting together do not hit the cloud at once (audit B.11.1) */
const START_JITTER_MS = 2_000;
/** The access token is renewed this long before it expires */
const REFRESH_MARGIN_MS = 5 * 60_000;

type LoginState =
    | 'ok'
    | 'connecting'
    | 'twoFactorRequired'
    | 'twoFactorRejected'
    | 'credentialsRejected'
    | 'rateLimited'
    | 'error'
    | 'noConfig';

class Blink extends utils.Adapter {
    private readonly abort = new AbortController();
    private oauth: OAuthFlow | undefined;
    private rest: RestClient | undefined;
    private tree: ObjectTree | undefined;
    private arm: ArmQueue | undefined;
    private motion: ArmQueue | undefined;
    private selection: ArmSelection | undefined;
    private images: ImageStore | undefined;
    private clips: ClipStore | undefined;
    private battery: BatteryWarner | undefined;
    private snapshots: SnapshotQueue | undefined;
    private live: LiveManager | undefined;
    private homescreen: Homescreen | undefined;
    private motionClips: MotionTracker | undefined;
    /** The last motion poll failed (warn once, then debug until it works again) */
    private motionFailing = false;
    /** Requests of the cloud run one after the other, see exclusive() */
    private lane: Promise<unknown> = Promise.resolve();
    private session: Session | undefined;
    private timer: ioBroker.Timeout | undefined;
    private retrySeconds = RETRY_START_S;
    private email = '';
    private pollSeconds = 0;
    private connecting = false;
    private cloudConnected = false;
    private expiredRetried = false;
    private loginState: LoginState | undefined;
    private readonly codec: SecretCodec = {
        encrypt: value => this.encrypt(value),
        decrypt: value => this.decrypt(value),
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'blink',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const email = normalizeEmail(this.config.email);
        if (!email || !this.config.password) {
            await this.setLoginState('noConfig');
            this.log.error(
                'Please enter the e-mail address and password of your Blink account in the instance settings.',
            );
            return;
        }
        this.email = email;
        this.pollSeconds = pollIntervalSeconds(this.config.pollInterval);
        // created here, as instanceObjects of io-package.json do not reach an instance that already exists
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: { name: 'Images of the cameras', type: 'meta.user' },
            native: {},
        });
        await this.createControlObjects();
        await this.removeSerialStates();
        if (this.config.batteryWarning) {
            await this.setObjectNotExistsAsync(BATTERY_STATE, {
                type: 'state',
                common: {
                    name: 'Battery warnings sent (internal)',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false,
                },
                native: {},
            });
            const instance = this.config.notifyInstance;
            const users = this.config.notifyUsers;
            this.battery = new BatteryWarner(
                {
                    send: text => this.notify(text, instance, users),
                    read: async () => (await this.getStateAsync(BATTERY_STATE))?.val,
                    write: value => this.setState(BATTERY_STATE, value, true),
                    debug: message => this.log.debug(message),
                    info: message => this.log.info(message),
                    warn: message => this.log.warn(message),
                },
                await this.german(),
            );
        }

        const origin = testOrigin(process.env[TEST_ORIGIN_ENV]);
        if (origin) {
            this.log.warn(`Test mode: all requests go to ${origin}`);
        }
        const http = new HttpClient({
            testOrigin: origin,
            signal: this.abort.signal,
            trace: line => this.log.debug(line),
        });
        this.oauth = new OAuthFlow(http);
        this.rest = new RestClient(http);
        this.tree = new ObjectTree({
            writeObject: (id, object) => this.extendObject(id, object),
            writeState: (id, value) => this.setState(id, value, true),
            listDevices: async () => {
                const prefix = `${this.namespace}.`;
                const view = await this.getObjectViewAsync('system', 'device', {
                    startkey: prefix,
                    endkey: `${prefix}香`,
                });
                return view.rows.map(row => row.id.slice(prefix.length));
            },
            info: message => this.log.info(message),
        });
        this.arm = new ArmQueue(
            {
                online: () => this.cloudConnected,
                send: (networkId, armed) =>
                    this.exclusive(() => this.authorized(session => this.rest!.setArmed(session, networkId, armed))),
                commandStatus: (networkId, commandId) =>
                    this.exclusive(() =>
                        this.authorized(session => this.rest!.commandStatus(session, networkId, commandId)),
                    ),
                read: async networkId => {
                    const homescreen = await this.exclusive(() => this.readCloud());
                    return homescreen.networks.find(network => network.id === networkId)?.armed;
                },
                wait: ms => this.delay(ms),
                info: message => this.log.info(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
        );
        const deviceOf = (cameraId: number): BlinkDevice & { networkId: number } => {
            const device = this.homescreen?.devices.find(item => item.id === cameraId);
            if (device?.networkId === undefined) {
                throw new Error('Blink does not report this camera or its network');
            }
            return { ...device, networkId: device.networkId };
        };
        this.motion = new ArmQueue(
            {
                online: () => this.cloudConnected,
                send: (cameraId, enabled) => {
                    const device = deviceOf(cameraId);
                    return this.exclusive(() =>
                        this.authorized(session =>
                            this.rest!.setMotion(session, device.networkId, device.kind, device.id, enabled),
                        ),
                    );
                },
                commandStatus: (cameraId, commandId) => {
                    const { networkId } = deviceOf(cameraId);
                    return this.exclusive(() =>
                        this.authorized(session => this.rest!.commandStatus(session, networkId, commandId)),
                    );
                },
                read: async cameraId => {
                    const homescreen = await this.exclusive(() => this.readCloud());
                    return homescreen.devices.find(device => device.id === cameraId)?.enabled;
                },
                wait: ms => this.delay(ms),
                info: message => this.log.info(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
            MOTION_SWITCH,
        );
        this.selection = new ArmSelection({
            readStored: async () => {
                const stored = new Map<number, ioBroker.StateValue>();
                const states = await this.getStatesAsync(`networks.*.${SELECTION_KEY}`);
                for (const [id, state] of Object.entries(states ?? {})) {
                    const match = id.match(/\.networks\.(\d+)\.armWithAll$/);
                    if (match && state) {
                        stored.set(Number(match[1]), state.val);
                    }
                }
                return stored;
            },
            write: (networkId, value) => this.setState(`networks.${networkId}.${SELECTION_KEY}`, value, true),
            request: (networkId, armed) => this.arm!.request(networkId, armed),
            info: message => this.log.info(message),
        });
        const download = (thumbnail: string): Promise<Buffer> =>
            this.exclusive(() => this.authorized(session => this.rest!.downloadImage(session, thumbnail)));
        this.motionClips = new MotionTracker({
            read: async (since, page) => {
                const body = await this.exclusive(() =>
                    this.authorized(session => this.rest!.mediaChanged(session, since, page)),
                );
                const parsed = parseMediaPage(body);
                if (!parsed) {
                    this.log.debug(`Media list: ${describeMediaPage(body)}`);
                    throw new ApiError('Reading the Blink media list (unexpected answer)', 200);
                }
                return parsed;
            },
            readTimes: async () => {
                const times = new Map<number, number>();
                const states = await this.getStatesAsync('cameras.*.motionTime');
                for (const [id, state] of Object.entries(states ?? {})) {
                    const match = id.match(/\.cameras\.(\d+)\.motionTime$/);
                    if (match && typeof state?.val === 'number' && state.val > 0) {
                        times.set(Number(match[1]), state.val);
                    }
                }
                return times;
            },
            devices: () => new Set(this.homescreen?.devices.map(device => device.id)),
            write: (deviceId, key, value) => this.tree!.setValue(`cameras.${deviceId}.${key}`, value),
            newClip: (deviceId, clip) => {
                this.clips?.want(deviceId, clip);
                return Promise.resolve();
            },
            deletedClips: clipIds => this.clips?.deleted(clipIds) ?? Promise.resolve(),
            debug: message => this.log.debug(message),
        });
        this.clips = new ClipStore(
            {
                download: media =>
                    this.exclusive(() => this.authorized(session => this.rest!.downloadClip(session, media))),
                writeFile: (name, data) => this.writeFileAsync(this.namespace, name, data),
                deleteFile: name => this.delFileAsync(this.namespace, name),
                readInfos: async () => {
                    const infos = new Map<number, unknown>();
                    const states = await this.getStatesAsync('cameras.*.clipInfo');
                    for (const [id, state] of Object.entries(states ?? {})) {
                        const match = id.match(/\.cameras\.(\d+)\.clipInfo$/);
                        if (match) {
                            infos.set(Number(match[1]), state?.val);
                        }
                    }
                    return infos;
                },
                urlOf: name => `/${this.namespace}/${name}`,
                debug: message => this.log.debug(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
            imageRetentionHours(this.config.imageRetentionHours) * 3_600_000,
        );
        this.images = new ImageStore(
            {
                download,
                writeFile: (name, data) => this.writeFileAsync(this.namespace, name, data),
                deleteFile: name => this.delFileAsync(this.namespace, name),
                readInfos: async () => {
                    const infos = new Map<number, unknown>();
                    const states = await this.getStatesAsync('cameras.*.imageInfo');
                    for (const [id, state] of Object.entries(states ?? {})) {
                        const match = id.match(/\.cameras\.(\d+)\.imageInfo$/);
                        if (match) {
                            infos.set(Number(match[1]), state?.val);
                        }
                    }
                    return infos;
                },
                urlOf: name => `/${this.namespace}/${name}`,
                debug: message => this.log.debug(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
            imageRetentionHours(this.config.imageRetentionHours) * 3_600_000,
        );
        this.snapshots = new SnapshotQueue(
            {
                online: () => this.cloudConnected,
                device: cameraId => this.homescreen?.devices.find(device => device.id === cameraId),
                read: () => this.exclusive(() => this.readCloud()),
                trigger: (device, networkId) =>
                    this.exclusive(() =>
                        this.authorized(session => this.rest!.snapshot(session, networkId, device.kind, device.id)),
                    ),
                commandStatus: (networkId, commandId) =>
                    this.exclusive(() =>
                        this.authorized(session => this.rest!.commandStatus(session, networkId, commandId)),
                    ),
                download,
                wait: ms => this.delay(ms),
                debug: message => this.log.debug(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
            this.images,
        );
        const ffmpeg = ffmpegCommand(this.config.ffmpegPath);
        this.live = new LiveManager(
            {
                enabled: () => this.config.liveEnabled === true,
                online: () => this.cloudConnected,
                device: cameraId => this.homescreen?.devices.find(device => device.id === cameraId),
                ffmpegAvailable: () => this.ffmpegAvailable(ffmpeg),
                spawnFfmpeg: args =>
                    spawn(ffmpeg ?? 'ffmpeg', args, {
                        shell: false,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true,
                    }),
                start: (device, networkId) =>
                    this.exclusive(() =>
                        this.authorized(session => this.rest!.startLive(session, networkId, device.kind, device.id)),
                    ),
                stop: (networkId, commandId) =>
                    this.exclusive(() =>
                        this.authorized(session => this.rest!.stopLive(session, networkId, commandId)),
                    ),
                connect: (host, port, ready) => this.connectStream(origin, host, port, ready),
                describeCertificate: (host, port) => this.describeCertificate(origin, host, port),
                setTimer: (run, ms) => this.setTimeout(run, ms),
                clearTimer: timer => this.clearTimeout(timer as ioBroker.Timeout),
                listen: () => ({ host: liveBindAddress(this.config.liveBind), port: livePort(this.config.livePort) }),
                maxMs: () => liveMaxSeconds(this.config.liveMaxSeconds) * 1000,
                debug: message => this.log.debug(message),
                info: message => this.log.info(message),
                warn: message => this.log.warn(message),
            },
            this.tree,
        );
        await this.subscribeStatesAsync('cameras.*.snapshot');
        await this.subscribeStatesAsync('networks.*.armed');
        await this.subscribeStatesAsync('cameras.*.enabled');
        await this.subscribeStatesAsync(`networks.*.${SELECTION_KEY}`);
        await this.subscribeStatesAsync('control.*');
        await this.setLoginState('connecting');
        this.schedule(Math.floor(Math.random() * START_JITTER_MS), () => this.connect());
    }

    /**
     * Runs a single chained timer - retry and polling (which includes the token refresh) never overlap
     * (audit B.11.2). The next run is only planned when the current one has finished.
     *
     * @param ms - Delay
     * @param task - Task to run
     */
    private schedule(ms: number, task: () => Promise<void>): void {
        this.clearTimeout(this.timer);
        if (this.abort.signal.aborted) {
            return;
        }
        this.timer = this.setTimeout(() => {
            this.timer = undefined;
            task().catch((err: unknown) => {
                if (!this.abort.signal.aborted) {
                    this.log.error(`Unexpected error: ${describeError(err)}`);
                }
            });
        }, ms);
    }

    /** Restores the session or logs in. */
    private async connect(): Promise<void> {
        if (this.connecting || !this.oauth) {
            return;
        }
        this.connecting = true;
        try {
            const retryAt = Number((await this.getStateAsync('auth.retryAt'))?.val) || 0;
            if (retryAt > Date.now()) {
                await this.setLoginState('rateLimited');
                this.log.warn(`Blink rate limit active, next login attempt at ${new Date(retryAt).toLocaleString()}`);
                this.schedule(retryAt - Date.now(), () => this.connect());
                return;
            }

            this.session = decodeSession((await this.getStateAsync('auth.session'))?.val, this.codec);
            if (this.session) {
                await this.online();
                return;
            }
            await this.login();
        } catch (err) {
            await this.handleFailure(err);
        } finally {
            this.connecting = false;
        }
    }

    /** Full login, resumes a pending 2FA login when a code is configured. */
    private async login(): Promise<void> {
        const oauth = this.oauth!;
        const started = Date.now();
        const pin = normalizePin(this.config.pin);
        const pending = decodePending((await this.getStateAsync('auth.pending'))?.val, this.codec);
        const hardwareId = await this.hardwareId(pending?.hardwareId);

        let tokens: TokenSet;
        if (pending && pin) {
            this.log.info('Sending the 2FA code to Blink');
            tokens = await oauth.verifyTwoFactor(pending, pin);
        } else if (pending) {
            // a code was already sent - a new login would only trigger another SMS
            await this.setLoginState('twoFactorRequired');
            this.log.warn(
                'Blink is waiting for the 2FA code. Enter it in the instance settings (2FA code) and save, ' +
                    'or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).',
            );
            return;
        } else {
            this.log.info('Logging in to Blink');
            const result = await oauth.start(this.email, this.config.password, hardwareId);
            if (result.kind === 'twoFactor') {
                if (pin) {
                    tokens = await oauth.verifyTwoFactor(result.pending, pin);
                } else {
                    await this.setState('auth.pending', encodePending(result.pending, this.codec), true);
                    await this.setLoginState('twoFactorRequired');
                    const { channel, destination } = result.challenge;
                    const via = [channel, destination].filter(Boolean).join(' to ');
                    this.log.warn(
                        `Blink sent a 2FA code${via ? ` (${via})` : ''}. Enter it within 10 minutes in the instance ` +
                            'settings (2FA code) and save, or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).',
                    );
                    return;
                }
            } else {
                tokens = result.tokens;
            }
        }
        await this.completeLogin(tokens, hardwareId, !!pin);
        this.log.debug(`Login took ${Date.now() - started} ms`);
    }

    /**
     * Stores the new session and goes online - or restarts once to remove the used 2FA code from the settings.
     *
     * @param tokens - New tokens
     * @param hardwareId - Hardware ID of the login
     * @param removePin - The 2FA code from the settings was used
     */
    private async completeLogin(tokens: TokenSet, hardwareId: string, removePin: boolean): Promise<void> {
        const account = await this.oauth!.account(tokens.accessToken);
        this.session = { ...tokens, hardwareId, ...account };
        await this.saveSession();
        await this.setState('auth.pending', '', true);
        await this.setState('auth.retryAt', 0, true);
        this.log.info('Logged in to Blink');
        if (removePin && this.config.pin) {
            this.log.info('Removing the used 2FA code from the settings - the adapter restarts once');
            await this.updateConfig({ pin: '' });
            return;
        }
        await this.online();
    }

    /**
     * Renews the access token when it expires soon.
     *
     * @param force - Renew in any case (Blink has rejected the token)
     */
    private async ensureFresh(force = false): Promise<void> {
        const session = this.session;
        if (!session || (!force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS)) {
            return;
        }
        if (!session.refreshToken) {
            throw new SessionExpiredError('no refresh token');
        }
        const tokens = await this.oauth!.refresh(session.refreshToken, session.hardwareId);
        this.session = { ...session, ...tokens };
        await this.saveSession();
        this.log.debug('Access token renewed');
    }

    /** Logged in: start polling. The first successful poll sets info.connection. */
    private async online(): Promise<void> {
        await this.setLoginState('ok');
        await this.poll();
    }

    /**
     * One polling cycle. Backoff and session retry are only reset here: a login that works while the
     * API does not must neither end in a login loop nor lose the backoff (audit B.11.5).
     */
    private async poll(): Promise<void> {
        const started = Date.now();
        try {
            const homescreen = await this.exclusive(() => this.readCloud());
            await this.setConnection(true);
            await this.setLoginState('ok');
            this.retrySeconds = RETRY_START_S;
            this.expiredRetried = false;
            this.log.debug(
                `Poll took ${Date.now() - started} ms: ${homescreen.networks.length} networks, ` +
                    `${homescreen.syncModules.length} Sync Modules, ${homescreen.devices.length} devices`,
            );
            await this.updateBattery(homescreen);
            await this.updateImages(homescreen);
            await this.updateMotion();
            this.schedule(pollDelayMs(this.pollSeconds), () => this.poll());
        } catch (err) {
            await this.handleFailure(err);
        }
    }

    /**
     * Motion clips are extras like images: a problem with them is logged once and does not count as a lost
     * connection. Only a rate limit or a rejected session goes to the normal error handling.
     */
    private async updateMotion(): Promise<void> {
        try {
            await this.motionClips?.poll(Date.now());
            if (this.motionFailing) {
                this.motionFailing = false;
                this.log.info('Motion clips can be read again');
            }
        } catch (err) {
            if (err instanceof RateLimitedError || err instanceof SessionExpiredError || this.stopping(err)) {
                throw err;
            }
            const message = `Motion clips not read: ${describeError(err)}`;
            if (this.motionFailing) {
                this.log.debug(message);
            } else {
                this.motionFailing = true;
                this.log.warn(message);
            }
        }
        try {
            await this.clips?.sync();
            await this.clips?.expire(Date.now());
        } catch (err) {
            if (this.stopping(err)) {
                throw err;
            }
            this.log.warn(`Clips not updated: ${describeError(err)}`);
        }
    }

    /**
     * ffmpeg can be started.
     *
     * @param command - Program, undefined if the setting is not acceptable
     */
    private ffmpegAvailable(command: string | undefined): Promise<boolean> {
        if (!command) {
            return Promise.resolve(false);
        }
        return new Promise(resolve => {
            const check = spawn(command, ['-version'], { shell: false, stdio: 'ignore', windowsHide: true });
            check.on('error', () => resolve(false));
            check.on('exit', code => resolve(code === 0));
        });
    }

    /**
     * Connection to a stream server. Only the one known certificate is trusted, see stream-certificate.ts: the stream
     * token is only sent if the server has it.
     *
     * @param origin - Local fake cloud of the integration test
     * @param host - Host of the stream server
     * @param port - TCP port of the stream server
     * @param ready - Called when the connection can be used
     */
    private connectStream(origin: string | undefined, host: string, port: number, ready: () => void): ImmiSocket {
        if (origin) {
            return netConnect(Number(new URL(origin).port), '127.0.0.1', ready);
        }
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
            throw new Error('TLS certificate checks are switched off in this process, nothing is sent to Blink');
        }
        return tlsConnect(
            {
                host,
                port,
                ...(isIP(host) ? {} : { servername: host }),
                ca: STREAM_CERT_PEM,
                rejectUnauthorized: true,
                checkServerIdentity: (_host, certificate) => pinnedCertificateError(certificate),
            },
            ready,
        );
    }

    /**
     * Reads who issued the certificate of a stream server, so that a refused certificate can be judged.
     * The connection is not verified, which is why nothing is ever sent over it: no token, no data.
     *
     * @param origin - Local fake cloud of the integration test
     * @param host - Host of the stream server
     * @param port - TCP port of the stream server
     */
    private describeCertificate(origin: string | undefined, host: string, port: number): Promise<string> {
        if (origin) {
            return Promise.resolve('test mode');
        }
        return new Promise((resolve, reject) => {
            const socket = tlsConnect(
                { host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }) },
                () => {
                    const certificate = socket.getPeerCertificate();
                    const names = (certificate.subjectaltname ?? '-').slice(0, 200);
                    // what is needed to judge and to renew a pinned certificate. A certificate is public
                    this.log.debug(`Stream server certificate: ${certificate.raw?.toString('base64') ?? '-'}`);
                    resolve(
                        `issuer ${String(certificate.issuer?.CN ?? certificate.issuer?.O ?? '-')}, ` +
                            `subject ${String(certificate.subject?.CN ?? '-')}, names ${names}, ` +
                            `valid until ${certificate.valid_to ?? '-'}, check ${String(socket.authorizationError ?? 'ok')}, ` +
                            `fingerprint ${certificate.fingerprint256 ?? '-'}, ` +
                            `server ${createHash('sha256').update(host).digest('hex').slice(0, 8)}`,
                    );
                    socket.destroy();
                },
            );
            socket.setTimeout(5_000, () => {
                socket.destroy();
                reject(new Error('timeout'));
            });
            socket.on('error', reject);
        });
    }

    /**
     * Images are extras: a problem with them must not look like a lost connection.
     *
     * @param homescreen - Current homescreen
     */
    private async updateBattery(homescreen: Homescreen): Promise<void> {
        try {
            await this.battery?.check(homescreen);
        } catch (err) {
            if (this.stopping(err)) {
                throw err;
            }
            this.log.warn(`Battery warning not checked: ${describeError(err)}`);
        }
    }

    /** The messages are written in German if the system language is German */
    private async german(): Promise<boolean> {
        try {
            const config = await this.getForeignObjectAsync('system.config');
            return config?.common?.language === 'de';
        } catch {
            return false;
        }
    }

    /**
     * Sends a message through a messenger instance (telegram.0 by default). Only text, no images (audit B.10.22).
     *
     * @param text - Message
     * @param instanceValue - Instance from the config
     * @param usersValue - Receivers from the config, empty for all
     */
    private async notify(text: string, instanceValue: unknown, usersValue: unknown): Promise<void> {
        const instance = notifyInstance(instanceValue);
        if (!instance) {
            throw new Error('the instance for messages is not valid (example: telegram.0)');
        }
        if (!(await this.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val) {
            throw new Error(`${instance} is not running`);
        }
        const users = notifyUsers(usersValue);
        for (const user of users.length > 0 ? users : [undefined]) {
            const answer: unknown = await this.sendToAsync(instance, 'send', user ? { text, user } : { text }, {
                timeout: NOTIFY_TIMEOUT_MS,
            });
            if (answer && typeof answer === 'object' && 'error' in answer && answer.error) {
                throw new Error(`${instance}: ${typeof answer.error === 'string' ? answer.error : 'error'}`);
            }
            // telegram answers with the number of messages sent: 0 means it knows no receiver
            if (answer === 0) {
                throw new Error(
                    `${instance} sent the message to nobody${user ? ` (receiver "${user}" unknown?)` : ''}`,
                );
            }
        }
    }

    private async updateImages(homescreen: Homescreen): Promise<void> {
        try {
            await this.images!.sync(homescreen.devices);
            await this.images!.expire(Date.now());
        } catch (err) {
            if (this.stopping(err)) {
                throw err;
            }
            this.log.warn(`Images not updated: ${describeError(err)}`);
        }
    }

    /**
     * Runs cloud requests one after the other. Otherwise two token refreshes could use up the same refresh
     * token, and a poll started before a command could write its old values after it.
     *
     * @param task - Requests of the cloud
     */
    private exclusive<T>(task: () => Promise<T>): Promise<T> {
        const run = this.lane.then(task);
        this.lane = run.catch(() => undefined);
        return run;
    }

    /** Reads the homescreen and writes it into the object tree. */
    private async readCloud(): Promise<Homescreen> {
        const homescreen = await this.authorized(session => this.rest!.homescreen(session));
        if (this.abort.signal.aborted) {
            throw new AbortedError();
        }
        await this.tree!.apply(homescreen);
        await this.selection!.ensure(homescreen.networks.map(network => network.id));
        this.homescreen = homescreen;
        await this.setState('info.lastPoll', Date.now(), true);
        return homescreen;
    }

    /**
     * Runs a request with a valid token. A rejected token is renewed once, because a new login could
     * trigger a 2FA SMS.
     *
     * @param request - The request
     */
    private async authorized<T>(request: (session: Session) => Promise<T>): Promise<T> {
        await this.ensureFresh();
        try {
            return await request(this.currentSession());
        } catch (err) {
            if (!(err instanceof SessionExpiredError)) {
                throw err;
            }
            await this.ensureFresh(true);
            return request(this.currentSession());
        }
    }

    /**
     * User wants to arm or disarm a network or asks for a snapshot. ack: true for "armed" follows with the
     * state read back from Blink.
     *
     * @param id - Full state ID
     * @param state - New state
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack || !this.arm) {
            return;
        }
        const relative = id.slice(this.namespace.length + 1);
        const snapshot = relative.match(/^cameras\.(\d+)\.snapshot$/);
        if (snapshot) {
            this.onSnapshot(relative, Number(snapshot[1]), state);
            return;
        }
        if (relative === CONTROL_IDS.armSelected || relative === CONTROL_IDS.disarmAll) {
            this.onControl(relative, state);
            return;
        }
        const motion = relative.match(/^cameras\.(\d+)\.enabled$/);
        if (motion) {
            this.onMotion(Number(motion[1]), state);
            return;
        }
        const choice = relative.match(/^networks\.(\d+)\.armWithAll$/);
        const match = relative.match(/^networks\.(\d+)\.armed$/);
        const networkId = Number((choice ?? match)?.[1]);
        const fail = (err: unknown): void => {
            if (!this.abort.signal.aborted) {
                this.log.error(`Network ${networkId}: ${describeError(err)}`);
            }
        };
        if (choice) {
            this.selection?.set(networkId, state.val).catch(fail);
            return;
        }
        if (!match) {
            return;
        }
        if (typeof state.val === 'boolean') {
            this.arm.request(networkId, state.val).catch(fail);
        } else {
            this.log.warn(`Network ${networkId}: "armed" needs true or false`);
            this.arm.restore(networkId).catch(fail);
        }
    }

    /**
     * The button was pressed: confirmed at once, the result follows in snapshotResult.
     *
     * @param id - Relative state ID
     * @param cameraId - Camera ID
     * @param state - New state
     */
    private onSnapshot(id: string, cameraId: number, state: ioBroker.State): void {
        const fail = (err: unknown): void => {
            if (!this.abort.signal.aborted) {
                this.log.error(`Camera ${cameraId}: ${describeError(err)}`);
            }
        };
        this.tree?.release(id, state.val).catch(fail);
        if (state.val) {
            this.snapshots?.request(cameraId).catch(fail);
        }
    }

    /**
     * Motion detection of a device was switched. ack: true follows with the state read back from Blink.
     *
     * @param cameraId - Camera ID
     * @param state - New state
     */
    private onMotion(cameraId: number, state: ioBroker.State): void {
        const fail = (err: unknown): void => {
            if (!this.abort.signal.aborted) {
                this.log.error(`Camera ${cameraId}: ${describeError(err)}`);
            }
        };
        if (typeof state.val === 'boolean') {
            this.motion?.request(cameraId, state.val).catch(fail);
        } else {
            this.log.warn(`Camera ${cameraId}: "enabled" needs true or false`);
            this.motion?.restore(cameraId).catch(fail);
        }
    }

    /**
     * "Arm selected" or "disarm all" was pressed: confirmed at once, each network reports in armPending/armResult.
     *
     * @param id - Relative state ID
     * @param state - New state
     */
    private onControl(id: string, state: ioBroker.State): void {
        const command = id === CONTROL_IDS.armSelected ? 'armSelected' : 'disarmAll';
        const fail = (err: unknown): void => {
            if (!this.abort.signal.aborted) {
                this.log.error(`${command}: ${describeError(err)}`);
            }
        };
        this.setState(id, state.val, true).catch(fail);
        if (state.val !== true) {
            return;
        }
        if (!this.homescreen || !this.selection) {
            this.log.warn(`${command}: not connected to Blink, command dropped`);
            return;
        }
        const networks = this.homescreen.networks.map(network => {
            const known = this.tree?.value(`networks.${network.id}.armed`);
            return { id: network.id, armed: typeof known === 'boolean' ? known : network.armed };
        });
        this.selection.run(command, networks).catch(fail);
    }

    /**
     * Serial numbers were states until 11.11.2026. They are personal data (audit B.10.18) and only needed in
     * memory for the live image, so the states of earlier versions are removed.
     */
    private async removeSerialStates(): Promise<void> {
        for (const folder of ['syncModules', 'cameras']) {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.${folder}.*.serial`, 'state');
            for (const id of Object.keys(objects ?? {})) {
                await this.delForeignObjectAsync(id);
            }
        }
    }

    /** Commands for several networks; created here, as instanceObjects do not reach existing instances */
    private async createControlObjects(): Promise<void> {
        await this.extendObject('control', {
            type: 'channel',
            common: { name: 'Commands for several networks' },
            native: {},
        });
        const buttons: [string, string][] = [
            [CONTROL_IDS.armSelected, 'Arm the networks selected in networks.*.armWithAll'],
            [CONTROL_IDS.disarmAll, 'Disarm all networks'],
        ];
        for (const [id, name] of buttons) {
            await this.extendObject(id, {
                type: 'state',
                common: { name, type: 'boolean', role: 'button', read: false, write: true },
                native: {},
            });
        }
    }

    private currentSession(): Session {
        if (!this.session) {
            throw new SessionExpiredError('no session');
        }
        return this.session;
    }

    /**
     * Error handling without login loops (audit B.11.5): rejected credentials stop, rate limits wait,
     * other errors retry with exponential backoff.
     *
     * @param err - Caught error
     */
    private async handleFailure(err: unknown): Promise<void> {
        // shutting down: the database may already be closed, a failed request is no connection problem
        if (this.stopping(err)) {
            this.log.debug(`Stopped while busy: ${describeError(err)}`);
            return;
        }
        await this.setConnection(false);

        if (err instanceof CredentialsRejectedError) {
            await this.setLoginState('credentialsRejected');
            this.log.error(`${err.message}. No further attempts - check the instance settings.`);
            return;
        }
        if (err instanceof TwoFactorRejectedError) {
            await this.setLoginState('twoFactorRejected');
            this.log.error(`${err.message}. Enter the current code from Blink.`);
            if (this.config.pin) {
                await this.updateConfig({ pin: '' });
            }
            return;
        }
        if (err instanceof RateLimitedError) {
            const retryAt = Date.now() + err.retryAfterMs;
            await this.setState('auth.retryAt', retryAt, true);
            await this.setLoginState('rateLimited');
            this.log.warn(`${err.message} - waiting until ${new Date(retryAt).toLocaleString()}`);
            this.schedule(err.retryAfterMs, () => this.connect());
            return;
        }
        if (err instanceof SessionExpiredError) {
            await this.dropSession();
            if (!this.expiredRetried) {
                this.expiredRetried = true;
                this.log.info(`${err.message} - logging in again`);
                this.schedule(1_000, () => this.connect());
                return;
            }
        }

        await this.setLoginState('error');
        this.log.warn(`Blink connection failed: ${describeError(err)}. Next attempt in ${this.retrySeconds} s`);
        this.schedule(this.retrySeconds * 1000, () => this.connect());
        this.retrySeconds = Math.min(this.retrySeconds * 2, RETRY_MAX_S);
    }

    /**
     * The error comes from shutting down: requests were aborted or the database is already closed.
     *
     * @param err - Caught error
     */
    private stopping(err: unknown): boolean {
        return err instanceof AbortedError || this.abort.signal.aborted;
    }

    /**
     * sendTo commands: verifyPin, liveStart, liveStop.
     *
     * @param obj - Message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        const reply = (result: Record<string, unknown>): void => {
            if (obj?.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
        };
        if (obj?.command === 'liveStart' || obj?.command === 'liveStop') {
            await this.onLiveMessage(obj, reply);
            return;
        }
        if (obj?.command === 'batteryTest') {
            // from the instance settings: uses the values in the form, also before they are saved
            const message = obj.message as { instance?: unknown; users?: unknown } | undefined;
            try {
                await this.notify(batteryTestText(await this.german()), message?.instance, message?.users);
                this.log.info('Test message sent');
                return reply({ result: 'OK' });
            } catch (err) {
                this.log.warn(`Test message not sent: ${describeError(err)}`);
                return reply({ error: describeError(err) });
            }
        }
        if (obj?.command !== 'verifyPin') {
            return;
        }
        const message = obj.message as { pin?: unknown } | undefined;
        const pin = normalizePin(typeof message?.pin === 'number' ? String(message.pin) : message?.pin);
        const pending = decodePending((await this.getStateAsync('auth.pending'))?.val, this.codec);
        if (!pin) {
            return reply({ success: false, error: 'invalid code (4 to 8 digits)' });
        }
        if (!pending || !this.oauth || this.connecting) {
            return reply({ success: false, error: 'no login is waiting for a 2FA code' });
        }
        this.connecting = true;
        try {
            const tokens = await this.oauth.verifyTwoFactor(pending, pin);
            await this.completeLogin(tokens, pending.hardwareId, false);
            reply({ success: true });
        } catch (err) {
            await this.handleFailure(err);
            reply({ success: false, error: describeError(err) });
        } finally {
            this.connecting = false;
        }
    }

    /**
     * Starts or ends a live image. The address with its token goes to the asking client only, not into a state
     * (audit B.10.22). It contains port and path: the client knows the host it is talking to.
     *
     * @param obj - Message
     * @param reply - Sends the answer
     */
    private async onLiveMessage(
        obj: ioBroker.Message,
        reply: (result: Record<string, unknown>) => void,
    ): Promise<void> {
        const message = obj.message as { cameraId?: unknown } | undefined;
        const cameraId = Number(message?.cameraId);
        if (!Number.isSafeInteger(cameraId) || cameraId <= 0 || !this.live) {
            return reply({ success: false, result: 'rejected' });
        }
        try {
            if (obj.command === 'liveStop') {
                await this.live.stop(cameraId);
                return reply({ success: true });
            }
            const access = await this.live.start(cameraId);
            reply({ success: access.result === 'running', ...access });
        } catch (err) {
            if (!this.abort.signal.aborted) {
                this.log.warn(`Camera ${cameraId}: ${describeError(err)}`);
                reply({ success: false, result: 'failed' });
            }
        }
    }

    /**
     * Stored hardware ID, or a new one (kept across logins so Blink recognises the "device").
     *
     * @param preferred - Hardware ID of a pending login
     */
    private async hardwareId(preferred: string | undefined): Promise<string> {
        if (preferred) {
            return preferred;
        }
        const stored = (await this.getStateAsync('auth.hardwareId'))?.val;
        if (typeof stored === 'string' && stored) {
            try {
                const id = this.decrypt(stored);
                if (/^[0-9A-F-]{36}$/.test(id)) {
                    return id;
                }
            } catch {
                // damaged value - create a new ID below
            }
        }
        const id = newHardwareId();
        await this.setState('auth.hardwareId', this.encrypt(id), true);
        return id;
    }

    private async saveSession(): Promise<void> {
        if (this.session) {
            await this.setState('auth.session', encodeSession(this.session, this.codec), true);
        }
    }

    private async dropSession(): Promise<void> {
        this.session = undefined;
        await this.setState('auth.session', '', true);
    }

    private async setConnection(connected: boolean): Promise<void> {
        if (connected !== this.cloudConnected) {
            this.cloudConnected = connected;
            await this.setState('info.connection', connected, true);
        }
    }

    private async setLoginState(state: LoginState): Promise<void> {
        if (state !== this.loginState) {
            this.loginState = state;
            await this.setState('info.loginState', state, true);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            this.abort.abort();
            this.live?.shutdown();
            this.clearTimeout(this.timer);
            this.timer = undefined;
            // not awaited: the callback must come in any case; the database may already be closing
            this.setState('info.connection', false, true).catch((err: unknown) =>
                this.log.debug(`info.connection not reset: ${describeError(err)}`),
            );
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Blink(options);
} else {
    // otherwise start the instance directly
    (() => new Blink())();
}
