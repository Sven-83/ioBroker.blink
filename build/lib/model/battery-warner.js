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
var battery_warner_exports = {};
__export(battery_warner_exports, {
  BATTERY_REPEAT_MS: () => BATTERY_REPEAT_MS,
  BATTERY_STATE: () => BATTERY_STATE,
  BatteryWarner: () => BatteryWarner,
  batteryTestText: () => batteryTestText,
  batteryText: () => batteryText
});
module.exports = __toCommonJS(battery_warner_exports);
var import_errors = require("../api/errors");
const BATTERY_STATE = "info.batteryWarnings";
const BATTERY_REPEAT_MS = 24 * 36e5;
function batteryText(german, device, network) {
  const where = network ? ` (${network})` : "";
  return german ? `Blink: Batterie schwach bei \u201E${device}\u201C${where}. Bitte bald wechseln.` : `Blink: battery low on "${device}"${where}. Please replace it soon.`;
}
function batteryTestText(german) {
  return german ? "Blink: Testnachricht. Batteriewarnungen kommen hier an." : "Blink: test message. Battery warnings arrive here.";
}
class BatteryWarner {
  /**
   * @param host - Adapter functions
   * @param german - Language of the messages is German
   */
  constructor(host, german) {
    this.host = host;
    this.german = german;
  }
  entries;
  failing = false;
  /**
   * Checks the devices of a homescreen. A failed message is tried again on the next poll.
   *
   * @param homescreen - Current homescreen
   * @param now - Current time
   */
  async check(homescreen, now = Date.now()) {
    var _a;
    const entries = await this.load();
    let changed = false;
    for (const [id, entry] of entries) {
      if (!entry.active && now - entry.at >= BATTERY_REPEAT_MS) {
        entries.delete(id);
        changed = true;
      }
    }
    for (const device of homescreen.devices) {
      const entry = entries.get(device.id);
      if (device.batteryLow === false) {
        if (entry == null ? void 0 : entry.active) {
          entry.active = false;
          changed = true;
        }
        continue;
      }
      if (device.batteryLow !== true || (entry == null ? void 0 : entry.active) || entry && now - entry.at < BATTERY_REPEAT_MS) {
        continue;
      }
      const network = (_a = homescreen.networks.find((item) => item.id === device.networkId)) == null ? void 0 : _a.name;
      try {
        await this.host.send(batteryText(this.german, device.name, network));
      } catch (err) {
        if (err instanceof import_errors.AbortedError) {
          throw err;
        }
        const message = `Battery warning not sent: ${(0, import_errors.describeError)(err)}. Next attempt on the next poll`;
        if (this.failing) {
          this.host.debug(message);
        } else {
          this.failing = true;
          this.host.warn(message);
        }
        break;
      }
      this.failing = false;
      entries.set(device.id, { at: now, active: true });
      changed = true;
      this.host.info(`Camera ${device.id}: battery warning sent`);
    }
    if (changed) {
      await this.host.write(JSON.stringify(Object.fromEntries(entries)));
    }
  }
  async load() {
    if (!this.entries) {
      const entries = /* @__PURE__ */ new Map();
      const stored = await this.host.read();
      try {
        const parsed = typeof stored === "string" && stored ? JSON.parse(stored) : {};
        for (const [key, value] of Object.entries(parsed)) {
          const id = Number(key);
          const entry = value;
          if (Number.isSafeInteger(id) && typeof (entry == null ? void 0 : entry.at) === "number" && typeof entry.active === "boolean") {
            entries.set(id, { at: entry.at, active: entry.active });
          }
        }
      } catch {
      }
      this.entries = entries;
    }
    return this.entries;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BATTERY_REPEAT_MS,
  BATTERY_STATE,
  BatteryWarner,
  batteryTestText,
  batteryText
});
//# sourceMappingURL=battery-warner.js.map
