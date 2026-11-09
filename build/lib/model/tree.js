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
var tree_exports = {};
__export(tree_exports, {
  ObjectTree: () => ObjectTree
});
module.exports = __toCommonJS(tree_exports);
const AVAILABLE_KEY = "available";
function common() {
  return [
    { key: "name", name: "Name", type: "string", role: "info.name", get: (item) => item.name },
    {
      key: AVAILABLE_KEY,
      name: "Reported by Blink",
      type: "boolean",
      role: "indicator.reachable",
      get: () => true
    }
  ];
}
const NETWORK_STATES = [
  ...common(),
  { key: "armed", name: "Armed", type: "boolean", role: "switch", write: true, get: (item) => item.armed },
  { key: "armPending", name: "Arm command running", type: "boolean", role: "indicator.working", initial: false },
  {
    key: "armResult",
    name: "Result of the last arm command",
    type: "string",
    role: "text",
    states: { confirmed: "confirmed", rejected: "rejected", unconfirmed: "not confirmed" }
  }
];
const SYNC_STATES = [
  ...common(),
  { key: "networkId", name: "Network ID", type: "number", role: "info", get: (item) => item.networkId },
  { key: "serial", name: "Serial number", type: "string", role: "info.serial", get: (item) => item.serial },
  { key: "status", name: "Status", type: "string", role: "info.status", get: (item) => item.status },
  {
    key: "localStorageEnabled",
    name: "Local storage enabled",
    type: "boolean",
    role: "indicator",
    get: (item) => item.localStorageEnabled
  },
  {
    key: "localStorageStatus",
    name: "Local storage status",
    type: "string",
    role: "info.status",
    get: (item) => item.localStorageStatus
  }
];
const DEVICE_STATES = [
  ...common(),
  { key: "kind", name: "Device family", type: "string", role: "info", get: (item) => item.kind },
  { key: "type", name: "Model", type: "string", role: "info", get: (item) => item.type },
  { key: "networkId", name: "Network ID", type: "number", role: "info", get: (item) => item.networkId },
  { key: "serial", name: "Serial number", type: "string", role: "info.serial", get: (item) => item.serial },
  { key: "status", name: "Status", type: "string", role: "info.status", get: (item) => item.status },
  { key: "enabled", name: "Motion detection enabled", type: "boolean", role: "indicator", get: (item) => item.enabled },
  { key: "batteryLow", name: "Battery low", type: "boolean", role: "indicator.lowbat", get: (item) => item.batteryLow },
  { key: "batteryLevel", name: "Battery bars", type: "number", role: "value", get: (item) => item.batteryLevel },
  {
    key: "batteryVoltage",
    name: "Battery voltage",
    type: "number",
    role: "value.voltage",
    unit: "V",
    get: (item) => item.batteryVoltage
  },
  {
    key: "temperature",
    name: "Temperature",
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    get: (item) => item.temperature
  },
  { key: "wifi", name: "Wi-Fi signal bars", type: "number", role: "value", get: (item) => item.wifi },
  { key: "lfr", name: "Signal bars to the Sync Module", type: "number", role: "value", get: (item) => item.lfr },
  { key: "snapshot", name: "Take a snapshot", type: "boolean", role: "button", read: false, write: true },
  { key: "snapshotPending", name: "Snapshot running", type: "boolean", role: "indicator.working", initial: false },
  {
    key: "snapshotResult",
    name: "Result of the last snapshot",
    type: "string",
    role: "text",
    states: {
      confirmed: "new image",
      unconfirmed: "no new image",
      rejected: "failed",
      busy: "Blink is busy",
      offline: "camera offline",
      throttled: "image is still recent"
    }
  },
  { key: "image", name: "Address of the last image", type: "string", role: "url" },
  { key: "imageTime", name: "Time of the last image, 0 if unknown", type: "number", role: "value.time" },
  { key: "imageInfo", name: "Internal data of the last image", type: "string", role: "json" },
  { key: "liveActive", name: "Live image running", type: "boolean", role: "indicator.working", initial: false },
  {
    key: "liveResult",
    name: "State of the live image",
    type: "string",
    role: "text",
    states: {
      running: "running",
      ended: "ended",
      idle: "ended, nobody watched",
      failed: "failed",
      certificate: "certificate of the stream server not accepted",
      noFfmpeg: "ffmpeg not found",
      offline: "camera offline",
      unsupported: "not offered by Blink for this camera",
      disabled: "switched off in the settings",
      busy: "another live image is running",
      rejected: "not possible at the moment"
    }
  }
];
class ObjectTree {
  /**
   * @param host - Adapter functions
   */
  constructor(host) {
    this.host = host;
  }
  objects = /* @__PURE__ */ new Map();
  values = /* @__PURE__ */ new Map();
  held = /* @__PURE__ */ new Set();
  known;
  /**
   * Writes a homescreen into the tree. Devices Blink no longer reports stay (with their history and
   * scripts referring to them) and get available = false; removing them is the user's decision.
   *
   * @param homescreen - Current homescreen
   */
  async apply(homescreen) {
    var _a;
    const seen = /* @__PURE__ */ new Set();
    await this.section("networks", "Networks", homescreen.networks, NETWORK_STATES, seen);
    await this.section("syncModules", "Sync Modules", homescreen.syncModules, SYNC_STATES, seen);
    await this.section("cameras", "Cameras", homescreen.devices, DEVICE_STATES, seen);
    (_a = this.known) != null ? _a : this.known = new Set(await this.host.listDevices());
    for (const id of this.known) {
      if (!seen.has(id) && await this.setValue(`${id}.${AVAILABLE_KEY}`, false)) {
        this.host.info(`${id} is no longer reported by Blink`);
      }
    }
    for (const id of seen) {
      this.known.add(id);
    }
  }
  async section(folder, folderName, items, defs, seen) {
    var _a, _b;
    if (items.length > 0) {
      await this.ensureObject(folder, { type: "folder", common: { name: folderName }, native: {} });
    }
    for (const item of items) {
      const base = `${folder}.${item.id}`;
      seen.add(base);
      await this.ensureObject(base, { type: "device", common: { name: item.name }, native: {} });
      for (const def of defs) {
        const id = `${base}.${def.key}`;
        const value = def.get ? def.get(item) : this.values.has(id) ? void 0 : def.initial;
        if (value === void 0 && def.get) {
          continue;
        }
        await this.ensureObject(id, {
          type: "state",
          common: {
            name: def.name,
            type: def.type,
            role: def.role,
            read: (_a = def.read) != null ? _a : true,
            write: (_b = def.write) != null ? _b : false,
            ...def.unit ? { unit: def.unit } : {},
            ...def.states ? { states: def.states } : {}
          },
          native: {}
        });
        if (value !== void 0) {
          await this.setValue(id, value);
        }
      }
    }
  }
  async ensureObject(id, object) {
    const signature = JSON.stringify(object);
    if (this.objects.get(id) !== signature) {
      await this.host.writeObject(id, object);
      this.objects.set(id, signature);
    }
  }
  /**
   * Last value written to a state.
   *
   * @param id - Relative state ID
   */
  value(id) {
    return this.values.get(id);
  }
  /**
   * Keeps polled values away from a state while a command is running on it.
   *
   * @param id - Relative state ID
   */
  hold(id) {
    this.held.add(id);
  }
  /**
   * Ends hold(). The value is written even if it equals the last one: it has to replace the
   * user's unacknowledged request.
   *
   * @param id - Relative state ID
   * @param value - Real value; if unknown the state stays as it is until the next poll
   */
  async release(id, value) {
    this.held.delete(id);
    this.values.delete(id);
    if (value !== void 0) {
      await this.setValue(id, value);
    }
  }
  /**
   * Writes a state with ack: true if its value has changed.
   *
   * @param id - Relative state ID
   * @param value - New value
   * @returns The value was written
   */
  async setValue(id, value) {
    if (this.held.has(id) || this.values.get(id) === value) {
      return false;
    }
    await this.host.writeState(id, value);
    this.values.set(id, value);
    return true;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ObjectTree
});
//# sourceMappingURL=tree.js.map
