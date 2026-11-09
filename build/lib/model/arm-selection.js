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
var arm_selection_exports = {};
__export(arm_selection_exports, {
  ArmSelection: () => ArmSelection,
  CONTROL_IDS: () => CONTROL_IDS,
  SELECTION_KEY: () => SELECTION_KEY
});
module.exports = __toCommonJS(arm_selection_exports);
const SELECTION_KEY = "armWithAll";
const CONTROL_IDS = { armSelected: "control.armSelected", disarmAll: "control.disarmAll" };
class ArmSelection {
  /**
   * @param host - Adapter functions
   */
  constructor(host) {
    this.host = host;
  }
  selected;
  loading;
  /**
   * Loads the stored choice once and gives networks without a choice the default true.
   *
   * @param networkIds - Networks Blink reports
   */
  async ensure(networkIds) {
    const selected = await this.load();
    for (const id of networkIds) {
      if (!selected.has(id)) {
        await this.host.write(id, true);
        selected.set(id, true);
      }
    }
  }
  /**
   * The user changed the choice of a network. Anything but true or false puts the stored choice back.
   *
   * @param networkId - Network ID
   * @param value - Value written by the user
   */
  async set(networkId, value) {
    var _a;
    const selected = await this.load();
    const next = typeof value === "boolean" ? value : (_a = selected.get(networkId)) != null ? _a : true;
    selected.set(networkId, next);
    await this.host.write(networkId, next);
  }
  /**
   * Network is part of "arm selected". Unknown networks are, like a new network.
   *
   * @param networkId - Network ID
   */
  isSelected(networkId) {
    var _a;
    return ((_a = this.selected) == null ? void 0 : _a.get(networkId)) !== false;
  }
  /**
   * Networks a command switches. Arming skips networks already armed, disarming skips networks known as
   * disarmed; a network with unknown state gets the command.
   *
   * @param command - armSelected or disarmAll
   * @param networks - Networks Blink reports
   */
  targets(command, networks) {
    if (command === "armSelected") {
      return networks.filter((network) => this.isSelected(network.id) && network.armed !== true).map((network) => network.id);
    }
    return networks.filter((network) => network.armed !== false).map((network) => network.id);
  }
  /**
   * Runs a command for several networks. The networks are switched side by side, each with its own readback.
   *
   * @param command - armSelected or disarmAll
   * @param networks - Networks Blink reports
   */
  async run(command, networks) {
    await this.load();
    const ids = this.targets(command, networks);
    const armed = command === "armSelected";
    if (ids.length === 0) {
      this.host.info(armed ? "Arm selected: no selected network is disarmed" : "Disarm all: no network is armed");
      return;
    }
    this.host.info(`${armed ? "Arm selected" : "Disarm all"}: networks ${ids.join(", ")}`);
    const results = await Promise.allSettled(ids.map((id) => this.host.request(id, armed)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  }
  /** Reads the stored choice once; calls during the first read wait for the same read */
  load() {
    var _a;
    (_a = this.loading) != null ? _a : this.loading = this.host.readStored().then((stored) => {
      const selected = /* @__PURE__ */ new Map();
      for (const [id, value] of stored) {
        if (typeof value === "boolean") {
          selected.set(id, value);
        }
      }
      this.selected = selected;
      return selected;
    });
    this.loading.catch(() => this.loading = void 0);
    return this.loading;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ArmSelection,
  CONTROL_IDS,
  SELECTION_KEY
});
//# sourceMappingURL=arm-selection.js.map
