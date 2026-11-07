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
var session_store_exports = {};
__export(session_store_exports, {
  PENDING_MAX_AGE_MS: () => PENDING_MAX_AGE_MS,
  decodePending: () => decodePending,
  decodeSession: () => decodeSession,
  encodePending: () => encodePending,
  encodeSession: () => encodeSession
});
module.exports = __toCommonJS(session_store_exports);
const PENDING_MAX_AGE_MS = 10 * 6e4;
function decode(value, codec) {
  if (typeof value !== "string" || !value) {
    return void 0;
  }
  try {
    const parsed = JSON.parse(codec.decrypt(value));
    return parsed !== null && typeof parsed === "object" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
const isText = (value) => typeof value === "string" && value.length > 0;
function encodeSession(session, codec) {
  return codec.encrypt(JSON.stringify(session));
}
function decodeSession(value, codec) {
  const raw = decode(value, codec);
  if (!raw || !isText(raw.accessToken) || !isText(raw.hardwareId) || !isText(raw.restOrigin) || typeof raw.expiresAt !== "number" || typeof raw.accountId !== "number" || !/^https:\/\/rest-[a-z0-9]{2,8}\.immedia-semi\.com$/.test(raw.restOrigin)) {
    return void 0;
  }
  return {
    accessToken: raw.accessToken,
    refreshToken: isText(raw.refreshToken) ? raw.refreshToken : void 0,
    expiresAt: raw.expiresAt,
    hardwareId: raw.hardwareId,
    accountId: raw.accountId,
    restOrigin: raw.restOrigin
  };
}
function encodePending(pending, codec) {
  return codec.encrypt(JSON.stringify(pending));
}
function decodePending(value, codec, now = Date.now()) {
  const raw = decode(value, codec);
  if (!raw || !isText(raw.csrfToken) || !isText(raw.verifier) || !isText(raw.hardwareId) || !isText(raw.signinPath) || typeof raw.createdAt !== "number" || raw.cookies === null || typeof raw.cookies !== "object" || now - raw.createdAt > PENDING_MAX_AGE_MS) {
    return void 0;
  }
  const cookies = {};
  for (const [name, cookie] of Object.entries(raw.cookies)) {
    if (typeof cookie === "string") {
      cookies[name] = cookie;
    }
  }
  return {
    cookies,
    csrfToken: raw.csrfToken,
    verifier: raw.verifier,
    hardwareId: raw.hardwareId,
    signinPath: raw.signinPath,
    createdAt: raw.createdAt
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PENDING_MAX_AGE_MS,
  decodePending,
  decodeSession,
  encodePending,
  encodeSession
});
//# sourceMappingURL=session-store.js.map
