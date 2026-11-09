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
var http_exports = {};
__export(http_exports, {
  CookieJar: () => CookieJar,
  HttpClient: () => HttpClient,
  describeResponse: () => describeResponse,
  field: () => field,
  parseJson: () => parseJson,
  retryAfterMs: () => retryAfterMs
});
module.exports = __toCommonJS(http_exports);
var import_constants = require("./constants");
var import_errors = require("./errors");
class CookieJar {
  cookies = /* @__PURE__ */ new Map();
  /**
   * @param entries - Cookies to start with (restored pending login)
   */
  constructor(entries = {}) {
    for (const [name, value] of Object.entries(entries)) {
      this.cookies.set(name, value);
    }
  }
  /**
   * Stores the cookies of a response.
   *
   * @param headers - Response headers
   */
  update(headers) {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }
  /** Value of the Cookie request header, empty if there are no cookies */
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  /** Plain object for storing a pending login */
  toJSON() {
    return Object.fromEntries(this.cookies);
  }
}
const TRACE_MAX_FIELDS = 300;
const TRACE_FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const TRACE_VALUES = ["complete", "status", "status_code"];
function collectFields(value, path, names) {
  if (names.size >= TRACE_MAX_FIELDS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFields(entry, `${path}[]`, names);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const name = TRACE_FIELD.test(key) ? key : "*";
      collectFields(entry, path ? `${path}.${name}` : name, names);
    }
  } else if (path) {
    names.add(path);
  }
}
function describeResponse(method, url, status, ms, body) {
  const path = new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
  const parsed = parseJson(body);
  const names = /* @__PURE__ */ new Set();
  collectFields(parsed, "", names);
  const values = TRACE_VALUES.flatMap((key) => {
    const value = field(parsed, key);
    return typeof value === "number" || typeof value === "boolean" ? [`${key}=${value}`] : [];
  });
  return `${method} ${path} -> ${status} in ${ms} ms, fields: ${[...names].join(" ") || "-"}${values.length > 0 ? `, values: ${values.join(" ")}` : ""}`;
}
class HttpClient {
  testOrigin;
  timeoutMs;
  signal;
  trace;
  /**
   * @param options - Client options
   */
  constructor(options = {}) {
    var _a;
    this.testOrigin = options.testOrigin;
    this.timeoutMs = (_a = options.timeoutMs) != null ? _a : import_constants.REQUEST_TIMEOUT_MS;
    this.signal = options.signal;
    this.trace = options.trace;
  }
  /**
   * URL as it is really requested (with the test origin, if set).
   *
   * @param url - Absolute https URL of the Blink cloud
   */
  resolve(url) {
    if (!this.testOrigin) {
      return url;
    }
    const parsed = new URL(url);
    return `${this.testOrigin}${parsed.pathname}${parsed.search}`;
  }
  /**
   * Sends a request without following redirects.
   *
   * @param url - Absolute https URL of the Blink cloud
   * @param request - Method, headers, body and cookie jar
   */
  async request(url, request = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if ((_a = this.signal) == null ? void 0 : _a.aborted) {
      throw new import_errors.AbortedError();
    }
    if (!this.testOrigin && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error("TLS certificate checks are switched off in this process, nothing is sent to Blink");
    }
    const headers = { "Accept-Language": "en-US,en;q=0.9", ...request.headers };
    let body;
    if (request.form) {
      body = new URLSearchParams(request.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (request.json !== void 0) {
      body = JSON.stringify(request.json);
      headers["Content-Type"] = "application/json";
    }
    const cookie = (_b = request.cookies) == null ? void 0 : _b.header();
    if (cookie) {
      headers.Cookie = cookie;
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const started = Date.now();
    let response;
    try {
      response = await fetch(this.resolve(url), {
        method: (_c = request.method) != null ? _c : "GET",
        headers,
        body,
        redirect: "manual",
        signal
      });
    } catch (err) {
      if ((_d = this.signal) == null ? void 0 : _d.aborted) {
        throw new import_errors.AbortedError();
      }
      throw err;
    }
    (_e = request.cookies) == null ? void 0 : _e.update(response.headers);
    const text = await response.text();
    (_g = this.trace) == null ? void 0 : _g.call(this, describeResponse((_f = request.method) != null ? _f : "GET", url, response.status, Date.now() - started, text));
    return {
      status: response.status,
      headers: response.headers,
      body: text,
      location: (_h = response.headers.get("location")) != null ? _h : void 0
    };
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function field(value, key) {
  return value !== null && typeof value === "object" ? value[key] : void 0;
}
function retryAfterMs(response) {
  for (const raw of [response.headers.get("retry-after"), field(parseJson(response.body), "next_time_in_secs")]) {
    const seconds = Number(raw);
    if (raw !== null && Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds) * 1e3;
    }
  }
  return import_constants.RATE_LIMIT_FALLBACK_S * 1e3;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CookieJar,
  HttpClient,
  describeResponse,
  field,
  parseJson,
  retryAfterMs
});
//# sourceMappingURL=http.js.map
