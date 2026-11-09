/*
 * ioBroker.blink
 * Adapter lifecycle only - Blink API in lib/api, object tree in lib/model, helpers in lib/util.
 *
 * Phase 4: login with 2FA, encrypted session, token refresh, backoff, polling, arm/disarm with readback.
 */

import * as utils from '@iobroker/adapter-core';
import {
    AbortedError,
    CredentialsRejectedError,
    RateLimitedError,
    SessionExpiredError,
    TwoFactorRejectedError,
    describeError,
} from './lib/api/errors';
import { HttpClient } from './lib/api/http';
import type { Homescreen } from './lib/api/homescreen';
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
import { ArmQueue } from './lib/model/arm-queue';
import { ObjectTree } from './lib/model/tree';
import {
    TEST_ORIGIN_ENV,
    normalizeEmail,
    normalizePin,
    pollDelayMs,
    pollIntervalSeconds,
    testOrigin,
} from './lib/util/config';

/** First retry after a failed login, doubled up to RETRY_MAX_S (audit B.11.4) */
const RETRY_START_S = 60;
const RETRY_MAX_S = 1800;
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
            writeObject: (id, object) => this.extendObjectAsync(id, object),
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
        await this.subscribeStatesAsync('networks.*.armed');
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
            this.schedule(pollDelayMs(this.pollSeconds), () => this.poll());
        } catch (err) {
            await this.handleFailure(err);
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
     * User wants to arm or disarm a network. ack: true follows with the state read back from Blink.
     *
     * @param id - Full state ID
     * @param state - New state
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack || !this.arm) {
            return;
        }
        const match = id.slice(this.namespace.length + 1).match(/^networks\.(\d+)\.armed$/);
        if (!match) {
            return;
        }
        const networkId = Number(match[1]);
        const fail = (err: unknown): void => {
            if (!this.abort.signal.aborted) {
                this.log.error(`Network ${networkId}: ${describeError(err)}`);
            }
        };
        if (typeof state.val === 'boolean') {
            this.arm.request(networkId, state.val).catch(fail);
        } else {
            this.log.warn(`Network ${networkId}: "armed" needs true or false`);
            this.arm.restore(networkId).catch(fail);
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
        if (err instanceof AbortedError) {
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
     * sendTo commands: verifyPin.
     *
     * @param obj - Message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj?.command !== 'verifyPin') {
            return;
        }
        const reply = (result: Record<string, unknown>): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
        };
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
            this.clearTimeout(this.timer);
            this.timer = undefined;
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
