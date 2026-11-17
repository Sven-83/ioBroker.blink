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
var auto_snapshot_exports = {};
__export(auto_snapshot_exports, {
  AUTO_SNAPSHOT_MAX_WAIT_MS: () => AUTO_SNAPSHOT_MAX_WAIT_MS,
  AUTO_SNAPSHOT_RETRY_MS: () => AUTO_SNAPSHOT_RETRY_MS,
  nextAutoSnapshot: () => nextAutoSnapshot
});
module.exports = __toCommonJS(auto_snapshot_exports);
const DAY_MS = 24 * 36e5;
const DUE_SLACK_MS = 12 * 36e5;
const AUTO_SNAPSHOT_MAX_WAIT_MS = DAY_MS;
const AUTO_SNAPSHOT_RETRY_MS = 6e4;
function slotFrom(from, plan) {
  const candidate = new Date(from);
  candidate.setHours(plan.hour, plan.minute, 0, 0);
  while (candidate.getDay() !== plan.day || candidate.getTime() < from) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(plan.hour, plan.minute, 0, 0);
  }
  return candidate.getTime();
}
function nextAutoSnapshot(now, lastRun, plan) {
  if (plan.weeks <= 0) {
    return void 0;
  }
  if (!lastRun || lastRun <= 0) {
    const slot2 = slotFrom(now, plan);
    return { slot: slot2, runAt: slot2 };
  }
  let slot = slotFrom(lastRun + plan.weeks * 7 * DAY_MS - DUE_SLACK_MS, plan);
  if (slot > now) {
    return { slot, runAt: slot };
  }
  for (; ; ) {
    const following = new Date(slot);
    following.setDate(following.getDate() + plan.weeks * 7);
    if (following.getTime() > now) {
      break;
    }
    slot = following.getTime();
  }
  return { slot, runAt: now };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AUTO_SNAPSHOT_MAX_WAIT_MS,
  AUTO_SNAPSHOT_RETRY_MS,
  nextAutoSnapshot
});
//# sourceMappingURL=auto-snapshot.js.map
