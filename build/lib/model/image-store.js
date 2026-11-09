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
var image_store_exports = {};
__export(image_store_exports, {
  ImageStore: () => ImageStore,
  captureTime: () => captureTime,
  fileName: () => fileName,
  hashOf: () => hashOf
});
module.exports = __toCommonJS(image_store_exports);
var import_node_crypto = require("node:crypto");
var import_errors = require("../api/errors");
function hashOf(value) {
  return (0, import_node_crypto.createHash)("sha256").update(value).digest("hex");
}
function captureTime(thumbnail, now) {
  let ts;
  try {
    ts = new URL(thumbnail, "https://blink.invalid").searchParams.get("ts");
  } catch {
    return void 0;
  }
  let time = NaN;
  if (ts && /^\d{10}$/.test(ts)) {
    time = Number(ts) * 1e3;
  } else if (ts && /^\d{13}$/.test(ts)) {
    time = Number(ts);
  } else if (ts && /^\d{4}-\d{2}-\d{2}T/.test(ts)) {
    time = Date.parse(ts);
  }
  return Number.isFinite(time) && time >= Date.UTC(2020, 0, 1) && time <= now + 5 * 6e4 ? time : void 0;
}
function parseInfo(value) {
  if (typeof value !== "string" || !value) {
    return void 0;
  }
  try {
    const info = JSON.parse(value);
    return typeof info.ref === "string" && typeof info.hash === "string" && typeof info.savedAt === "number" ? { ref: info.ref, hash: info.hash, savedAt: info.savedAt, stored: info.stored === true } : void 0;
  } catch {
    return void 0;
  }
}
class ImageStore {
  /**
   * @param host - Adapter functions
   * @param tree - Object tree
   * @param retentionMs - Images are deleted this long after their download
   */
  constructor(host, tree, retentionMs) {
    this.host = host;
    this.tree = tree;
    this.retentionMs = retentionMs;
  }
  infos;
  blocked = /* @__PURE__ */ new Set();
  /** Addresses that could not be fetched: tried again after a restart or with a new image, not on every poll */
  failed = /* @__PURE__ */ new Map();
  /**
   * A snapshot of this camera is running and looks after the image itself.
   *
   * @param cameraId - Camera ID
   * @param active - Snapshot started or ended
   */
  block(cameraId, active) {
    if (active) {
      this.blocked.add(cameraId);
    } else {
      this.blocked.delete(cameraId);
    }
  }
  /**
   * Fetches the images Blink has changed. An error of one image does not stop the others,
   * one that concerns the whole cloud waits for the next poll.
   *
   * @param devices - Devices of the homescreen
   */
  async sync(devices) {
    for (const device of devices) {
      if (this.blocked.has(device.id) || !device.thumbnail) {
        continue;
      }
      const ref = hashOf(device.thumbnail);
      if (this.failed.get(device.id) === ref) {
        continue;
      }
      try {
        await this.refresh(device);
        this.failed.delete(device.id);
      } catch (err) {
        if (!(err instanceof import_errors.ApiError)) {
          if (!(err instanceof import_errors.AbortedError)) {
            this.host.debug(`Images not updated: ${(0, import_errors.describeError)(err)}`);
          }
          return;
        }
        this.failed.set(device.id, ref);
        this.host.warn(`Camera ${device.id}: ${(0, import_errors.describeError)(err)}`);
      }
    }
  }
  /**
   * Fetches the image of a device if its address has changed. A new address with the same content does not
   * make an old image look new.
   *
   * @param device - Device of the homescreen
   */
  async refresh(device) {
    var _a;
    if (!device.thumbnail) {
      return;
    }
    const ref = hashOf(device.thumbnail);
    const info = await this.info(device.id);
    if ((info == null ? void 0 : info.ref) === ref) {
      return;
    }
    const data = await this.host.download(device.thumbnail);
    if ((info == null ? void 0 : info.hash) === hashOf(data)) {
      await this.remember(device.id, { ...info, ref });
      return;
    }
    await this.save(device.id, device.thumbnail, data, (_a = captureTime(device.thumbnail, Date.now())) != null ? _a : 0);
  }
  /**
   * Hash of the current image.
   *
   * @param cameraId - Camera ID
   */
  async currentHash(cameraId) {
    var _a;
    return (_a = await this.info(cameraId)) == null ? void 0 : _a.hash;
  }
  /**
   * Stores an image.
   *
   * @param cameraId - Camera ID
   * @param thumbnail - Address at Blink
   * @param data - JPEG file
   * @param time - Time of the image, 0 if unknown
   */
  async save(cameraId, thumbnail, data, time) {
    const name = fileName(cameraId);
    const savedAt = Date.now();
    await this.host.writeFile(name, data);
    await this.remember(cameraId, { ref: hashOf(thumbnail), hash: hashOf(data), savedAt, stored: true });
    await this.tree.setValue(`cameras.${cameraId}.imageTime`, time);
    await this.tree.setValue(`cameras.${cameraId}.image`, `${this.host.urlOf(name)}?t=${savedAt}`);
  }
  /**
   * Deletes the images older than the retention period. What Blink still reports is not fetched again,
   * only a new image of the camera comes back.
   *
   * @param now - Current time
   */
  async expire(now) {
    const infos = await this.all();
    for (const [cameraId, info] of infos) {
      if (!info.stored || now - info.savedAt < this.retentionMs) {
        continue;
      }
      try {
        await this.host.deleteFile(fileName(cameraId));
      } catch (err) {
        const message = (0, import_errors.describeError)(err);
        if (!/not ?exist|ENOENT/i.test(message)) {
          this.host.debug(`Camera ${cameraId}: image not deleted: ${message}`);
          continue;
        }
      }
      await this.tree.setValue(`cameras.${cameraId}.image`, "");
      await this.tree.setValue(`cameras.${cameraId}.imageTime`, 0);
      await this.remember(cameraId, { ...info, stored: false });
    }
  }
  async remember(cameraId, info) {
    (await this.all()).set(cameraId, info);
    await this.tree.setValue(`cameras.${cameraId}.imageInfo`, JSON.stringify(info));
  }
  async info(cameraId) {
    return (await this.all()).get(cameraId);
  }
  async all() {
    if (!this.infos) {
      const infos = /* @__PURE__ */ new Map();
      for (const [cameraId, value] of await this.host.readInfos()) {
        const info = parseInfo(value);
        if (info) {
          infos.set(cameraId, info);
        }
      }
      this.infos = infos;
    }
    return this.infos;
  }
}
function fileName(cameraId) {
  return `cameras/${cameraId}.jpg`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ImageStore,
  captureTime,
  fileName,
  hashOf
});
//# sourceMappingURL=image-store.js.map
