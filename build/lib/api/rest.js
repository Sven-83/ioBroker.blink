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
  RestClient: () => RestClient
});
module.exports = __toCommonJS(rest_exports);
var import_constants = require("./constants");
var import_errors = require("./errors");
var import_homescreen = require("./homescreen");
var import_http = require("./http");
const UNKNOWN_PATH = [404, 405, 410];
function headers(session) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "User-Agent": import_constants.UA_APP,
    Accept: "application/json"
  };
}
function check(response, what) {
  if (response.status === 401) {
    throw new import_errors.SessionExpiredError("access token rejected");
  }
  if (response.status === 429) {
    throw new import_errors.RateLimitedError((0, import_http.retryAfterMs)(response));
  }
  if (response.status === 409) {
    throw new import_errors.BusyError();
  }
  if (response.status < 200 || response.status >= 300) {
    throw new import_errors.ApiError(what, response.status);
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
    var _a;
    const action = armed ? "arm" : "disarm";
    const paths = [
      `/api/v1/accounts/${session.accountId}/networks/${networkId}/state/${action}`,
      `/network/${networkId}/${action}`
    ];
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
    check(response, `Sending ${action} to Blink`);
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
    if ((0, import_http.field)(body, "complete") === true) {
      return "done";
    }
    const status = (0, import_http.field)(body, "status");
    return typeof status === "number" && status !== 0 ? "failed" : "running";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RestClient
});
//# sourceMappingURL=rest.js.map
