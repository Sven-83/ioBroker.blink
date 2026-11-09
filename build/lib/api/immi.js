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
var immi_exports = {};
__export(immi_exports, {
  IMMI_KEEPALIVE_MS: () => IMMI_KEEPALIVE_MS,
  ImmiClient: () => ImmiClient,
  buildAuthPacket: () => buildAuthPacket,
  buildMessage: () => buildMessage,
  describeServer: () => describeServer,
  isCertificateError: () => isCertificateError,
  parseImmiServer: () => parseImmiServer,
  pinnedCertificateError: () => pinnedCertificateError
});
module.exports = __toCommonJS(immi_exports);
var import_node_net = require("node:net");
var import_stream_certificate = require("./stream-certificate");
const MAX_PAYLOAD = 10 * 1024 * 1024;
const IMMI_KEEPALIVE_MS = 1e4;
const HEADER_BYTES = 9;
const AUTH_MAGIC = 40;
const TYPE_VIDEO = 0;
const TYPE_PING = 6;
const TYPE_ECHO = 8;
const TYPE_KEEPALIVE = 10;
const TYPE_ROUNDTRIP = 16;
const TYPE_ROUNDTRIP_ACK = 17;
const BLINK_HOST = /(^|\.)immedia-semi\.com$/;
function isPublicIpv4(host) {
  if ((0, import_node_net.isIP)(host) !== 4) {
    return false;
  }
  const [first, second] = host.split(".").map(Number);
  const isPrivate = first === 0 || first === 10 || first === 127 || first >= 224 || first === 100 && second >= 64 && second <= 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
  return !isPrivate;
}
function pinnedCertificateError(certificate, expected = import_stream_certificate.STREAM_CERT_FINGERPRINT) {
  const plain = (value) => value.replaceAll(":", "").toUpperCase();
  if (certificate.fingerprint256 && plain(certificate.fingerprint256) === plain(expected)) {
    return void 0;
  }
  return Object.assign(new Error("The stream server does not have the known certificate"), {
    code: "CERT_PIN_MISMATCH"
  });
}
function parseImmiServer(uri) {
  if (typeof uri !== "string" || !/^immis:\/\//i.test(uri)) {
    return void 0;
  }
  let url;
  try {
    url = new URL(uri);
  } catch {
    return void 0;
  }
  const transaction = decodeURIComponent(url.pathname.replace(/^\/+/, "")).split("__")[0];
  const clientId = Number(url.searchParams.get("client_id"));
  const allowed = BLINK_HOST.test(url.hostname) || isPublicIpv4(url.hostname);
  if (!allowed || !transaction || !Number.isInteger(clientId) || clientId <= 0) {
    return void 0;
  }
  return { host: url.hostname, port: Number(url.port) || 443, transaction, clientId };
}
function describeServer(uri) {
  var _a, _b, _c;
  if (typeof uri !== "string") {
    return `no text (${typeof uri})`;
  }
  const scheme = (_c = (_b = (_a = uri.match(/^([a-z][a-z0-9+.-]*):\/\//i)) == null ? void 0 : _a[1]) == null ? void 0 : _b.toLowerCase()) != null ? _c : "none";
  try {
    const url = new URL(uri);
    const domain = url.hostname.split(".").slice(-2).join(".");
    const query = [...url.searchParams.keys()].filter((key) => /^[a-z_]{1,20}$/i.test(key)).join(",") || "-";
    return `scheme ${scheme}, domain ${domain}, port ${url.port || "-"}, separator ${url.pathname.includes("__")}, query ${query}`;
  } catch {
    return `scheme ${scheme}, not readable as an address`;
  }
}
function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}
function buildAuthPacket(server, token, serial) {
  const tokenBytes = Buffer.from(token, "utf8");
  const transaction = Buffer.from(server.transaction, "utf8");
  const serialBytes = Buffer.from(serial, "utf8");
  return Buffer.concat([
    u32(AUTH_MAGIC),
    u32(serialBytes.length),
    serialBytes,
    u32(server.clientId),
    Buffer.from([1, 8]),
    u32(tokenBytes.length),
    tokenBytes,
    Buffer.alloc(42),
    u32(transaction.length),
    transaction,
    u32(1)
  ]);
}
function buildMessage(type, id, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([type & 255]), u32(id), u32(payload.length), payload]);
}
class ImmiClient {
  /**
   * @param options - Client options
   */
  constructor(options) {
    this.options = options;
  }
  socket;
  buffer = Buffer.alloc(0);
  keepalive;
  keepaliveId = 0;
  closed = false;
  error;
  /** Connects. The token is sent when the connection is verified, not before */
  open() {
    const { server, token, serial, connect } = this.options;
    const socket = connect(server.host, server.port, () => {
      socket.write(buildAuthPacket(server, token, serial));
      this.sendKeepalive();
    });
    this.socket = socket;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (err) => {
      var _a;
      (_a = this.error) != null ? _a : this.error = err;
    });
    socket.on("close", () => this.finish());
  }
  /** Ends the connection */
  close() {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.destroy();
    this.finish();
  }
  finish() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.options.clearTimer(this.keepalive);
    this.options.onClose(this.error);
  }
  sendKeepalive() {
    var _a;
    if (this.closed) {
      return;
    }
    (_a = this.socket) == null ? void 0 : _a.write(buildMessage(TYPE_KEEPALIVE, this.keepaliveId++));
    this.options.clearTimer(this.keepalive);
    this.keepalive = this.options.setTimer(() => this.sendKeepalive(), IMMI_KEEPALIVE_MS);
  }
  receive(chunk) {
    var _a;
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_PAYLOAD) {
        (_a = this.error) != null ? _a : this.error = new Error("Blink stream is out of step");
        this.close();
        return;
      }
      if (this.buffer.length < HEADER_BYTES + length) {
        return;
      }
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      this.handle(type, id, payload);
    }
  }
  handle(type, id, payload) {
    var _a, _b;
    if (type === TYPE_VIDEO) {
      this.options.onVideo(payload);
    } else if (type === TYPE_PING) {
      this.sendKeepalive();
    } else if (type === TYPE_ECHO) {
      (_a = this.socket) == null ? void 0 : _a.write(buildMessage(TYPE_ECHO, id));
    } else if (type === TYPE_ROUNDTRIP) {
      (_b = this.socket) == null ? void 0 : _b.write(buildMessage(TYPE_ROUNDTRIP_ACK, id));
    }
  }
}
function isCertificateError(err) {
  const code = err && "code" in err ? err.code : void 0;
  return typeof code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME/.test(code);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  IMMI_KEEPALIVE_MS,
  ImmiClient,
  buildAuthPacket,
  buildMessage,
  describeServer,
  isCertificateError,
  parseImmiServer,
  pinnedCertificateError
});
//# sourceMappingURL=immi.js.map
