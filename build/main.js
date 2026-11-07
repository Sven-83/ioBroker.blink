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
var import_session_store = require("./lib/model/session-store");
var import_config = require("./lib/util/config");
const RETRY_START_S = 60;
const RETRY_MAX_S = 1800;
const START_JITTER_MS = 2e3;
const REFRESH_MARGIN_MS = 5 * 6e4;
const REFRESH_MIN_DELAY_MS = 6e4;
class Blink extends utils.Adapter {
  abort = new AbortController();
  oauth;
  session;
  timer;
  retrySeconds = RETRY_START_S;
  email = "";
  pollSeconds = 0;
  connecting = false;
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
    this.oauth = new import_oauth.OAuthFlow(new import_http.HttpClient({ testOrigin: origin, signal: this.abort.signal }));
    await this.setLoginState("connecting");
    this.schedule(Math.floor(Math.random() * START_JITTER_MS), () => this.connect());
  }
  /**
   * Runs a single chained timer - retry, refresh and (later) polling never overlap (audit B.11.2).
   *
   * @param ms - Delay
   * @param task - Task to run
   */
  schedule(ms, task) {
    this.clearTimeout(this.timer);
    this.timer = this.setTimeout(() => {
      this.timer = void 0;
      void task();
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
        try {
          await this.ensureFresh();
          await this.oauth.account(this.session.accessToken);
          await this.online();
          return;
        } catch (err) {
          if (!(err instanceof import_errors.SessionExpiredError)) {
            throw err;
          }
          this.log.info(`${err.message} - logging in again`);
          await this.dropSession();
        }
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
  /** Renews the access token when it expires soon. */
  async ensureFresh() {
    const session = this.session;
    if (!session || session.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
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
  /** Connected: reset the backoff and plan the next token refresh. */
  async online() {
    var _a, _b;
    this.retrySeconds = RETRY_START_S;
    this.expiredRetried = false;
    await this.setState("info.connection", true, true);
    await this.setLoginState("ok");
    const delay = Math.max(
      REFRESH_MIN_DELAY_MS,
      ((_b = (_a = this.session) == null ? void 0 : _a.expiresAt) != null ? _b : 0) - Date.now() - REFRESH_MARGIN_MS + 1e3
    );
    this.schedule(delay, () => this.refreshCycle());
    this.log.debug(
      `Next token refresh in ${Math.round(delay / 6e4)} min, polling (phase 3) every ${this.pollSeconds} s`
    );
  }
  async refreshCycle() {
    try {
      await this.ensureFresh();
      await this.online();
    } catch (err) {
      await this.handleFailure(err);
    }
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
    await this.setState("info.connection", false, true);
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
    this.log.warn(`Blink login failed: ${(0, import_errors.describeError)(err)}. Next attempt in ${this.retrySeconds} s`);
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
