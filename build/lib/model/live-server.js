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
var live_server_exports = {};
__export(live_server_exports, {
  LIVE_MAX_CLIENTS: () => LIVE_MAX_CLIENTS,
  LiveServer: () => LiveServer
});
module.exports = __toCommonJS(live_server_exports);
var import_node_crypto = require("node:crypto");
var import_node_http = require("node:http");
const BOUNDARY = "blinklive";
const LIVE_MAX_CLIENTS = 4;
function digest(value) {
  return (0, import_node_crypto.createHash)("sha256").update(value).digest();
}
class LiveServer {
  /**
   * @param onClients - Number of viewers has changed
   */
  constructor(onClients) {
    this.onClients = onClients;
  }
  server;
  clients = /* @__PURE__ */ new Set();
  sockets = /* @__PURE__ */ new Set();
  lastFrame;
  cameraId = 0;
  token = "";
  /**
   * Starts the server for a session.
   *
   * @param options - Where to listen
   * @param cameraId - Camera of the session
   * @param token - Token of the session
   * @returns The TCP port
   */
  async start(options, cameraId, token) {
    this.cameraId = cameraId;
    this.token = token;
    this.lastFrame = void 0;
    const server = (0, import_node_http.createServer)((request, response) => this.handle(request, response));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    return server.address().port;
  }
  /** Ends the session: all viewers are disconnected and the token is gone */
  async stop() {
    const server = this.server;
    this.server = void 0;
    this.token = "";
    this.lastFrame = void 0;
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
  /**
   * Sends an image. A viewer that cannot keep up misses images instead of falling behind.
   *
   * @param frame - JPEG file
   */
  broadcast(frame) {
    this.lastFrame = frame;
    for (const client of this.clients) {
      if (!client.writableNeedDrain) {
        this.send(client, frame);
      }
    }
  }
  send(client, frame) {
    client.write(`--${BOUNDARY}\r
Content-Type: image/jpeg\r
Content-Length: ${frame.length}\r
\r
`);
    client.write(frame);
    client.write("\r\n");
  }
  refuse(response, status) {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end();
  }
  handle(request, response) {
    var _a, _b;
    const url = new URL((_a = request.url) != null ? _a : "/", "http://live.invalid");
    if (request.method !== "GET" || url.pathname !== `/live/${this.cameraId}.mjpeg`) {
      this.refuse(response, 404);
      return;
    }
    const token = (_b = url.searchParams.get("token")) != null ? _b : "";
    if (!this.token || !(0, import_node_crypto.timingSafeEqual)(digest(token), digest(this.token))) {
      this.refuse(response, 401);
      return;
    }
    if (this.clients.size >= LIVE_MAX_CLIENTS) {
      this.refuse(response, 503);
      return;
    }
    response.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store",
      Connection: "close"
    });
    response.flushHeaders();
    this.clients.add(response);
    this.onClients(this.clients.size);
    if (this.lastFrame) {
      this.send(response, this.lastFrame);
    }
    response.on("close", () => {
      if (this.clients.delete(response)) {
        this.onClients(this.clients.size);
      }
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIVE_MAX_CLIENTS,
  LiveServer
});
//# sourceMappingURL=live-server.js.map
