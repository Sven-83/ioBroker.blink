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
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_net = require("node:net");
var import_node_tls = require("node:tls");
var import_errors = require("./lib/api/errors");
var import_http = require("./lib/api/http");
var import_immi = require("./lib/api/immi");
var import_stream_certificate = require("./lib/api/stream-certificate");
var import_oauth = require("./lib/api/oauth");
var import_rest = require("./lib/api/rest");
var import_session_store = require("./lib/model/session-store");
var import_arm_queue = require("./lib/model/arm-queue");
var import_arm_selection = require("./lib/model/arm-selection");
var import_image_store = require("./lib/model/image-store");
var import_live_manager = require("./lib/model/live-manager");
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
  motion;
  selection;
  images;
  snapshots;
  live;
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
    await this.setForeignObjectNotExistsAsync(this.namespace, {
      type: "meta",
      common: { name: "Images of the cameras", type: "meta.user" },
      native: {}
    });
    await this.createControlObjects();
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
    const deviceOf = (cameraId) => {
      var _a;
      const device = (_a = this.homescreen) == null ? void 0 : _a.devices.find((item) => item.id === cameraId);
      if ((device == null ? void 0 : device.networkId) === void 0) {
        throw new Error("Blink does not report this camera or its network");
      }
      return { ...device, networkId: device.networkId };
    };
    this.motion = new import_arm_queue.ArmQueue(
      {
        online: () => this.cloudConnected,
        send: (cameraId, enabled) => {
          const device = deviceOf(cameraId);
          return this.exclusive(
            () => this.authorized(
              (session) => this.rest.setMotion(session, device.networkId, device.kind, device.id, enabled)
            )
          );
        },
        commandStatus: (cameraId, commandId) => {
          const { networkId } = deviceOf(cameraId);
          return this.exclusive(
            () => this.authorized((session) => this.rest.commandStatus(session, networkId, commandId))
          );
        },
        read: async (cameraId) => {
          var _a;
          const homescreen = await this.exclusive(() => this.readCloud());
          return (_a = homescreen.devices.find((device) => device.id === cameraId)) == null ? void 0 : _a.enabled;
        },
        wait: (ms) => this.delay(ms),
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message)
      },
      this.tree,
      import_arm_queue.MOTION_SWITCH
    );
    this.selection = new import_arm_selection.ArmSelection({
      readStored: async () => {
        const stored = /* @__PURE__ */ new Map();
        const states = await this.getStatesAsync(`networks.*.${import_arm_selection.SELECTION_KEY}`);
        for (const [id, state] of Object.entries(states != null ? states : {})) {
          const match = id.match(/\.networks\.(\d+)\.armWithAll$/);
          if (match && state) {
            stored.set(Number(match[1]), state.val);
          }
        }
        return stored;
      },
      write: (networkId, value) => this.setState(`networks.${networkId}.${import_arm_selection.SELECTION_KEY}`, value, true),
      request: (networkId, armed) => this.arm.request(networkId, armed),
      info: (message) => this.log.info(message)
    });
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
    const ffmpeg = (0, import_config.ffmpegCommand)(this.config.ffmpegPath);
    this.live = new import_live_manager.LiveManager(
      {
        enabled: () => this.config.liveEnabled === true,
        online: () => this.cloudConnected,
        device: (cameraId) => {
          var _a;
          return (_a = this.homescreen) == null ? void 0 : _a.devices.find((device) => device.id === cameraId);
        },
        ffmpegAvailable: () => this.ffmpegAvailable(ffmpeg),
        spawnFfmpeg: (args) => (0, import_node_child_process.spawn)(ffmpeg != null ? ffmpeg : "ffmpeg", args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }),
        start: (device, networkId) => this.exclusive(
          () => this.authorized((session) => this.rest.startLive(session, networkId, device.kind, device.id))
        ),
        stop: (networkId, commandId) => this.exclusive(
          () => this.authorized((session) => this.rest.stopLive(session, networkId, commandId))
        ),
        connect: (host, port, ready) => this.connectStream(origin, host, port, ready),
        describeCertificate: (host, port) => this.describeCertificate(origin, host, port),
        setTimer: (run, ms) => this.setTimeout(run, ms),
        clearTimer: (timer) => this.clearTimeout(timer),
        listen: () => ({ host: (0, import_config.liveBindAddress)(this.config.liveBind), port: (0, import_config.livePort)(this.config.livePort) }),
        maxMs: () => (0, import_config.liveMaxSeconds)(this.config.liveMaxSeconds) * 1e3,
        debug: (message) => this.log.debug(message),
        warn: (message) => this.log.warn(message)
      },
      this.tree
    );
    await this.subscribeStatesAsync("cameras.*.snapshot");
    await this.subscribeStatesAsync("networks.*.armed");
    await this.subscribeStatesAsync("cameras.*.enabled");
    await this.subscribeStatesAsync(`networks.*.${import_arm_selection.SELECTION_KEY}`);
    await this.subscribeStatesAsync("control.*");
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
   * ffmpeg can be started.
   *
   * @param command - Program, undefined if the setting is not acceptable
   */
  ffmpegAvailable(command) {
    if (!command) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const check = (0, import_node_child_process.spawn)(command, ["-version"], { shell: false, stdio: "ignore", windowsHide: true });
      check.on("error", () => resolve(false));
      check.on("exit", (code) => resolve(code === 0));
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
  connectStream(origin, host, port, ready) {
    if (origin) {
      return (0, import_node_net.connect)(Number(new URL(origin).port), "127.0.0.1", ready);
    }
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error("TLS certificate checks are switched off in this process, nothing is sent to Blink");
    }
    return (0, import_node_tls.connect)(
      {
        host,
        port,
        ...(0, import_node_net.isIP)(host) ? {} : { servername: host },
        ca: import_stream_certificate.STREAM_CERT_PEM,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => (0, import_immi.pinnedCertificateError)(certificate)
      },
      ready
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
  describeCertificate(origin, host, port) {
    if (origin) {
      return Promise.resolve("test mode");
    }
    return new Promise((resolve, reject) => {
      const socket = (0, import_node_tls.connect)(
        { host, port, rejectUnauthorized: false, ...(0, import_node_net.isIP)(host) ? {} : { servername: host } },
        () => {
          var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
          const certificate = socket.getPeerCertificate();
          const names = ((_a = certificate.subjectaltname) != null ? _a : "-").slice(0, 200);
          this.log.debug(`Stream server certificate: ${(_c = (_b = certificate.raw) == null ? void 0 : _b.toString("base64")) != null ? _c : "-"}`);
          resolve(
            `issuer ${String((_g = (_f = (_d = certificate.issuer) == null ? void 0 : _d.CN) != null ? _f : (_e = certificate.issuer) == null ? void 0 : _e.O) != null ? _g : "-")}, subject ${String((_i = (_h = certificate.subject) == null ? void 0 : _h.CN) != null ? _i : "-")}, names ${names}, valid until ${(_j = certificate.valid_to) != null ? _j : "-"}, check ${String((_k = socket.authorizationError) != null ? _k : "ok")}, fingerprint ${(_l = certificate.fingerprint256) != null ? _l : "-"}, server ${(0, import_node_crypto.createHash)("sha256").update(host).digest("hex").slice(0, 8)}`
          );
          socket.destroy();
        }
      );
      socket.setTimeout(5e3, () => {
        socket.destroy();
        reject(new Error("timeout"));
      });
      socket.on("error", reject);
    });
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
    await this.selection.ensure(homescreen.networks.map((network) => network.id));
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
    var _a, _b;
    if (!state || state.ack || !this.arm) {
      return;
    }
    const relative = id.slice(this.namespace.length + 1);
    const snapshot = relative.match(/^cameras\.(\d+)\.snapshot$/);
    if (snapshot) {
      this.onSnapshot(relative, Number(snapshot[1]), state);
      return;
    }
    if (relative === import_arm_selection.CONTROL_IDS.armSelected || relative === import_arm_selection.CONTROL_IDS.disarmAll) {
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
    const networkId = Number((_a = choice != null ? choice : match) == null ? void 0 : _a[1]);
    const fail = (err) => {
      if (!this.abort.signal.aborted) {
        this.log.error(`Network ${networkId}: ${(0, import_errors.describeError)(err)}`);
      }
    };
    if (choice) {
      (_b = this.selection) == null ? void 0 : _b.set(networkId, state.val).catch(fail);
      return;
    }
    if (!match) {
      return;
    }
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
  /**
   * Motion detection of a device was switched. ack: true follows with the state read back from Blink.
   *
   * @param cameraId - Camera ID
   * @param state - New state
   */
  onMotion(cameraId, state) {
    var _a, _b;
    const fail = (err) => {
      if (!this.abort.signal.aborted) {
        this.log.error(`Camera ${cameraId}: ${(0, import_errors.describeError)(err)}`);
      }
    };
    if (typeof state.val === "boolean") {
      (_a = this.motion) == null ? void 0 : _a.request(cameraId, state.val).catch(fail);
    } else {
      this.log.warn(`Camera ${cameraId}: "enabled" needs true or false`);
      (_b = this.motion) == null ? void 0 : _b.restore(cameraId).catch(fail);
    }
  }
  /**
   * "Arm selected" or "disarm all" was pressed: confirmed at once, each network reports in armPending/armResult.
   *
   * @param id - Relative state ID
   * @param state - New state
   */
  onControl(id, state) {
    const command = id === import_arm_selection.CONTROL_IDS.armSelected ? "armSelected" : "disarmAll";
    const fail = (err) => {
      if (!this.abort.signal.aborted) {
        this.log.error(`${command}: ${(0, import_errors.describeError)(err)}`);
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
    const networks = this.homescreen.networks.map((network) => {
      var _a;
      const known = (_a = this.tree) == null ? void 0 : _a.value(`networks.${network.id}.armed`);
      return { id: network.id, armed: typeof known === "boolean" ? known : network.armed };
    });
    this.selection.run(command, networks).catch(fail);
  }
  /** Commands for several networks; created here, as instanceObjects do not reach existing instances */
  async createControlObjects() {
    await this.extendObjectAsync("control", {
      type: "channel",
      common: { name: "Commands for several networks" },
      native: {}
    });
    const buttons = [
      [import_arm_selection.CONTROL_IDS.armSelected, "Arm the networks selected in networks.*.armWithAll"],
      [import_arm_selection.CONTROL_IDS.disarmAll, "Disarm all networks"]
    ];
    for (const [id, name] of buttons) {
      await this.extendObjectAsync(id, {
        type: "state",
        common: { name, type: "boolean", role: "button", read: false, write: true },
        native: {}
      });
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
   * sendTo commands: verifyPin, liveStart, liveStop.
   *
   * @param obj - Message
   */
  async onMessage(obj) {
    var _a;
    const reply = (result) => {
      if (obj == null ? void 0 : obj.callback) {
        this.sendTo(obj.from, obj.command, result, obj.callback);
      }
    };
    if ((obj == null ? void 0 : obj.command) === "liveStart" || (obj == null ? void 0 : obj.command) === "liveStop") {
      await this.onLiveMessage(obj, reply);
      return;
    }
    if ((obj == null ? void 0 : obj.command) !== "verifyPin") {
      return;
    }
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
   * Starts or ends a live image. The address with its token goes to the asking client only, not into a state
   * (audit B.10.22). It contains port and path: the client knows the host it is talking to.
   *
   * @param obj - Message
   * @param reply - Sends the answer
   */
  async onLiveMessage(obj, reply) {
    const message = obj.message;
    const cameraId = Number(message == null ? void 0 : message.cameraId);
    if (!Number.isSafeInteger(cameraId) || cameraId <= 0 || !this.live) {
      return reply({ success: false, result: "rejected" });
    }
    try {
      if (obj.command === "liveStop") {
        await this.live.stop(cameraId);
        return reply({ success: true });
      }
      const access = await this.live.start(cameraId);
      reply({ success: access.result === "running", ...access });
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.log.warn(`Camera ${cameraId}: ${(0, import_errors.describeError)(err)}`);
        reply({ success: false, result: "failed" });
      }
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
    var _a;
    try {
      this.abort.abort();
      (_a = this.live) == null ? void 0 : _a.shutdown();
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
