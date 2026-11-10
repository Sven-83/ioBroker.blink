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
var motion_exports = {};
__export(motion_exports, {
  MEDIA_FIRST_LOOK_MS: () => MEDIA_FIRST_LOOK_MS,
  MEDIA_MAX_PAGES: () => MEDIA_MAX_PAGES,
  MEDIA_OVERLAP_MS: () => MEDIA_OVERLAP_MS,
  MotionTracker: () => MotionTracker,
  isMotionClip: () => isMotionClip,
  newestClips: () => newestClips
});
module.exports = __toCommonJS(motion_exports);
const MEDIA_MAX_PAGES = 3;
const MEDIA_OVERLAP_MS = 10 * 60 * 1e3;
const MEDIA_FIRST_LOOK_MS = 24 * 60 * 60 * 1e3;
const MOTION_SOURCES = /* @__PURE__ */ new Set(["pir", "cv_motion"]);
function isMotionClip(entry) {
  return !entry.deleted && entry.type === "video" && MOTION_SOURCES.has(entry.source);
}
function newestClips(entries, known) {
  var _a;
  const newest = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!isMotionClip(entry) || entry.createdAt <= ((_a = known.get(entry.deviceId)) != null ? _a : 0)) {
      continue;
    }
    const current = newest.get(entry.deviceId);
    if (!current || entry.createdAt > current.createdAt) {
      newest.set(entry.deviceId, entry);
    }
  }
  return newest;
}
class MotionTracker {
  /**
   * @param host - Adapter functions
   */
  constructor(host) {
    this.host = host;
  }
  known;
  since;
  clips = /* @__PURE__ */ new Map();
  /**
   * Last motion clip of a device seen since the start of the adapter.
   *
   * @param deviceId - Device ID
   */
  clip(deviceId) {
    return this.clips.get(deviceId);
  }
  /**
   * Reads the changes since the last poll and writes the new clips.
   *
   * @param now - Current time
   * @returns Number of devices with a new clip
   */
  async poll(now) {
    var _a, _b, _c, _d, _e, _f;
    (_a = this.known) != null ? _a : this.known = await this.host.readTimes();
    if (this.since === void 0) {
      const latest = Math.max(0, ...this.known.values());
      this.since = Math.max(latest, now - MEDIA_FIRST_LOOK_MS);
    }
    const from = this.since - MEDIA_OVERLAP_MS;
    const entries = [];
    for (let page = 1; page <= MEDIA_MAX_PAGES; page++) {
      const result = await this.host.read(from, page);
      entries.push(...result.entries);
      if (result.entries.length === 0 || result.entries.length < ((_b = result.limit) != null ? _b : Infinity)) {
        break;
      }
    }
    const devices = this.host.devices();
    const newest = newestClips(
      entries.filter((entry) => devices.has(entry.deviceId)),
      this.known
    );
    for (const [deviceId, entry] of newest) {
      await this.host.write(deviceId, "motionDetection", entry.detections.join(","));
      await this.host.write(deviceId, "motionSource", entry.source);
      await this.host.write(deviceId, "motionTime", entry.createdAt);
      this.known.set(deviceId, entry.createdAt);
      const clip = {
        id: entry.id,
        time: entry.createdAt,
        detections: entry.detections,
        source: entry.source,
        lengthMs: entry.lengthMs,
        media: entry.media
      };
      this.clips.set(deviceId, clip);
      await ((_d = (_c = this.host).newClip) == null ? void 0 : _d.call(_c, deviceId, clip));
    }
    const deletedIds = new Set(entries.filter((entry) => entry.deleted).map((entry) => entry.id));
    if (deletedIds.size > 0) {
      await ((_f = (_e = this.host).deletedClips) == null ? void 0 : _f.call(_e, deletedIds));
    }
    this.since = now;
    const deleted = entries.filter((entry) => entry.deleted).length;
    const other = entries.filter((entry) => !entry.deleted && !isMotionClip(entry)).length;
    const unknown = entries.filter((entry) => !devices.has(entry.deviceId)).length;
    const oldest = entries.length > 0 ? Math.min(...entries.map((entry) => entry.createdAt)) : void 0;
    this.host.debug(
      `Media: ${entries.length} entries since the last poll (${deleted} deleted, ${other} no motion clip, ${unknown} unknown devices${oldest ? `, oldest ${Math.round((now - oldest) / 6e4)} min ago` : ""}), ${newest.size} devices with a new clip`
    );
    return newest.size;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MEDIA_FIRST_LOOK_MS,
  MEDIA_MAX_PAGES,
  MEDIA_OVERLAP_MS,
  MotionTracker,
  isMotionClip,
  newestClips
});
//# sourceMappingURL=motion.js.map
