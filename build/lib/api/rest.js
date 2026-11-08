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
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "User-Agent": import_constants.UA_APP,
          Accept: "application/json"
        }
      }
    );
    if (response.status === 401) {
      throw new import_errors.SessionExpiredError("access token rejected");
    }
    if (response.status === 429) {
      throw new import_errors.RateLimitedError((0, import_http.retryAfterMs)(response));
    }
    if (response.status !== 200) {
      throw new import_errors.ApiError(what, response.status);
    }
    const homescreen = (0, import_homescreen.parseHomescreen)((0, import_http.parseJson)(response.body));
    if (!homescreen) {
      throw new import_errors.ApiError(`${what} (unexpected answer)`, response.status);
    }
    return homescreen;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RestClient
});
//# sourceMappingURL=rest.js.map
