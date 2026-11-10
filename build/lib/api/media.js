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
var media_exports = {};
__export(media_exports, {
  describeMediaPage: () => describeMediaPage,
  parseMediaPage: () => parseMediaPage
});
module.exports = __toCommonJS(media_exports);
var import_homescreen = require("./homescreen");
var import_http = require("./http");
const DETECTION = /^[a-z][a-z_]{0,29}$/;
function text(value) {
  return typeof value === "string" && value ? value : void 0;
}
function detectionsOf(metadata) {
  const parsed = typeof metadata === "string" ? (0, import_http.parseJson)(metadata) : metadata;
  const raw = (0, import_http.field)(parsed, "cv_detection");
  const detections = (Array.isArray(raw) ? raw : []).map((item) => typeof item === "string" ? item : (0, import_http.field)(item, "type")).filter((item) => typeof item === "string").map((item) => item.trim().toLowerCase()).filter((item) => DETECTION.test(item));
  const length = (0, import_http.field)(parsed, "pts_length_ms");
  return {
    detections: [...new Set(detections)],
    lengthMs: typeof length === "number" && Number.isFinite(length) && length > 0 ? length : void 0
  };
}
function parseEntry(entry) {
  var _a, _b;
  const id = (0, import_homescreen.toId)((0, import_http.field)(entry, "id"));
  const deviceId = (0, import_homescreen.toId)((0, import_http.field)(entry, "device_id"));
  const created = (0, import_http.field)(entry, "created_at");
  const createdAt = typeof created === "string" ? Date.parse(created) : NaN;
  if (id === void 0 || deviceId === void 0 || !Number.isFinite(createdAt)) {
    return void 0;
  }
  return {
    id,
    deviceId,
    networkId: (0, import_homescreen.toId)((0, import_http.field)(entry, "network_id")),
    createdAt,
    deleted: (0, import_http.field)(entry, "deleted") === true,
    type: (_a = text((0, import_http.field)(entry, "type"))) != null ? _a : "",
    source: (_b = text((0, import_http.field)(entry, "source"))) != null ? _b : "",
    ...detectionsOf((0, import_http.field)(entry, "metadata")),
    media: text((0, import_http.field)(entry, "media")),
    thumbnail: text((0, import_http.field)(entry, "thumbnail"))
  };
}
function parseMediaPage(body) {
  const media = (0, import_http.field)(body, "media");
  if (!Array.isArray(media)) {
    return void 0;
  }
  const limit = (0, import_homescreen.toId)((0, import_http.field)(body, "limit"));
  return {
    entries: media.map(parseEntry).filter((entry) => entry !== void 0),
    limit
  };
}
const SAMPLE_TEXT = 60;
const SAMPLE_DEPTH = 4;
function kind(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  return typeof value;
}
function sample(value, depth = 0) {
  if (typeof value === "string") {
    if (/^(\/|https?:|wss?:|rtsps?:|immis?:)/i.test(value) || /\.(mp4|jpe?g|m3u8)\b/i.test(value)) {
      return `<address ${value.length}>`;
    }
    return value.length > SAMPLE_TEXT ? `${value.slice(0, SAMPLE_TEXT)}\u2026(${value.length})` : value;
  }
  if (Array.isArray(value)) {
    return depth >= SAMPLE_DEPTH ? `array(${value.length})` : value.slice(0, 1).map((item) => sample(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= SAMPLE_DEPTH) {
      return "object";
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sample(item, depth + 1)]));
  }
  return value;
}
function describeMediaPage(body) {
  var _a;
  if (body === null || typeof body !== "object") {
    return `no object: ${kind(body)}`;
  }
  const top = Object.entries(body).map(([key, value]) => `${key}:${kind(value)}`).join(", ");
  const media = (0, import_http.field)(body, "media");
  if (!Array.isArray(media)) {
    return `top {${top}}, no "media" list`;
  }
  const fields = /* @__PURE__ */ new Map();
  for (const entry of media) {
    if (entry !== null && typeof entry === "object") {
      for (const [key, value] of Object.entries(entry)) {
        const kinds = (_a = fields.get(key)) != null ? _a : /* @__PURE__ */ new Set();
        kinds.add(kind(value).replace(/\(\d+\)$/, ""));
        fields.set(key, kinds);
      }
    }
  }
  const fieldList = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([key, kinds]) => `${key}:${[...kinds].join("|")}`).join(", ");
  return `top {${top}}, ${media.length} entries, fields {${fieldList}}, values {${countValues(media, "type")}; ${countValues(media, "source")}}, metadata {${metadataKeys(media)}}, first ${JSON.stringify(sample(media[0]))}`;
}
function countValues(media, key) {
  var _a;
  const counts = /* @__PURE__ */ new Map();
  for (const entry of media) {
    const value = (0, import_http.field)(entry, key);
    const text2 = typeof value === "string" && value.length <= 30 ? value : kind(value);
    counts.set(text2, ((_a = counts.get(text2)) != null ? _a : 0) + 1);
  }
  return `${key}: ${[...counts].map(([value, n]) => `${value} ${n}`).join(", ")}`;
}
function metadataKeys(media) {
  const keys = /* @__PURE__ */ new Map();
  for (const entry of media) {
    const raw = (0, import_http.field)(entry, "metadata");
    const parsed = typeof raw === "string" ? (0, import_http.parseJson)(raw) : raw;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (!keys.has(key)) {
          keys.set(key, sample(value, 1));
        }
      }
    }
  }
  return [...keys].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  describeMediaPage,
  parseMediaPage
});
//# sourceMappingURL=media.js.map
