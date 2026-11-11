"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var live_manager_exports = {};
__export(live_manager_exports, {
  LIVE_FIRST_FRAME_MS: () => LIVE_FIRST_FRAME_MS,
  LIVE_FPS: () => LIVE_FPS,
  LIVE_IDLE_MS: () => LIVE_IDLE_MS,
  LIVE_WIDTH: () => LIVE_WIDTH,
  LiveManager: () => LiveManager,
  ffmpegArgs: () => ffmpegArgs
});
module.exports = __toCommonJS(live_manager_exports);
var import_node_crypto = require("node:crypto");
var import_errors = require("../api/errors");
var import_immi = require("../api/immi");
var import_mjpeg = require("../util/mjpeg");
var import_live_server = require("./live-server");
const LIVE_IDLE_MS = 2e4;
const LIVE_FIRST_FRAME_MS = 3e4;
const LIVE_FPS = 10;
const LIVE_WIDTH = 1280;
function ffmpegArgs(maxSeconds) {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    // with the defaults ffmpeg collects about five seconds of video first, and that delay then stays
    "-probesize",
    "256k",
    "-analyzeduration",
    "500000",
    "-f",
    "mpegts",
    "-i",
    "pipe:0",
    "-t",
    String(maxSeconds),
    "-an",
    "-vf",
    `fps=${LIVE_FPS},scale=${LIVE_WIDTH}:-2`,
    "-c:v",
    "mjpeg",
    "-q:v",
    "7",
    "-f",
    "image2pipe",
    "pipe:1"
  ];
}
class LiveManager {
  /**
   * @param host - Adapter functions
   * @param tree - Object tree
   */
  constructor(host, tree) {
    this.host = host;
    this.tree = tree;
    this.server = new import_live_server.LiveServer((count) => this.onClients(count));
  }
  session;
  starting = false;
  server;
  /**
   * Starts the live image of a camera, or gives access to the one that is running.
   *
   * @param cameraId - Camera ID
   */
  async start(cameraId) {
    const running = this.session;
    if ((running == null ? void 0 : running.cameraId) === cameraId) {
      return this.access(running);
    }
    if (running || this.starting) {
      return this.refuse(cameraId, "busy");
    }
    if (!this.host.enabled()) {
      return this.refuse(cameraId, "disabled");
    }
    if (!this.host.online()) {
      return this.refuse(cameraId, "rejected");
    }
    const device = this.host.device(cameraId);
    if ((device == null ? void 0 : device.networkId) === void 0 || !device.serial) {
      this.host.warn(`Camera ${cameraId}: Blink does not report this camera, its network or its serial number`);
      return this.refuse(cameraId, "rejected");
    }
    if (device.status === "offline") {
      return this.refuse(cameraId, "offline");
    }
    this.starting = true;
    try {
      if (!await this.host.ffmpegAvailable()) {
        this.host.warn("Live image: ffmpeg not found. Install it or set its path in the instance settings.");
        return await this.refuse(cameraId, "noFfmpeg");
      }
      return await this.open(device, device.networkId, device.serial);
    } catch (err) {
      await this.server.stop();
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.warn(`Camera ${cameraId}: live image not started: ${(0, import_errors.describeError)(err)}`);
      return await this.refuse(cameraId, "failed");
    } finally {
      this.starting = false;
    }
  }
  /**
   * Ends the live image of a camera.
   *
   * @param cameraId - Camera ID
   */
  async stop(cameraId) {
    var _a;
    if (((_a = this.session) == null ? void 0 : _a.cameraId) === cameraId) {
      await this.end("ended");
    }
  }
  /** The adapter shuts down: processes and connections end at once, Blink is not asked anymore */
  shutdown() {
    const session = this.session;
    this.session = void 0;
    if (session) {
      this.release(session);
      void this.server.stop();
    }
  }
  async refuse(cameraId, result) {
    if (!this.host.device(cameraId)) {
      return { result };
    }
    await this.tree.setValue(`cameras.${cameraId}.liveResult`, "");
    await this.tree.setValue(`cameras.${cameraId}.liveResult`, result);
    return { result };
  }
  access(session) {
    return {
      result: "running",
      port: session.port,
      path: `/live/${session.cameraId}.mjpeg?token=${session.token}`,
      expiresAt: session.expiresAt
    };
  }
  async open(device, networkId, serial) {
    const token = (0, import_node_crypto.randomBytes)(32).toString("hex");
    const port = await this.server.start(this.host.listen(), device.id, token);
    const start = await this.host.start(device, networkId);
    const immiServer = (0, import_immi.parseImmiServer)(start.server);
    if (!immiServer || !start.token) {
      this.host.warn(
        `Camera ${device.id}: Blink offers no live image for this camera (${(0, import_immi.describeServer)(start.server)}, token ${start.token ? "given" : "missing"})`
      );
      await this.server.stop();
      if (start.commandId !== void 0) {
        await this.tellBlink(networkId, start.commandId);
      }
      return this.refuse(device.id, "unsupported");
    }
    const maxMs = this.host.maxMs();
    const now = Date.now();
    const session = {
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
      process: void 0,
      immi: void 0,
      limit: void 0,
      idle: void 0,
      noFrame: void 0
    };
    this.session = session;
    this.host.info(`Camera ${session.cameraId}: live image started, waiting for the first image`);
    const process = this.host.spawnFfmpeg(ffmpegArgs(Math.ceil(maxMs / 1e3)));
    session.process = process;
    const splitter = new import_mjpeg.FrameSplitter();
    process.stdin.on("error", () => void 0);
    process.stdout.on("data", (chunk) => {
      for (const frame of splitter.push(chunk)) {
        this.onFrame(session, frame);
      }
    });
    process.stderr.on("data", (chunk) => this.host.debug(`ffmpeg: ${chunk.toString("utf8").trim()}`));
    process.on("error", (err) => {
      this.host.warn(`Live image: ffmpeg: ${(0, import_errors.describeError)(err)}`);
      this.endSession(session, "failed");
    });
    process.on("exit", () => this.endSession(session, "ended"));
    const immi = new import_immi.ImmiClient({
      server: immiServer,
      token: start.token,
      serial,
      connect: (host, tcpPort, ready) => this.host.connect(host, tcpPort, ready),
      onVideo: (chunk) => {
        process.stdin.write(chunk);
      },
      onClose: (err) => this.onImmiClose(session, err),
      setTimer: (run, ms) => this.host.setTimer(run, ms),
      clearTimer: (timer) => this.host.clearTimer(timer)
    });
    session.immi = immi;
    session.limit = this.host.setTimer(() => this.endSession(session, "ended"), maxMs);
    session.idle = this.host.setTimer(() => this.endSession(session, "idle"), LIVE_IDLE_MS);
    session.noFrame = this.host.setTimer(() => {
      this.host.warn(`Camera ${device.id}: no live image from Blink`);
      this.endSession(session, "failed");
    }, LIVE_FIRST_FRAME_MS);
    await this.tree.setValue(`cameras.${device.id}.liveResult`, "");
    await this.tree.setValue(`cameras.${device.id}.liveResult`, "running");
    await this.tree.setValue(`cameras.${device.id}.liveActive`, true);
    immi.open();
    return this.access(session);
  }
  onFrame(session, frame) {
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
  onImmiClose(session, err) {
    if (this.session !== session) {
      return;
    }
    if ((0, import_immi.isCertificateError)(err)) {
      this.host.warn(
        `Camera ${session.cameraId}: the certificate of the Blink stream server was not accepted, the stream token was not sent (${(0, import_errors.describeError)(err)})`
      );
      this.host.describeCertificate(session.streamHost, session.streamPort).then((text) => this.host.warn(`Camera ${session.cameraId}: certificate of the stream server: ${text}`)).catch((failure) => this.host.debug(`Certificate not readable: ${(0, import_errors.describeError)(failure)}`));
      this.endSession(session, "certificate");
      return;
    }
    if (err) {
      this.host.warn(`Camera ${session.cameraId}: live connection lost: ${(0, import_errors.describeError)(err)}`);
    }
    this.endSession(session, err ? "failed" : "ended");
  }
  onClients(count) {
    const session = this.session;
    if (!session) {
      return;
    }
    this.host.clearTimer(session.idle);
    session.idle = count > 0 ? void 0 : this.host.setTimer(() => this.endSession(session, "idle"), LIVE_IDLE_MS);
  }
  endSession(session, result) {
    if (this.session === session) {
      this.end(result).catch((err) => this.host.debug(`Live image not ended: ${(0, import_errors.describeError)(err)}`));
    }
  }
  release(session) {
    var _a, _b, _c;
    this.host.clearTimer(session.limit);
    this.host.clearTimer(session.idle);
    this.host.clearTimer(session.noFrame);
    (_a = session.immi) == null ? void 0 : _a.close();
    (_b = session.process) == null ? void 0 : _b.stdin.end();
    (_c = session.process) == null ? void 0 : _c.kill();
  }
  async end(result) {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = void 0;
    this.release(session);
    await this.server.stop();
    await this.tree.setValue(`cameras.${session.cameraId}.liveActive`, false);
    await this.tree.setValue(`cameras.${session.cameraId}.liveResult`, result);
    this.host.info(
      `Camera ${session.cameraId}: live image ended after ${Date.now() - session.started} ms: ${result}`
    );
    if (session.commandId !== void 0) {
      await this.tellBlink(session.networkId, session.commandId);
    }
  }
  async tellBlink(networkId, commandId) {
    try {
      await this.host.stop(networkId, commandId);
    } catch (err) {
      if (!(err instanceof import_errors.AbortedError)) {
        this.host.debug(`Blink not told about the end of the live image: ${(0, import_errors.describeError)(err)}`);
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIVE_FIRST_FRAME_MS,
  LIVE_FPS,
  LIVE_IDLE_MS,
  LIVE_WIDTH,
  LiveManager,
  ffmpegArgs
});
//# sourceMappingURL=live-manager.js.map
