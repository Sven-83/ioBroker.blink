"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_errors = require("./lib/api/errors");
var import_http = require("./lib/api/http");
var import_oauth = require("./lib/api/oauth");
var import_rest = require("./lib/api/rest");
var import_session_store = require("./lib/model/session-store");
var import_arm_queue = require("./lib/model/arm-queue");
var import_image_store = require("./lib/model/image-store");
var import_snapshot_queue = require("./lib/model/snapshot-queue");
var import_tree = require("./lib/model/tree");
var import_config = require("./lib/util/config");
const RETRY_START_S = 60;
const RETRY_MAX_S = 1800;
const START_JITTER_MS = 2e3;
const REFRESH_MARGIN_MS = 5 * 6e4;
class Blink extends utils.Adapter {
  abort = new AbortController();
  oauth;
  rest;
  tree;
  arm;
  images;
  snapshots;
  homescreen;
  /** Requests of the cloud run one after the other, see exclusive() */
  lane = Promise.resolve();
  session;
  timer;
  retrySeconds = RETRY_START_S;
  email = "";
  pollSeconds = 0;
  connecting = false;
  cloudConnected = false;
  expiredRetried = false;
  loginState;
  codec = {
    encrypt: (value) => this.encrypt(value),
    decrypt: (value) => this.decrypt(value)
  };
  constructor(options = {}) {
    super({
      ...options,
      name: "blink"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    const email = (0, import_config.normalizeEmail)(this.config.email);
    if (!email || !this.config.password) {
      await this.setLoginState("noConfig");
      this.log.error(
        "Please enter the e-mail address and password of your Blink account in the instance settings."
      );
      return;
    }
    this.email = email;
    this.pollSeconds = (0, import_config.pollIntervalSeconds)(this.config.pollInterval);
    const origin = (0, import_config.testOrigin)(process.env[import_config.TEST_ORIGIN_ENV]);
    if (origin) {
      this.log.warn(`Test mode: all requests go to ${origin}`);
    }
    const http = new import_http.HttpClient({
      testOrigin: origin,
      signal: this.abort.signal,
      trace: (line) => this.log.debug(line)
    });
    this.oauth = new import_oauth.OAuthFlow(http);
    this.rest = new import_rest.RestClient(http);
    this.tree = new import_tree.ObjectTree({
      writeObject: (id, object) => this.extendObjectAsync(id, object),
      writeState: (id, value) => this.setState(id, value, true),
      listDevices: async () => {
        const prefix = `${this.namespace}.`;
        const view = await this.getObjectViewAsync("system", "device", {
          startkey: prefix,
          endkey: `${prefix}\u9999`
        });
        return view.rows.map((row) => row.id.slice(prefix.length));
      },
      info: (message) => this.log.info(message)
    });
    this.arm = new import_arm_queue.ArmQueue(
      {
        online: () => this.cloudConnected,
        send: (networkId, armed) => this.exclusive(() => this.authorized((session) => this.rest.setArmed(session, networkId, armed))),
        commandStatus: (networkId, commandId) => this.exclusive(
          () => this.authorized((session) => this.rest.commandStatus(session, networkId, commandId))
        ),
        read: async (networkId) => {
          var _a;
          const homescreen = await this.exclusive(() => this.readCloud());
          return (_a = homescreen.networks.find((network) => network.id === networkId)) == null ? void 0 : _a.armed;
        },
        wait: (ms) => this.delay(ms),
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message)
      },
      this.tree
    );
    const download = (thumbnail) => this.exclusive(() => this.authorized((session) => this.rest.downloadImage(session, thumbnail)));
    this.images = new import_image_store.ImageStore(
      {
        download,
        writeFile: (name, data) => this.writeFileAsync(this.namespace, name, data),
        deleteFile: (name) => this.delFileAsync(this.namespace, name),
        readInfos: async () => {
          const infos = /* @__PURE__ */ new Map();
          const states = await this.getStatesAsync("cameras.*.imageInfo");
          for (const [id, state] of Object.entries(states != null ? states : {})) {
            const match = id.match(/\.cameras\.(\d+)\.imageInfo$/);
            if (match) {
              infos.set(Number(match[1]), state == null ? void 0 : state.val);
            }
          }
          return infos;
        },
        urlOf: (name) => `/${this.namespace}/${name}`,
        debug: (message) => this.log.debug(message),
        warn: (message) => this.log.warn(message)
      },
      this.tree,
      (0, import_config.imageRetentionHours)(this.config.imageRetentionHours) * 36e5
    );
    this.snapshots = new import_snapshot_queue.SnapshotQueue(
      {
        online: () => this.cloudConnected,
        device: (cameraId) => {
          var _a;
          return (_a = this.homescreen) == null ? void 0 : _a.devices.find((device) => device.id === cameraId);
        },
        read: () => this.exclusive(() => this.readCloud()),
        trigger: (device, networkId) => this.exclusive(
          () => this.authorized((session) => this.rest.snapshot(session, networkId, device.kind, device.id))
        ),
        commandStatus: (networkId, commandId) => this.exclusive(
          () => this.authorized((session) => this.rest.commandStatus(session, networkId, commandId))
        ),
        download,
        wait: (ms) => this.delay(ms),
        debug: (message) => this.log.debug(message),
        warn: (message) => this.log.warn(message)
      },
      this.tree,
      this.images
    );
    await this.subscribeStatesAsync("cameras.*.snapshot");
    await this.subscribeStatesAsync("networks.*.armed");
    await this.setLoginState("connecting");
    this.schedule(Math.floor(Math.random() * START_JITTER_MS), () => this.connect());
  }
  /**
   * Runs a single chained timer - retry and polling (which includes the token refresh) never overlap
   * (audit B.11.2). The next run is only planned when the current one has finished.
   *
   * @param ms - Delay
   * @param task - Task to run
   */
  schedule(ms, task) {
    this.clearTimeout(this.timer);
    this.timer = this.setTimeout(() => {
      this.timer = void 0;
      task().catch((err) => {
        if (!this.abort.signal.aborted) {
          this.log.error(`Unexpected error: ${(0, import_errors.describeError)(err)}`);
        }
      });
    }, ms);
  }
  /** Restores the session or logs in. */
  async connect() {
    var _a, _b;
    if (this.connecting || !this.oauth) {
      return;
    }
    this.connecting = true;
    try {
      const retryAt = Number((_a = await this.getStateAsync("auth.retryAt")) == null ? void 0 : _a.val) || 0;
      if (retryAt > Date.now()) {
        await this.setLoginState("rateLimited");
        this.log.warn(`Blink rate limit active, next login attempt at ${new Date(retryAt).toLocaleString()}`);
        this.schedule(retryAt - Date.now(), () => this.connect());
        return;
      }
      this.session = (0, import_session_store.decodeSession)((_b = await this.getStateAsync("auth.session")) == null ? void 0 : _b.val, this.codec);
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
  async login() {
    var _a;
    const oauth = this.oauth;
    const started = Date.now();
    const pin = (0, import_config.normalizePin)(this.config.pin);
    const pending = (0, import_session_store.decodePending)((_a = await this.getStateAsync("auth.pending")) == null ? void 0 : _a.val, this.codec);
    const hardwareId = await this.hardwareId(pending == null ? void 0 : pending.hardwareId);
    let tokens;
    if (pending && pin) {
      this.log.info("Sending the 2FA code to Blink");
      tokens = await oauth.verifyTwoFactor(pending, pin);
    } else if (pending) {
      await this.setLoginState("twoFactorRequired");
      this.log.warn(
        'Blink is waiting for the 2FA code. Enter it in the instance settings (2FA code) and save, or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).'
      );
      return;
    } else {
      this.log.info("Logging in to Blink");
      const result = await oauth.start(this.email, this.config.password, hardwareId);
      if (result.kind === "twoFactor") {
        if (pin) {
          tokens = await oauth.verifyTwoFactor(result.pending, pin);
        } else {
          await this.setState("auth.pending", (0, import_session_store.encodePending)(result.pending, this.codec), true);
          await this.setLoginState("twoFactorRequired");
          const { channel, destination } = result.challenge;
          const via = [channel, destination].filter(Boolean).join(" to ");
          this.log.warn(
            `Blink sent a 2FA code${via ? ` (${via})` : ""}. Enter it within 10 minutes in the instance settings (2FA code) and save, or send it with sendTo("blink.0", "verifyPin", { pin: "123456" }).`
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
  async completeLogin(tokens, hardwareId, removePin) {
    const account = await this.oauth.account(tokens.accessToken);
    this.session = { ...tokens, hardwareId, ...account };
    await this.saveSession();
    await this.setState("auth.pending", "", true);
    await this.setState("auth.retryAt", 0, true);
    this.log.info("Logged in to Blink");
    if (removePin && this.config.pin) {
      this.log.info("Removing the used 2FA code from the settings - the adapter restarts once");
      await this.updateConfig({ pin: "" });
      return;
    }
    await this.online();
  }
  /**
   * Renews the access token when it expires soon.
   *
   * @param force - Renew in any case (Blink has rejected the token)
   */
  async ensureFresh(force = false) {
    const session = this.session;
    if (!session || !force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return;
    }
    if (!session.refreshToken) {
      throw new import_errors.SessionExpiredError("no refresh token");
    }
    const tokens = await this.oauth.refresh(session.refreshToken, session.hardwareId);
    this.session = { ...session, ...tokens };
    await this.saveSession();
    this.log.debug("Access token renewed");
  }
  /** Logged in: start polling. The first successful poll sets info.connection. */
  async online() {
    await this.setLoginState("ok");
    await this.poll();
  }
  /**
   * One polling cycle. Backoff and session retry are only reset here: a login that works while the
   * API does not must neither end in a login loop nor lose the backoff (audit B.11.5).
   */
  async poll() {
    const started = Date.now();
    try {
      const homescreen = await this.exclusive(() => this.readCloud());
      await this.setConnection(true);
      await this.setLoginState("ok");
      this.retrySeconds = RETRY_START_S;
      this.expiredRetried = false;
      this.log.debug(
        `Poll took ${Date.now() - started} ms: ${homescreen.networks.length} networks, ${homescreen.syncModules.length} Sync Modules, ${homescreen.devices.length} devices`
      );
      await this.updateImages(homescreen);
      this.schedule((0, import_config.pollDelayMs)(this.pollSeconds), () => this.poll());
    } catch (err) {
      await this.handleFailure(err);
    }
  }
  /**
   * Images are extras: a problem with them must not look like a lost connection.
   *
   * @param homescreen - Current homescreen
   */
  async updateImages(homescreen) {
    try {
      await this.images.sync(homescreen.devices);
      await this.images.expire(Date.now());
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.log.warn(`Images not updated: ${(0, import_errors.describeError)(err)}`);
    }
  }
  /**
   * Runs cloud requests one after the other. Otherwise two token refreshes could use up the same refresh
   * token, and a poll started before a command could write its old values after it.
   *
   * @param task - Requests of the cloud
   */
  exclusive(task) {
    const run = this.lane.then(task);
    this.lane = run.catch(() => void 0);
    return run;
  }
  /** Reads the homescreen and writes it into the object tree. */
  async readCloud() {
    const homescreen = await this.authorized((session) => this.rest.homescreen(session));
    if (this.abort.signal.aborted) {
      throw new import_errors.AbortedError();
    }
    await this.tree.apply(homescreen);
    this.homescreen = homescreen;
    await this.setState("info.lastPoll", Date.now(), true);
    return homescreen;
  }
  /**
   * Runs a request with a valid token. A rejected token is renewed once, because a new login could
   * trigger a 2FA SMS.
   *
   * @param request - The request
   */
  async authorized(request) {
    await this.ensureFresh();
    try {
      return await request(this.currentSession());
    } catch (err) {
      if (!(err instanceof import_errors.SessionExpiredError)) {
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
  onStateChange(id, state) {
    if (!state || state.ack || !this.arm) {
      return;
    }
    const relative = id.slice(this.namespace.length + 1);
    const snapshot = relative.match(/^cameras\.(\d+)\.snapshot$/);
    if (snapshot) {
      this.onSnapshot(relative, Number(snapshot[1]), state);
      return;
    }
    const match = relative.match(/^networks\.(\d+)\.armed$/);
    if (!match) {
      return;
    }
    const networkId = Number(match[1]);
    const fail = (err) => {
      if (!this.abort.signal.aborted) {
        this.log.error(`Network ${networkId}: ${(0, import_errors.describeError)(err)}`);
      }
    };
    if (typeof state.val === "boolean") {
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
  onSnapshot(id, cameraId, state) {
    var _a, _b;
    const fail = (err) => {
      if (!this.abort.signal.aborted) {
        this.log.error(`Camera ${cameraId}: ${(0, import_errors.describeError)(err)}`);
      }
    };
    (_a = this.tree) == null ? void 0 : _a.release(id, state.val).catch(fail);
    if (state.val) {
      (_b = this.snapshots) == null ? void 0 : _b.request(cameraId).catch(fail);
    }
  }
  currentSession() {
    if (!this.session) {
      throw new import_errors.SessionExpiredError("no session");
    }
    return this.session;
  }
  /**
   * Error handling without login loops (audit B.11.5): rejected credentials stop, rate limits wait,
   * other errors retry with exponential backoff.
   *
   * @param err - Caught error
   */
  async handleFailure(err) {
    if (err instanceof import_errors.AbortedError) {
      return;
    }
    await this.setConnection(false);
    if (err instanceof import_errors.CredentialsRejectedError) {
      await this.setLoginState("credentialsRejected");
      this.log.error(`${err.message}. No further attempts - check the instance settings.`);
      return;
    }
    if (err instanceof import_errors.TwoFactorRejectedError) {
      await this.setLoginState("twoFactorRejected");
      this.log.error(`${err.message}. Enter the current code from Blink.`);
      if (this.config.pin) {
        await this.updateConfig({ pin: "" });
      }
      return;
    }
    if (err instanceof import_errors.RateLimitedError) {
      const retryAt = Date.now() + err.retryAfterMs;
      await this.setState("auth.retryAt", retryAt, true);
      await this.setLoginState("rateLimited");
      this.log.warn(`${err.message} - waiting until ${new Date(retryAt).toLocaleString()}`);
      this.schedule(err.retryAfterMs, () => this.connect());
      return;
    }
    if (err instanceof import_errors.SessionExpiredError) {
      await this.dropSession();
      if (!this.expiredRetried) {
        this.expiredRetried = true;
        this.log.info(`${err.message} - logging in again`);
        this.schedule(1e3, () => this.connect());
        return;
      }
    }
    await this.setLoginState("error");
    this.log.warn(`Blink connection failed: ${(0, import_errors.describeError)(err)}. Next attempt in ${this.retrySeconds} s`);
    this.schedule(this.retrySeconds * 1e3, () => this.connect());
    this.retrySeconds = Math.min(this.retrySeconds * 2, RETRY_MAX_S);
  }
  /**
   * sendTo commands: verifyPin.
   *
   * @param obj - Message
   */
  async onMessage(obj) {
    var _a;
    if ((obj == null ? void 0 : obj.command) !== "verifyPin") {
      return;
    }
    const reply = (result) => {
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, result, obj.callback);
      }
    };
    const message = obj.message;
    const pin = (0, import_config.normalizePin)(typeof (message == null ? void 0 : message.pin) === "number" ? String(message.pin) : message == null ? void 0 : message.pin);
    const pending = (0, import_session_store.decodePending)((_a = await this.getStateAsync("auth.pending")) == null ? void 0 : _a.val, this.codec);
    if (!pin) {
      return reply({ success: false, error: "invalid code (4 to 8 digits)" });
    }
    if (!pending || !this.oauth || this.connecting) {
      return reply({ success: false, error: "no login is waiting for a 2FA code" });
    }
    this.connecting = true;
    try {
      const tokens = await this.oauth.verifyTwoFactor(pending, pin);
      await this.completeLogin(tokens, pending.hardwareId, false);
      reply({ success: true });
    } catch (err) {
      await this.handleFailure(err);
      reply({ success: false, error: (0, import_errors.describeError)(err) });
    } finally {
      this.connecting = false;
    }
  }
  /**
   * Stored hardware ID, or a new one (kept across logins so Blink recognises the "device").
   *
   * @param preferred - Hardware ID of a pending login
   */
  async hardwareId(preferred) {
    var _a;
    if (preferred) {
      return preferred;
    }
    const stored = (_a = await this.getStateAsync("auth.hardwareId")) == null ? void 0 : _a.val;
    if (typeof stored === "string" && stored) {
      try {
        const id2 = this.decrypt(stored);
        if (/^[0-9A-F-]{36}$/.test(id2)) {
          return id2;
        }
      } catch {
      }
    }
    const id = (0, import_oauth.newHardwareId)();
    await this.setState("auth.hardwareId", this.encrypt(id), true);
    return id;
  }
  async saveSession() {
    if (this.session) {
      await this.setState("auth.session", (0, import_session_store.encodeSession)(this.session, this.codec), true);
    }
  }
  async dropSession() {
    this.session = void 0;
    await this.setState("auth.session", "", true);
  }
  async setConnection(connected) {
    if (connected !== this.cloudConnected) {
      this.cloudConnected = connected;
      await this.setState("info.connection", connected, true);
    }
  }
  async setLoginState(state) {
    if (state !== this.loginState) {
      this.loginState = state;
      await this.setState("info.loginState", state, true);
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    try {
      this.abort.abort();
      this.clearTimeout(this.timer);
      this.timer = void 0;
    } finally {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Blink(options);
} else {
  (() => new Blink())();
}
//# sourceMappingURL=main.js.map
