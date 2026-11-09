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
var arm_queue_exports = {};
__export(arm_queue_exports, {
  ARM_READBACK_MS: () => ARM_READBACK_MS,
  ArmQueue: () => ArmQueue,
  BUSY_RETRIES: () => BUSY_RETRIES,
  BUSY_RETRY_MS: () => BUSY_RETRY_MS,
  COMMAND_POLL_MAX: () => COMMAND_POLL_MAX,
  COMMAND_POLL_MS: () => COMMAND_POLL_MS,
  armIds: () => armIds
});
module.exports = __toCommonJS(arm_queue_exports);
var import_errors = require("../api/errors");
const ARM_READBACK_MS = [5e3, 15e3];
const COMMAND_POLL_MS = 1e3;
const COMMAND_POLL_MAX = 10;
const BUSY_RETRY_MS = 5e3;
const BUSY_RETRIES = 2;
function armIds(networkId) {
  const base = `networks.${networkId}`;
  return { armed: `${base}.armed`, pending: `${base}.armPending`, result: `${base}.armResult` };
}
class ArmQueue {
  /**
   * @param host - Adapter functions
   * @param tree - Object tree
   */
  constructor(host, tree) {
    this.host = host;
    this.tree = tree;
  }
  networks = /* @__PURE__ */ new Map();
  /**
   * Requests a state. Runs right away, or after the running command of this network.
   *
   * @param networkId - Network ID
   * @param armed - Requested state
   */
  async request(networkId, armed) {
    const entry = this.networks.get(networkId);
    if (entry) {
      entry.next = armed === entry.running ? void 0 : armed;
      return;
    }
    const created = { running: armed, next: void 0 };
    this.networks.set(networkId, created);
    await this.drain(networkId, created);
  }
  /**
   * Puts back the last known state after an invalid request.
   *
   * @param networkId - Network ID
   */
  async restore(networkId) {
    if (!this.networks.has(networkId)) {
      const { armed } = armIds(networkId);
      await this.tree.release(armed, this.known(armed));
    }
  }
  async drain(networkId, entry) {
    var _a;
    const ids = armIds(networkId);
    this.tree.hold(ids.armed);
    try {
      await this.tree.setValue(ids.pending, true);
      await this.tree.setValue(ids.result, "");
      for (; ; ) {
        const armed = entry.running;
        const outcome = await this.execute(networkId, armed, entry);
        if (entry.next === void 0) {
          this.networks.delete(networkId);
          await this.tree.release(ids.armed, (_a = outcome.actual) != null ? _a : this.known(ids.armed));
          await this.tree.setValue(ids.result, outcome.result);
          await this.tree.setValue(ids.pending, false);
          this.report(networkId, armed, outcome.result);
          return;
        }
        entry.running = entry.next;
        entry.next = void 0;
      }
    } catch (err) {
      this.networks.delete(networkId);
      await this.tree.release(ids.armed, void 0);
      throw err;
    }
  }
  async execute(networkId, armed, entry) {
    var _a, _b;
    const known = this.known(armIds(networkId).armed);
    if (!this.host.online()) {
      this.host.warn(`Network ${networkId}: not connected to Blink, command dropped`);
      return { result: "rejected", actual: known };
    }
    let commandId;
    try {
      commandId = await this.send(networkId, armed);
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.warn(`Network ${networkId}: command failed: ${(0, import_errors.describeError)(err)}`);
      const actual2 = await this.read(networkId);
      return { result: actual2 === armed ? "confirmed" : "rejected", actual: actual2 != null ? actual2 : known };
    }
    const accepted = Date.now();
    let actual = known;
    if (commandId !== void 0) {
      const status = await this.followCommand(networkId, commandId);
      if (status !== "running") {
        actual = (_a = await this.read(networkId)) != null ? _a : actual;
        if (actual === armed) {
          return { result: "confirmed", actual };
        }
        if (status === "failed") {
          return { result: "rejected", actual };
        }
      }
    }
    for (const delay of ARM_READBACK_MS) {
      if (entry.next !== void 0) {
        break;
      }
      await this.host.wait(Math.max(0, accepted + delay - Date.now()));
      actual = (_b = await this.read(networkId)) != null ? _b : actual;
      if (actual === armed) {
        return { result: "confirmed", actual };
      }
    }
    return { result: "unconfirmed", actual };
  }
  async send(networkId, armed) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.host.send(networkId, armed);
      } catch (err) {
        if (!(err instanceof import_errors.BusyError) || attempt >= BUSY_RETRIES) {
          throw err;
        }
        await this.host.wait(BUSY_RETRY_MS);
      }
    }
  }
  /**
   * Follows a command until it is finished. An error stops the queries: the readback still gives the result.
   *
   * @param networkId - Network ID
   * @param commandId - Command ID
   * @returns The last known status; "running" if it did not finish
   */
  async followCommand(networkId, commandId) {
    for (let attempt = 0; attempt < COMMAND_POLL_MAX; attempt++) {
      await this.host.wait(COMMAND_POLL_MS);
      try {
        const status = await this.host.commandStatus(networkId, commandId);
        if (status !== "running") {
          return status;
        }
      } catch (err) {
        if (err instanceof import_errors.AbortedError) {
          throw err;
        }
        this.host.info(`Network ${networkId}: command status not available: ${(0, import_errors.describeError)(err)}`);
        return "running";
      }
    }
    return "running";
  }
  async read(networkId) {
    try {
      return await this.host.read(networkId);
    } catch (err) {
      if (err instanceof import_errors.AbortedError) {
        throw err;
      }
      this.host.info(`Network ${networkId}: readback failed: ${(0, import_errors.describeError)(err)}`);
      return void 0;
    }
  }
  known(id) {
    const value = this.tree.value(id);
    return typeof value === "boolean" ? value : void 0;
  }
  report(networkId, armed, result) {
    const target = armed ? "armed" : "disarmed";
    if (result === "confirmed") {
      this.host.info(`Network ${networkId} is ${target}`);
    } else if (result === "unconfirmed") {
      this.host.warn(`Network ${networkId}: Blink has not confirmed the change to ${target}`);
    } else {
      this.host.warn(`Network ${networkId}: could not be ${target}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ARM_READBACK_MS,
  ArmQueue,
  BUSY_RETRIES,
  BUSY_RETRY_MS,
  COMMAND_POLL_MAX,
  COMMAND_POLL_MS,
  armIds
});
//# sourceMappingURL=arm-queue.js.map
