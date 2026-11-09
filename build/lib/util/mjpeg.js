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
var mjpeg_exports = {};
__export(mjpeg_exports, {
  FrameSplitter: () => FrameSplitter
});
module.exports = __toCommonJS(mjpeg_exports);
const MAX_BUFFER = 8 * 1024 * 1024;
const START = Buffer.from([255, 216]);
const END = Buffer.from([255, 217]);
class FrameSplitter {
  buffer = Buffer.alloc(0);
  /**
   * Takes the next data.
   *
   * @param chunk - Data of ffmpeg
   * @returns The images that are complete now
   */
  push(chunk) {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    for (; ; ) {
      const start = this.buffer.indexOf(START);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      const end = this.buffer.indexOf(END, start + START.length);
      if (end < 0) {
        this.buffer = this.buffer.subarray(start);
        break;
      }
      frames.push(this.buffer.subarray(start, end + END.length));
      this.buffer = this.buffer.subarray(end + END.length);
    }
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = Buffer.alloc(0);
    }
    return frames;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FrameSplitter
});
//# sourceMappingURL=mjpeg.js.map
