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
var clip_store_exports = {};
__export(clip_store_exports, {
  CLIP_ATTEMPTS: () => CLIP_ATTEMPTS,
  ClipStore: () => ClipStore,
  clipFileName: () => clipFileName
});
module.exports = __toCommonJS(clip_store_exports);
var import_errors = require("../api/errors");
const CLIP_ATTEMPTS = 3;
function clipFileName(deviceId) {
  return `clips/${deviceId}.mp4`;
}
function parseInfo(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  try {
    const info = JSON.parse(value);
    if (typeof info.id === "number" && typeof info.time === "number" && typeof info.savedAt === "number" && typeof info.stored === "boolean") {
      return { id: info.id, time: info.time, savedAt: info.savedAt, stored: info.stored };
    }
  } catch {
  }
  return void 0;
}
class ClipStore {
  /**
   * @param host - Adapter functions
   * @param tree - Object tree
   * @param retentionMs - Clips are deleted this long after their download
   */
  constructor(host, tree, retentionMs) {
    this.host = host;
    this.tree = tree;
    this.retentionMs = retentionMs;
  }
  infos;
  wanted = /* @__PURE__ */ new Map();
  /**
   * A device has a new clip: download it on the next sync. A newer clip replaces one still waiting.
   *
   * @param deviceId - Device ID
   * @param clip - New clip
   */
  want(deviceId, clip) {
    const waiting = this.wanted.get(deviceId);
    if (!clip.media || waiting && waiting.clip.time >= clip.time) {
      return;
    }
    this.wanted.set(deviceId, { clip, attempts: 0 });
  }
  /**
   * Downloads the clips that are waiting. An error of one clip does not stop the others, one that concerns
   * the whole cloud waits for the next poll.
   */
  async sync() {
    for (const [deviceId, item] of [...this.wanted]) {
      const info = await this.info(deviceId);
      if ((info == null ? void 0 : info.stored) && info.id === item.clip.id) {
        this.wanted.delete(deviceId);
        continue;
      }
      item.attempts++;
      try {
        const data = await this.host.download(item.clip.media);
        await this.save(deviceId, item.clip, data);
        this.wanted.delete(deviceId);
      } catch (err) {
        if (!(err instanceof import_errors.ApiError)) {
          item.attempts--;
          if (!(err instanceof import_errors.AbortedError)) {
            this.host.debug(`Clips not updated: ${(0, import_errors.describeError)(err)}`);
          }
          return;
        }
        if (item.attempts >= CLIP_ATTEMPTS) {
          this.wanted.delete(deviceId);
          this.host.warn(`Camera ${deviceId}: clip not downloaded: ${(0, import_errors.describeError)(err)}`);
        } else {
          this.host.debug(`Camera ${deviceId}: clip not downloaded yet: ${(0, import_errors.describeError)(err)}`);
        }
      }
    }
  }
  /**
   * Clips deleted at Blink: their stored copies are deleted too, waiting downloads dropped.
   *
   * @param clipIds - IDs of the deleted clips
   */
  async deleted(clipIds) {
    for (const [deviceId, item] of [...this.wanted]) {
      if (clipIds.has(item.clip.id)) {
        this.wanted.delete(deviceId);
      }
    }
    for (const [deviceId, info] of await this.all()) {
      if (info.stored && clipIds.has(info.id)) {
        await this.remove(deviceId, info, "deleted at Blink");
      }
    }
  }
  /**
   * Deletes the clips older than the retention period.
   *
   * @param now - Current time
   */
  async expire(now) {
    for (const [deviceId, info] of await this.all()) {
      if (info.stored && now - info.savedAt >= this.retentionMs) {
        await this.remove(deviceId, info, "retention period over");
      }
    }
  }
  async save(deviceId, clip, data) {
    const name = clipFileName(deviceId);
    const savedAt = Date.now();
    await this.host.writeFile(name, data);
    await this.remember(deviceId, { id: clip.id, time: clip.time, savedAt, stored: true });
    await this.tree.setValue(`cameras.${deviceId}.clipTime`, clip.time);
    await this.tree.setValue(`cameras.${deviceId}.clip`, `${this.host.urlOf(name)}?t=${savedAt}`);
    this.host.debug(`Camera ${deviceId}: clip stored, ${data.length} bytes`);
  }
  async remove(deviceId, info, reason) {
    try {
      await this.host.deleteFile(clipFileName(deviceId));
    } catch (err) {
      const message = (0, import_errors.describeError)(err);
      if (!/not ?exist|ENOENT/i.test(message)) {
        this.host.debug(`Camera ${deviceId}: clip not deleted: ${message}`);
        return;
      }
    }
    await this.tree.setValue(`cameras.${deviceId}.clip`, "");
    await this.tree.setValue(`cameras.${deviceId}.clipTime`, 0);
    await this.remember(deviceId, { ...info, stored: false });
    this.host.debug(`Camera ${deviceId}: clip deleted (${reason})`);
  }
  async remember(deviceId, info) {
    (await this.all()).set(deviceId, info);
    await this.tree.setValue(`cameras.${deviceId}.clipInfo`, JSON.stringify(info));
  }
  async info(deviceId) {
    return (await this.all()).get(deviceId);
  }
  async all() {
    if (!this.infos) {
      const infos = /* @__PURE__ */ new Map();
      for (const [deviceId, value] of await this.host.readInfos()) {
        const info = parseInfo(value);
        if (info) {
          infos.set(deviceId, info);
        }
      }
      this.infos = infos;
    }
    return this.infos;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLIP_ATTEMPTS,
  ClipStore,
  clipFileName
});
//# sourceMappingURL=clip-store.js.map
