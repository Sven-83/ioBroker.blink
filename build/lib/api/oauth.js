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
var oauth_exports = {};
__export(oauth_exports, {
  OAuthFlow: () => OAuthFlow,
  codeFromLocation: () => codeFromLocation,
  extractCsrf: () => extractCsrf,
  maskDestination: () => maskDestination,
  newHardwareId: () => newHardwareId,
  newPkcePair: () => newPkcePair,
  pkceChallenge: () => pkceChallenge
});
module.exports = __toCommonJS(oauth_exports);
var import_node_crypto = require("node:crypto");
var import_constants = require("./constants");
var import_errors = require("./errors");
var import_http = require("./http");
const BROWSER_HEADERS = {
  "User-Agent": import_constants.UA_BROWSER,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};
function newHardwareId() {
  return (0, import_node_crypto.randomUUID)().toUpperCase();
}
function newPkcePair() {
  const verifier = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}
function pkceChallenge(verifier) {
  return (0, import_node_crypto.createHash)("sha256").update(verifier).digest("base64url");
}
function maskDestination(value) {
  if (typeof value !== "string" || !value) {
    return void 0;
  }
  const at = value.indexOf("@");
  if (at > 0) {
    return `${value[0]}***${value.slice(at)}`.replace(/@[^.]+/, "@***");
  }
  return value.length > 5 ? `${value.slice(0, 3)}******${value.slice(-2)}` : "***";
}
function extractCsrf(html) {
  const script = html.match(/<script[^>]*id=["']oauth-args["'][^>]*>([\s\S]*?)<\/script>/i);
  if (script) {
    const token = (0, import_http.field)((0, import_http.parseJson)(script[1]), "csrf-token");
    if (typeof token === "string" && token) {
      return token;
    }
  }
  const json = html.match(/"csrf-token"\s*:\s*"([^"]+)"/);
  if (json) {
    return json[1];
  }
  const input = html.match(/name=["']csrf-token["'][^>]*value=["']([^"']+)["']/);
  return input == null ? void 0 : input[1];
}
function codeFromLocation(location) {
  if (!location) {
    return void 0;
  }
  const match = location.match(/[?&]code=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : void 0;
}
function authorizeQuery(challenge, hardwareId) {
  return new URLSearchParams({
    app_brand: import_constants.APP_BRAND,
    app_version: import_constants.APP_VERSION,
    client_id: import_constants.CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    device_brand: import_constants.DEVICE_BRAND,
    device_model: import_constants.DEVICE_MODEL,
    device_os_version: import_constants.DEVICE_OS_VERSION,
    hardware_id: hardwareId,
    redirect_uri: import_constants.REDIRECT_URI,
    response_type: "code",
    scope: import_constants.SCOPE
  }).toString();
}
function oauthPath(location) {
  if (location.startsWith("/")) {
    return location;
  }
  try {
    const url = new URL(location);
    return url.origin === import_constants.OAUTH_ORIGIN ? `${url.pathname}${url.search}` : void 0;
  } catch {
    return void 0;
  }
}
function retryAfterMs(response) {
  const seconds = Number((0, import_http.field)((0, import_http.parseJson)(response.body), "next_time_in_secs"));
  return (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : import_constants.RATE_LIMIT_FALLBACK_S) * 1e3;
}
function isTwoFactorChallenge(response) {
  if (response.status === 412) {
    return true;
  }
  if (response.status !== 202) {
    return false;
  }
  const body = (0, import_http.parseJson)(response.body);
  return Array.isArray((0, import_http.field)(body, "tsv_methods")) || (0, import_http.field)(body, "tsv_state") !== void 0;
}
function challengeOf(response) {
  var _a;
  const body = (0, import_http.parseJson)(response.body);
  const channel = (0, import_http.field)(body, "tsv_state");
  const next = Number((0, import_http.field)(body, "next_time_in_secs"));
  return {
    channel: typeof channel === "string" ? channel : void 0,
    destination: maskDestination((_a = (0, import_http.field)(body, "phone")) != null ? _a : (0, import_http.field)(body, "email")),
    nextCodeInS: Number.isFinite(next) && next > 0 ? next : void 0
  };
}
class OAuthFlow {
  /**
   * @param http - HTTP client
   */
  constructor(http) {
    this.http = http;
  }
  /**
   * Steps 1-3: authorize, sign-in page, credentials. Returns tokens or a pending 2FA login.
   *
   * @param email - Account e-mail
   * @param password - Account password
   * @param hardwareId - Stored hardware ID (new one if missing)
   */
  async start(email, password, hardwareId) {
    const cookies = new import_http.CookieJar();
    const { verifier, challenge } = newPkcePair();
    const authorize = await this.get(`${import_constants.OAUTH_AUTHORIZE_PATH}?${authorizeQuery(challenge, hardwareId)}`, cookies);
    let signinPath = authorize.location && oauthPath(authorize.location) || import_constants.OAUTH_SIGNIN_PATH;
    let page = await this.get(signinPath, cookies);
    for (let hop = 0; page.status >= 300 && page.status < 400 && page.location && hop < import_constants.MAX_REDIRECTS; hop++) {
      const next = oauthPath(page.location);
      if (!next) {
        break;
      }
      signinPath = next;
      page = await this.get(signinPath, cookies);
    }
    const csrfToken = extractCsrf(page.body);
    if (!csrfToken) {
      throw new import_errors.ApiError("Reading the Blink sign-in page (no CSRF token)", page.status);
    }
    const signin = await this.http.request(`${import_constants.OAUTH_ORIGIN}${signinPath}`, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        Accept: "*/*",
        Origin: import_constants.OAUTH_ORIGIN,
        Referer: `${import_constants.OAUTH_ORIGIN}${signinPath}`
      },
      form: { username: email, password, "csrf-token": csrfToken },
      cookies
    });
    if (signin.status === 429) {
      throw new import_errors.RateLimitedError(retryAfterMs(signin));
    }
    if (isTwoFactorChallenge(signin)) {
      return {
        kind: "twoFactor",
        pending: {
          cookies: cookies.toJSON(),
          csrfToken,
          verifier,
          hardwareId,
          signinPath,
          createdAt: Date.now()
        },
        challenge: challengeOf(signin)
      };
    }
    if (signin.status === 401 || signin.status === 403 || /invalid_user_credentials/i.test(signin.body)) {
      throw new import_errors.CredentialsRejectedError();
    }
    if (signin.status >= 400) {
      throw new import_errors.ApiError("Blink sign-in", signin.status);
    }
    const tokens = await this.finish(cookies, verifier, hardwareId, signin.location);
    return { kind: "tokens", tokens };
  }
  /**
   * Step 3b: sends the 2FA code of a pending login and finishes it.
   *
   * @param pending - Pending login from start()
   * @param pin - 2FA code
   */
  async verifyTwoFactor(pending, pin) {
    const cookies = new import_http.CookieJar(pending.cookies);
    const response = await this.http.request(`${import_constants.OAUTH_ORIGIN}${import_constants.OAUTH_2FA_PATH}`, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        Accept: "*/*",
        Origin: import_constants.OAUTH_ORIGIN,
        Referer: `${import_constants.OAUTH_ORIGIN}${pending.signinPath}`
      },
      form: { "2fa_code": pin, "csrf-token": pending.csrfToken, remember_me: "false" },
      cookies
    });
    if (response.status === 429) {
      throw new import_errors.RateLimitedError(retryAfterMs(response));
    }
    if (response.status >= 400) {
      throw new import_errors.TwoFactorRejectedError(response.status);
    }
    return this.finish(cookies, pending.verifier, pending.hardwareId, response.location);
  }
  /**
   * New tokens from the refresh token.
   *
   * @param refreshToken - Stored refresh token
   * @param hardwareId - Stored hardware ID
   */
  async refresh(refreshToken, hardwareId) {
    const response = await this.http.request(`${import_constants.OAUTH_ORIGIN}${import_constants.OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "User-Agent": import_constants.UA_APP, Accept: "*/*" },
      form: {
        app_brand: import_constants.APP_BRAND,
        client_id: import_constants.CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        hardware_id: hardwareId,
        scope: import_constants.SCOPE
      }
    });
    if (response.status === 429) {
      throw new import_errors.RateLimitedError(retryAfterMs(response));
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new import_errors.SessionExpiredError(`refresh rejected (HTTP ${response.status})`);
    }
    return this.tokensOf(response, "Token refresh", refreshToken);
  }
  /**
   * Account ID and region of the logged-in user.
   *
   * @param accessToken - Access token
   */
  async account(accessToken) {
    const response = await this.http.request(`${import_constants.REST_DEFAULT_ORIGIN}${import_constants.TIER_INFO_PATH}`, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": import_constants.UA_APP, Accept: "application/json" }
    });
    if (response.status === 401) {
      throw new import_errors.SessionExpiredError("access token rejected");
    }
    if (response.status !== 200) {
      throw new import_errors.ApiError("Reading the Blink account", response.status);
    }
    const body = (0, import_http.parseJson)(response.body);
    const accountId = Number((0, import_http.field)(body, "account_id"));
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new import_errors.ApiError("Reading the Blink account (no account ID)", response.status);
    }
    return { accountId, restOrigin: (0, import_constants.restOriginForTier)((0, import_http.field)(body, "tier")) };
  }
  get(path, cookies) {
    return this.http.request(`${import_constants.OAUTH_ORIGIN}${path}`, { headers: BROWSER_HEADERS, cookies });
  }
  /**
   * Steps 4-5: finds the authorization code (redirects, then the bare and the full authorize URL)
   * and exchanges it for tokens.
   *
   * @param cookies - Cookie jar of the login
   * @param verifier - PKCE verifier
   * @param hardwareId - Hardware ID
   * @param location - Location of the sign-in or 2FA answer
   */
  async finish(cookies, verifier, hardwareId, location) {
    const candidates = [
      ...location ? [location] : [],
      import_constants.OAUTH_AUTHORIZE_PATH,
      `${import_constants.OAUTH_AUTHORIZE_PATH}?${authorizeQuery(pkceChallenge(verifier), hardwareId)}`
    ];
    let code;
    for (const candidate of candidates) {
      let target = candidate;
      for (let hop = 0; target && hop <= import_constants.MAX_REDIRECTS && !code; hop++) {
        code = codeFromLocation(target);
        const path = code ? void 0 : oauthPath(target);
        if (!path) {
          break;
        }
        target = (await this.get(path, cookies)).location;
      }
      if (code) {
        break;
      }
    }
    if (!code) {
      throw new import_errors.ApiError("Blink login (no authorization code)", 0);
    }
    const response = await this.http.request(`${import_constants.OAUTH_ORIGIN}${import_constants.OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "User-Agent": import_constants.UA_APP, Accept: "*/*" },
      form: {
        app_brand: import_constants.APP_BRAND,
        client_id: import_constants.CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        hardware_id: hardwareId,
        redirect_uri: import_constants.REDIRECT_URI,
        scope: import_constants.SCOPE
      }
    });
    return this.tokensOf(response, "Token exchange", void 0);
  }
  tokensOf(response, what, previousRefresh) {
    if (response.status !== 200) {
      throw new import_errors.ApiError(what, response.status);
    }
    const body = (0, import_http.parseJson)(response.body);
    const accessToken = (0, import_http.field)(body, "access_token");
    if (typeof accessToken !== "string" || !accessToken) {
      throw new import_errors.ApiError(`${what} (no access token)`, response.status);
    }
    const refreshToken = (0, import_http.field)(body, "refresh_token");
    const expiresIn = Number((0, import_http.field)(body, "expires_in"));
    return {
      accessToken,
      refreshToken: typeof refreshToken === "string" && refreshToken ? refreshToken : previousRefresh,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1e3
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OAuthFlow,
  codeFromLocation,
  extractCsrf,
  maskDestination,
  newHardwareId,
  newPkcePair,
  pkceChallenge
});
//# sourceMappingURL=oauth.js.map
