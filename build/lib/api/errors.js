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
var errors_exports = {};
__export(errors_exports, {
  AbortedError: () => AbortedError,
  ApiError: () => ApiError,
  BlinkError: () => BlinkError,
  BusyError: () => BusyError,
  CredentialsRejectedError: () => CredentialsRejectedError,
  RateLimitedError: () => RateLimitedError,
  SessionExpiredError: () => SessionExpiredError,
  TwoFactorRejectedError: () => TwoFactorRejectedError,
  describeError: () => describeError
});
module.exports = __toCommonJS(errors_exports);
class BlinkError extends Error {
  /**
   * @param message - Error message
   */
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
class CredentialsRejectedError extends BlinkError {
  /** Creates the error */
  constructor() {
    super("Blink rejected the e-mail address or password");
  }
}
class TwoFactorRejectedError extends BlinkError {
  /**
   * @param status - HTTP status
   */
  constructor(status) {
    super(`Blink rejected the 2FA code (HTTP ${status})`);
  }
}
class RateLimitedError extends BlinkError {
  retryAfterMs;
  /**
   * @param retryAfterMs - Wait time in ms
   */
  constructor(retryAfterMs) {
    super(`Blink rate limit, next attempt in ${Math.ceil(retryAfterMs / 1e3)} s`);
    this.retryAfterMs = retryAfterMs;
  }
}
class SessionExpiredError extends BlinkError {
  /**
   * @param reason - Why the session is no longer valid
   */
  constructor(reason) {
    super(`Blink session expired: ${reason}`);
  }
}
class ApiError extends BlinkError {
  status;
  /**
   * @param what - Failed action
   * @param status - HTTP status
   */
  constructor(what, status) {
    super(`${what} failed (HTTP ${status})`);
    this.status = status;
  }
}
class BusyError extends BlinkError {
  /** Creates the error */
  constructor() {
    super("Blink is busy with another command");
  }
}
class AbortedError extends BlinkError {
  /** Creates the error */
  constructor() {
    super("Request aborted");
  }
}
function describeError(err) {
  if (err instanceof BlinkError) {
    return err.message;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError") {
      return "request timed out";
    }
    const cause = err.cause;
    const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `${err.message}${code}`;
  }
  return String(err);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AbortedError,
  ApiError,
  BlinkError,
  BusyError,
  CredentialsRejectedError,
  RateLimitedError,
  SessionExpiredError,
  TwoFactorRejectedError,
  describeError
});
//# sourceMappingURL=errors.js.map
