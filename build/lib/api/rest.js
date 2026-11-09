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
var rest_exports = {};
__export(rest_exports, {
  IMAGE_MAX_BYTES: () => IMAGE_MAX_BYTES,
  RestClient: () => RestClient,
  imageUrl: () => imageUrl
});
module.exports = __toCommonJS(rest_exports);
var import_constants = require("./constants");
var import_errors = require("./errors");
var import_homescreen = require("./homescreen");
var import_http = require("./http");
const UNKNOWN_PATH = [404, 405, 410];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const BLINK_HOST = /(^|\.)immedia-semi\.com$/;
function imageUrl(thumbnail, restOrigin) {
  let url;
  try {
    url = new URL(thumbnail, restOrigin);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:" || !(url.origin === restOrigin || BLINK_HOST.test(url.hostname))) {
    return void 0;
  }
  if (!/\.jpe?g$/i.test(url.pathname)) {
    url.pathname += ".jpg";
  }
  return url.toString();
}
function snapshotPaths(accountId, networkId, kind, deviceId) {
  const network = `/network/${networkId}`;
  const account = `/api/v1/accounts/${accountId}/networks/${networkId}`;
  const camera = `${network}/camera/${deviceId}/thumbnail`;
  if (kind === "camera") {
    return [camera, `${network}/cameras/${deviceId}/thumbnail`, `${account}/cameras/${deviceId}/thumbnail`];
  }
  const family = kind === "mini" ? "owl" : "doorbell";
  return [
    `${account}/${family}s/${deviceId}/thumbnail`,
    `${account}/${family}/${deviceId}/thumbnail`,
    `${network}/${family}s/${deviceId}/thumbnail`,
    `${network}/${family}/${deviceId}/thumbnail`,
    camera
  ];
}
function headers(session) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "User-Agent": import_constants.UA_APP,
    Accept: "application/json"
  };
}
function check(response, what) {
  checkStatus(response.status, response, what);
}
function checkStatus(status, response, what) {
  if (status === 401) {
    throw new import_errors.SessionExpiredError("access token rejected");
  }
  if (status === 429) {
    throw new import_errors.RateLimitedError(response ? (0, import_http.retryAfterMs)(response) : import_constants.RATE_LIMIT_FALLBACK_S * 1e3);
  }
  if (status === 409) {
    throw new import_errors.BusyError();
  }
  if (status < 200 || status >= 300) {
    throw new import_errors.ApiError(what, status);
  }
}
class RestClient {
  /**
   * @param http - HTTP client
   */
  constructor(http) {
    this.http = http;
  }
  /**
   * Reads networks, Sync Modules and devices.
   *
   * @param session - Logged-in session
   */
  async homescreen(session) {
    const what = "Reading the Blink homescreen";
    const response = await this.http.request(
      `${session.restOrigin}/api/v3/accounts/${session.accountId}/homescreen`,
      { headers: headers(session) }
    );
    check(response, what);
    const homescreen = (0, import_homescreen.parseHomescreen)((0, import_http.parseJson)(response.body));
    if (!homescreen) {
      throw new import_errors.ApiError(`${what} (unexpected answer)`, response.status);
    }
    return homescreen;
  }
  /**
   * Arms or disarms a network: current path of the app first, the older one only if that path is unknown.
   * Only an unknown path is retried, as any other answer may mean the command has arrived.
   *
   * @param session - Logged-in session
   * @param networkId - Network ID
   * @param armed - Requested state
   * @returns Command ID, if Blink gave one
   */
  async setArmed(session, networkId, armed) {
    const action = armed ? "arm" : "disarm";
    return this.command(
      session,
      [
        `/api/v1/accounts/${session.accountId}/networks/${networkId}/state/${action}`,
        `/network/${networkId}/${action}`
      ],
      `Sending ${action} to Blink`
    );
  }
  /**
   * Asks a device for a new image. This wakes a battery camera, so it only runs on request.
   *
   * @param session - Logged-in session
   * @param networkId - Network ID
   * @param kind - Device family
   * @param deviceId - Device ID
   * @returns Command ID, if Blink gave one
   */
  snapshot(session, networkId, kind, deviceId) {
    return this.command(
      session,
      snapshotPaths(session.accountId, networkId, kind, deviceId),
      "Asking Blink for a snapshot"
    );
  }
  /**
   * Downloads the image a "thumbnail" field points to. This does not wake the camera: Blink has the image.
   *
   * @param session - Logged-in session
   * @param thumbnail - Value of the field
   * @returns The JPEG file
   */
  async downloadImage(session, thumbnail) {
    const what = "Downloading a Blink image";
    const url = imageUrl(thumbnail, session.restOrigin);
    if (!url) {
      throw new import_errors.ApiError(`${what} (address outside of Blink)`, 0);
    }
    const response = await this.http.download(
      url,
      { ...headers(session), Accept: "image/jpeg,image/*" },
      IMAGE_MAX_BYTES
    );
    checkStatus(response.status, void 0, what);
    if (response.body[0] !== 255 || response.body[1] !== 216 || response.body[2] !== 255) {
      throw new import_errors.ApiError(`${what} (not a JPEG)`, response.status);
    }
    return response.body;
  }
  /**
   * Sends a command. Only an unknown path tries the next one, as any other answer may mean it has arrived.
   *
   * @param session - Logged-in session
   * @param paths - Paths to try, in this order
   * @param what - Action for the error message
   * @returns Command ID, if Blink gave one
   */
  async command(session, paths, what) {
    var _a;
    let response;
    for (const path of paths) {
      response = await this.http.request(`${session.restOrigin}${path}`, {
        method: "POST",
        headers: { ...headers(session), "Content-Type": "application/json" }
      });
      if (!UNKNOWN_PATH.includes(response.status)) {
        break;
      }
    }
    check(response, what);
    const body = (0, import_http.parseJson)(response.body);
    return (0, import_homescreen.toId)((_a = (0, import_http.field)(body, "id")) != null ? _a : (0, import_http.field)(body, "command_id"));
  }
  /**
   * State of a command.
   *
   * @param session - Logged-in session
   * @param networkId - Network ID
   * @param commandId - Command ID
   */
  async commandStatus(session, networkId, commandId) {
    const response = await this.http.request(`${session.restOrigin}/network/${networkId}/command/${commandId}`, {
      headers: headers(session)
    });
    check(response, "Reading the Blink command status");
    const body = (0, import_http.parseJson)(response.body);
    const status = (0, import_http.field)(body, "status");
    if (typeof status === "number" && status !== 0) {
      return "failed";
    }
    return (0, import_http.field)(body, "complete") === true ? "done" : "running";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  IMAGE_MAX_BYTES,
  RestClient,
  imageUrl
});
//# sourceMappingURL=rest.js.map
