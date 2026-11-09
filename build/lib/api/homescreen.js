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
var homescreen_exports = {};
__export(homescreen_exports, {
  parseHomescreen: () => parseHomescreen,
  toId: () => toId,
  toVolt: () => toVolt
});
module.exports = __toCommonJS(homescreen_exports);
var import_http = require("./http");
function first(...values) {
  return values.find((value) => value !== void 0 && value !== null);
}
function toId(value) {
  const id = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : void 0;
}
function toNumber(value) {
  if (typeof value === "string" && !value.trim()) {
    return void 0;
  }
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : void 0;
}
function toText(value) {
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value ? value : void 0;
}
function toBoolean(value) {
  return typeof value === "boolean" ? value : void 0;
}
function list(value) {
  return Array.isArray(value) ? value : [];
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function toVolt(value) {
  const raw = toNumber(value);
  if (raw === void 0) {
    return void 0;
  }
  return round(Math.abs(raw) >= 10 ? raw / 100 : raw, 2);
}
function temperature(fahrenheit, celsius) {
  const c = toNumber(celsius);
  if (c !== void 0) {
    return round(c, 1);
  }
  const f = toNumber(fahrenheit);
  return f === void 0 ? void 0 : round((f - 32) * 5 / 9, 1);
}
function parseNetwork(entry) {
  var _a, _b;
  const network = (_a = (0, import_http.field)(entry, "network")) != null ? _a : entry;
  const id = toId(first((0, import_http.field)(network, "id"), (0, import_http.field)(network, "network_id")));
  if (id === void 0) {
    return void 0;
  }
  return {
    id,
    name: (_b = toText((0, import_http.field)(network, "name"))) != null ? _b : String(id),
    armed: toBoolean((0, import_http.field)(network, "armed"))
  };
}
function parseSyncModule(entry, networkId) {
  var _a, _b, _c;
  const sync = (_a = (0, import_http.field)(entry, "sync_module")) != null ? _a : entry;
  const id = toId(first((0, import_http.field)(sync, "id"), (0, import_http.field)(sync, "sync_module_id")));
  if (id === void 0) {
    return void 0;
  }
  return {
    id,
    name: (_b = toText((0, import_http.field)(sync, "name"))) != null ? _b : String(id),
    networkId: (_c = toId((0, import_http.field)(sync, "network_id"))) != null ? _c : networkId,
    serial: toText(first((0, import_http.field)(sync, "serial"), (0, import_http.field)(sync, "serial_number"))),
    status: toText((0, import_http.field)(sync, "status")),
    localStorageEnabled: toBoolean((0, import_http.field)(sync, "local_storage_enabled")),
    localStorageStatus: toText((0, import_http.field)(sync, "local_storage_status"))
  };
}
function parseDevice(entry, kind) {
  var _a, _b;
  const device = (_a = (0, import_http.field)(entry, "device")) != null ? _a : entry;
  const rawStatus = first((0, import_http.field)(entry, "camera_status"), (0, import_http.field)(entry, "status"), (0, import_http.field)(device, "status"));
  const status = typeof rawStatus === "object" ? rawStatus : void 0;
  const signals = first((0, import_http.field)(status, "signals"), (0, import_http.field)(device, "signals"), (0, import_http.field)(entry, "signals"));
  const value = (...keys) => first(...keys.flatMap((key) => [(0, import_http.field)(signals, key), (0, import_http.field)(status, key), (0, import_http.field)(device, key), (0, import_http.field)(entry, key)]));
  const id = toId(first((0, import_http.field)(device, "id"), (0, import_http.field)(device, "camera_id"), (0, import_http.field)(entry, "id")));
  if (id === void 0) {
    return void 0;
  }
  const battery = first((0, import_http.field)(device, "battery"), (0, import_http.field)(entry, "battery"));
  return {
    id,
    kind,
    name: (_b = toText(first((0, import_http.field)(device, "name"), (0, import_http.field)(entry, "name")))) != null ? _b : String(id),
    type: toText(first((0, import_http.field)(device, "type"), (0, import_http.field)(entry, "type"))),
    networkId: toId(value("network_id")),
    serial: toText(value("serial")),
    status: typeof rawStatus === "object" ? void 0 : toText(rawStatus),
    enabled: toBoolean(value("enabled")),
    batteryLow: typeof battery === "string" ? battery.toLowerCase() === "low" : void 0,
    batteryLevel: toNumber(first((0, import_http.field)(signals, "battery"), value("battery_level"))),
    batteryVoltage: toVolt(value("battery_voltage", "battery_volt")),
    temperature: temperature(value("temp", "temperature", "temp_f"), value("temp_c", "temperature_c")),
    wifi: toNumber(value("wifi", "wifi_strength")),
    lfr: toNumber(value("lfr", "lfr_strength"))
  };
}
function parseHomescreen(body) {
  var _a, _b;
  const rawNetworks = (0, import_http.field)(body, "networks");
  if (!Array.isArray(rawNetworks)) {
    return void 0;
  }
  const networks = rawNetworks.map(parseNetwork).filter((item) => item !== void 0);
  const syncById = /* @__PURE__ */ new Map();
  for (const entry of list((0, import_http.field)(body, "sync_modules"))) {
    const sync = parseSyncModule(entry);
    if (sync) {
      syncById.set(sync.id, sync);
    }
  }
  for (const entry of rawNetworks) {
    const network = (_a = (0, import_http.field)(entry, "network")) != null ? _a : entry;
    const nested = first((0, import_http.field)(entry, "sync_module"), (0, import_http.field)(network, "sync_module"));
    const sync = nested === void 0 ? void 0 : parseSyncModule(nested, (_b = parseNetwork(entry)) == null ? void 0 : _b.id);
    if (sync && !syncById.has(sync.id)) {
      syncById.set(sync.id, sync);
    }
  }
  const families = [
    ["cameras", "camera"],
    ["owls", "mini"],
    ["doorbells", "doorbell"]
  ];
  const devices = families.flatMap(
    ([key, kind]) => list((0, import_http.field)(body, key)).map((entry) => parseDevice(entry, kind)).filter((item) => item !== void 0)
  );
  return { networks, syncModules: [...syncById.values()], devices };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseHomescreen,
  toId,
  toVolt
});
//# sourceMappingURL=homescreen.js.map
