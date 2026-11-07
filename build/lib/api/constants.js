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
var constants_exports = {};
__export(constants_exports, {
  APP_BRAND: () => APP_BRAND,
  APP_VERSION: () => APP_VERSION,
  CLIENT_ID: () => CLIENT_ID,
  DEVICE_BRAND: () => DEVICE_BRAND,
  DEVICE_MODEL: () => DEVICE_MODEL,
  DEVICE_OS_VERSION: () => DEVICE_OS_VERSION,
  MAX_REDIRECTS: () => MAX_REDIRECTS,
  OAUTH_2FA_PATH: () => OAUTH_2FA_PATH,
  OAUTH_AUTHORIZE_PATH: () => OAUTH_AUTHORIZE_PATH,
  OAUTH_ORIGIN: () => OAUTH_ORIGIN,
  OAUTH_SIGNIN_PATH: () => OAUTH_SIGNIN_PATH,
  OAUTH_TOKEN_PATH: () => OAUTH_TOKEN_PATH,
  RATE_LIMIT_FALLBACK_S: () => RATE_LIMIT_FALLBACK_S,
  REDIRECT_URI: () => REDIRECT_URI,
  REQUEST_TIMEOUT_MS: () => REQUEST_TIMEOUT_MS,
  REST_DEFAULT_ORIGIN: () => REST_DEFAULT_ORIGIN,
  SCOPE: () => SCOPE,
  TIER_INFO_PATH: () => TIER_INFO_PATH,
  UA_APP: () => UA_APP,
  UA_BROWSER: () => UA_BROWSER,
  restOriginForTier: () => restOriginForTier
});
module.exports = __toCommonJS(constants_exports);
const OAUTH_ORIGIN = "https://api.oauth.blink.com";
const OAUTH_AUTHORIZE_PATH = "/oauth/v2/authorize";
const OAUTH_SIGNIN_PATH = "/oauth/v2/signin";
const OAUTH_2FA_PATH = "/oauth/v2/2fa/verify";
const OAUTH_TOKEN_PATH = "/oauth/token";
const REST_DEFAULT_ORIGIN = "https://rest-prod.immedia-semi.com";
const TIER_INFO_PATH = "/api/v1/users/tier_info";
const CLIENT_ID = "ios";
const APP_BRAND = "blink";
const APP_VERSION = "50.1";
const SCOPE = "client";
const REDIRECT_URI = "immedia-blink://applinks.blink.com/signin/callback";
const DEVICE_BRAND = "Apple";
const DEVICE_MODEL = "iPhone16,1";
const DEVICE_OS_VERSION = "26.1";
const UA_BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const UA_APP = "Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0";
const REQUEST_TIMEOUT_MS = 15e3;
const MAX_REDIRECTS = 5;
const RATE_LIMIT_FALLBACK_S = 600;
function restOriginForTier(tier) {
  return typeof tier === "string" && /^[a-z0-9]{2,8}$/.test(tier) ? `https://rest-${tier}.immedia-semi.com` : REST_DEFAULT_ORIGIN;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  APP_BRAND,
  APP_VERSION,
  CLIENT_ID,
  DEVICE_BRAND,
  DEVICE_MODEL,
  DEVICE_OS_VERSION,
  MAX_REDIRECTS,
  OAUTH_2FA_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_ORIGIN,
  OAUTH_SIGNIN_PATH,
  OAUTH_TOKEN_PATH,
  RATE_LIMIT_FALLBACK_S,
  REDIRECT_URI,
  REQUEST_TIMEOUT_MS,
  REST_DEFAULT_ORIGIN,
  SCOPE,
  TIER_INFO_PATH,
  UA_APP,
  UA_BROWSER,
  restOriginForTier
});
//# sourceMappingURL=constants.js.map
