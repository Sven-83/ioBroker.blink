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
var snapshot_queue_exports = {};
__export(snapshot_queue_exports, {
  SNAPSHOT_BUSY_COOLDOWN_MS: () => SNAPSHOT_BUSY_COOLDOWN_MS,
  SNAPSHOT_BUSY_RETRY_MS: () => SNAPSHOT_BUSY_RETRY_MS,
  SNAPSHOT_COMMAND_POLL_MAX: () => SNAPSHOT_COMMAND_POLL_MAX,
  SNAPSHOT_COMMAND_POLL_MS: () => SNAPSHOT_COMMAND_POLL_MS,
  SNAPSHOT_MIN_GAP_MS: () => SNAPSHOT_MIN_GAP_MS,
  SNAPSHOT_READS_AFTER_COMMAND: () => SNAPSHOT_READS_AFTER_COMMAND,
  SNAPSHOT_READS_WITHOUT_COMMAND: () => SNAPSHOT_READS_WITHOUT_COMMAND,
  SNAPSHOT_READ_MS: () => SNAPSHOT_READ_MS,
  SnapshotQueue: () => SnapshotQueue
});
module.exports = __toCommonJS(snapshot_queue_exports);
var import_errors = require("../api/errors");
var import_image_store = require("./image-store");
const SNAPSHOT_BUSY_RETRY_MS = [6e3, 12e3];
const SNAPSHOT_BUSY_COOLDOWN_MS = 2 * 6e4;
const SNAPSHOT_MIN_GAP_MS = 3e4;
const SNAPSHOT_COMMAND_POLL_MS = 1e3;
const SNAPSHOT_COMMAND_POLL_MAX = 45;
const SNAPSHOT_READ_MS = 2e3;
const SNAPSHOT_READS_AFTER_COMMAND = 8;
const SNAPSHOT_READS_WITHOUT_COMMAND = 30;
function ids(cameraId) {
  const base = `cameras.${cameraId}`;
  return { pending: `${base}.snapshotPending`, result: `${base}.snapshotResult` };
}
class SnapshotQueue {
  /**
   * @param host - Adapter functions
   * @param tree - Object tree
   * @param images - Image store
   */
  constructor(host, tree, images) {
    this.host = host;
    this.tree = tree;
    this.images = images;
  }
  running = /* @__PURE__ */ new Set();
  lanes = /* @__PURE__ */ new Map();
  lastImage = /* @__PURE__ */ new Map();
  busyUntil = /* @__PURE__ */ new Map();
  /**
   * Requests a new image. A request for a camera that already has one running changes nothing.
   *
   * @param cameraId - Camera ID
   */
  async request(cameraId) {
    var _a, _b;
    if (this.running.has(cameraId)) {
      return;
    }
    const { pending, result } = ids(cameraId);
    const refused = this.refusal(cameraId);
    if (refused) {
      await this.tree.setValue(result, "");
      await this.tree.setValue(result, refused);
      return;
    }
    const networkId = (_a = this.host.device(cameraId)) == null ? void 0 : _a.networkId;
    if (networkId === void 0) {
      this.host.warn(`Camera ${cameraId}: Blink does not report this camera or its network`);
      await this.tree.setValue(result, "");
      await this.tree.setValue(result, "rejected");
      return;
    }
    this.running.add(cameraId);
    try {
      await this.tree.setValue(pending, true);
      await this.tree.setValue(result, "");
      const run = ((_b = this.lanes.get(networkId)) != null ? _b : Promise.resolve()).then(() => this.take(cameraId));
      this.lanes.set(
        networkId,
        run.catch(() => void 0)
      );
      const outcome = await run;
      await this.tree.setValue(result, outcome);
      await this.tree.setValue(pending, false);
    } finally {
      this.running.delete(cameraId);
    }
  }
  refusal(cameraId) {
    var _a, _b;
    if (!this.host.online()) {
      this.host.warn(`Camera ${cameraId}: not connected to Blink, snapshot dropped`);
      return "rejected";
    }
    const now = Date.now();
    if (((_a = this.busyUntil.get(cameraId)) != null ? _a : 0) > now) {
      return "busy";
    }
    return now - ((_b = this.lastImage.get(cameraId)) != null ? _b : 0) < SNAPSHOT_MIN_GAP_MS ? "throttled" : void 0;
  }
  async take(cameraId) {
    const started = Date.now();
    this.images.block(cameraId, true);
    try {
      const outcome = await this.execute(cameraId);
      this.host.debug(`Camera ${cameraId}: snapshot took ${Date.now() - started} ms: ${outcome}`);
      return outcome;
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.warn(`Camera ${cameraId}: snapshot failed: ${(0, import_errors.describeError)(err)}`);
      return "rejected";
    } finally {
      this.images.block(cameraId, false);
    }
  }
  async execute(cameraId) {
    const device = (await this.host.read()).devices.find((item) => item.id === cameraId);
    if ((device == null ? void 0 : device.networkId) === void 0) {
      this.host.warn(`Camera ${cameraId}: Blink does not report this camera or its network`);
      return "rejected";
    }
    if (device.status === "offline") {
      this.host.warn(`Camera ${cameraId} is offline, no snapshot`);
      return "offline";
    }
    const baseRef = device.thumbnail;
    try {
      await this.images.refresh(device);
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.debug(`Camera ${cameraId}: last image not available: ${(0, import_errors.describeError)(err)}`);
    }
    const baseHash = await this.images.currentHash(cameraId);
    let commandId;
    try {
      commandId = await this.trigger(device, device.networkId);
    } catch (err) {
      if (err instanceof import_errors.BusyError) {
        this.busyUntil.set(cameraId, Date.now() + SNAPSHOT_BUSY_COOLDOWN_MS);
        this.host.warn(`Camera ${cameraId}: Blink is busy, no snapshot for the next minutes`);
        return "busy";
      }
      throw err;
    }
    const status = commandId === void 0 ? void 0 : await this.follow(device.networkId, commandId, cameraId);
    const reads = status === "failed" ? 1 : commandId === void 0 ? SNAPSHOT_READS_WITHOUT_COMMAND : SNAPSHOT_READS_AFTER_COMMAND;
    for (let attempt = 0; attempt < reads; attempt++) {
      await this.host.wait(SNAPSHOT_READ_MS);
      if (await this.newImage(cameraId, baseRef, baseHash)) {
        this.lastImage.set(cameraId, Date.now());
        return "confirmed";
      }
    }
    return status === "failed" ? "rejected" : "unconfirmed";
  }
  async trigger(device, networkId) {
    for (const delay of [...SNAPSHOT_BUSY_RETRY_MS, void 0]) {
      try {
        return await this.host.trigger(device, networkId);
      } catch (err) {
        if (!(err instanceof import_errors.BusyError) || delay === void 0) {
          throw err;
        }
        await this.host.wait(delay);
      }
    }
    return void 0;
  }
  async follow(networkId, commandId, cameraId) {
    for (let attempt = 0; attempt < SNAPSHOT_COMMAND_POLL_MAX; attempt++) {
      await this.host.wait(SNAPSHOT_COMMAND_POLL_MS);
      try {
        const status = await this.host.commandStatus(networkId, commandId);
        if (status !== "running") {
          return status;
        }
      } catch (err) {
        if (err instanceof import_errors.AbortedError) {
          throw err;
        }
        this.host.debug(`Camera ${cameraId}: command status not available: ${(0, import_errors.describeError)(err)}`);
        return "running";
      }
    }
    return "running";
  }
  async newImage(cameraId, baseRef, baseHash) {
    var _a, _b;
    try {
      const thumbnail = (_a = (await this.host.read()).devices.find((item) => item.id === cameraId)) == null ? void 0 : _a.thumbnail;
      if (!thumbnail || thumbnail === baseRef) {
        return false;
      }
      const data = await this.host.download(thumbnail);
      if ((0, import_image_store.hashOf)(data) === baseHash) {
        this.host.debug(`Camera ${cameraId}: new address, but the image is still the old one`);
        return false;
      }
      const now = Date.now();
      await this.images.save(cameraId, thumbnail, data, (_b = (0, import_image_store.captureTime)(thumbnail, now)) != null ? _b : now);
      return true;
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.debug(`Camera ${cameraId}: new image not available yet: ${(0, import_errors.describeError)(err)}`);
      return false;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SNAPSHOT_BUSY_COOLDOWN_MS,
  SNAPSHOT_BUSY_RETRY_MS,
  SNAPSHOT_COMMAND_POLL_MAX,
  SNAPSHOT_COMMAND_POLL_MS,
  SNAPSHOT_MIN_GAP_MS,
  SNAPSHOT_READS_AFTER_COMMAND,
  SNAPSHOT_READS_WITHOUT_COMMAND,
  SNAPSHOT_READ_MS,
  SnapshotQueue
});
//# sourceMappingURL=snapshot-queue.js.map
