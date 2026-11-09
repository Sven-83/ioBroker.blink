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
var config_exports = {};
__export(config_exports, {
  IMAGE_RETENTION_DEFAULT_H: () => IMAGE_RETENTION_DEFAULT_H,
  IMAGE_RETENTION_MAX_H: () => IMAGE_RETENTION_MAX_H,
  IMAGE_RETENTION_MIN_H: () => IMAGE_RETENTION_MIN_H,
  LIVE_MAX_DEFAULT_S: () => LIVE_MAX_DEFAULT_S,
  LIVE_MAX_MAX_S: () => LIVE_MAX_MAX_S,
  LIVE_MAX_MIN_S: () => LIVE_MAX_MIN_S,
  LIVE_PORT_DEFAULT: () => LIVE_PORT_DEFAULT,
  POLL_DEFAULT_S: () => POLL_DEFAULT_S,
  POLL_JITTER_MS: () => POLL_JITTER_MS,
  POLL_MAX_S: () => POLL_MAX_S,
  POLL_MIN_S: () => POLL_MIN_S,
  TEST_ORIGIN_ENV: () => TEST_ORIGIN_ENV,
  ffmpegCommand: () => ffmpegCommand,
  imageRetentionHours: () => imageRetentionHours,
  liveBindAddress: () => liveBindAddress,
  liveMaxSeconds: () => liveMaxSeconds,
  livePort: () => livePort,
  normalizeEmail: () => normalizeEmail,
  normalizePin: () => normalizePin,
  pollDelayMs: () => pollDelayMs,
  pollIntervalSeconds: () => pollIntervalSeconds,
  testOrigin: () => testOrigin
});
module.exports = __toCommonJS(config_exports);
var import_node_net = require("node:net");
var import_node_path = require("node:path");
const POLL_DEFAULT_S = 60;
const POLL_MIN_S = 30;
const POLL_MAX_S = 3600;
function pollIntervalSeconds(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return POLL_DEFAULT_S;
  }
  return Math.min(Math.max(seconds, POLL_MIN_S), POLL_MAX_S);
}
const IMAGE_RETENTION_DEFAULT_H = 24;
const IMAGE_RETENTION_MIN_H = 1;
const IMAGE_RETENTION_MAX_H = 720;
function imageRetentionHours(value) {
  const hours = Math.round(Number(value));
  if (!Number.isFinite(hours) || hours <= 0) {
    return IMAGE_RETENTION_DEFAULT_H;
  }
  return Math.min(Math.max(hours, IMAGE_RETENTION_MIN_H), IMAGE_RETENTION_MAX_H);
}
const LIVE_MAX_DEFAULT_S = 120;
const LIVE_MAX_MIN_S = 30;
const LIVE_MAX_MAX_S = 600;
const LIVE_PORT_DEFAULT = 8766;
function liveMaxSeconds(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return LIVE_MAX_DEFAULT_S;
  }
  return Math.min(Math.max(seconds, LIVE_MAX_MIN_S), LIVE_MAX_MAX_S);
}
function liveBindAddress(value) {
  const address = typeof value === "string" ? value.trim() : "";
  return (0, import_node_net.isIP)(address) ? address : "127.0.0.1";
}
function livePort(value) {
  const port = Math.round(Number(value));
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : LIVE_PORT_DEFAULT;
}
function ffmpegCommand(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) {
    return "ffmpeg";
  }
  return (0, import_node_path.isAbsolute)(path) && /^ffmpeg(\.exe)?$/i.test((0, import_node_path.basename)(path)) ? path : void 0;
}
const POLL_JITTER_MS = 5e3;
function pollDelayMs(seconds, random = Math.random) {
  return seconds * 1e3 + Math.floor(random() * POLL_JITTER_MS);
}
function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : void 0;
}
function normalizePin(value) {
  const pin = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  return /^\d{4,8}$/.test(pin) ? pin : void 0;
}
const TEST_ORIGIN_ENV = "BLINK_TEST_ORIGIN";
function testOrigin(value) {
  return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  IMAGE_RETENTION_DEFAULT_H,
  IMAGE_RETENTION_MAX_H,
  IMAGE_RETENTION_MIN_H,
  LIVE_MAX_DEFAULT_S,
  LIVE_MAX_MAX_S,
  LIVE_MAX_MIN_S,
  LIVE_PORT_DEFAULT,
  POLL_DEFAULT_S,
  POLL_JITTER_MS,
  POLL_MAX_S,
  POLL_MIN_S,
  TEST_ORIGIN_ENV,
  ffmpegCommand,
  imageRetentionHours,
  liveBindAddress,
  liveMaxSeconds,
  livePort,
  normalizeEmail,
  normalizePin,
  pollDelayMs,
  pollIntervalSeconds,
  testOrigin
});
//# sourceMappingURL=config.js.map
