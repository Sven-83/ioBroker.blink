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
  POLL_DEFAULT_S: () => POLL_DEFAULT_S,
  POLL_MAX_S: () => POLL_MAX_S,
  POLL_MIN_S: () => POLL_MIN_S,
  normalizeEmail: () => normalizeEmail,
  normalizePin: () => normalizePin,
  pollIntervalSeconds: () => pollIntervalSeconds
});
module.exports = __toCommonJS(config_exports);
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
function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : void 0;
}
function normalizePin(value) {
  const pin = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  return /^\d{4,8}$/.test(pin) ? pin : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POLL_DEFAULT_S,
  POLL_MAX_S,
  POLL_MIN_S,
  normalizeEmail,
  normalizePin,
  pollIntervalSeconds
});
//# sourceMappingURL=config.js.map
