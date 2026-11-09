/*
 * Finds the single images in the output of ffmpeg, so that each viewer always starts with a whole image.
 */

/** Larger buffers are no image: the data are thrown away */
const MAX_BUFFER = 8 * 1024 * 1024;
const START = Buffer.from([0xff, 0xd8]);
const END = Buffer.from([0xff, 0xd9]);

/** Splits a stream of JPEG files */
export class FrameSplitter {
    private buffer: Buffer = Buffer.alloc(0);

    /**
     * Takes the next data.
     *
     * @param chunk - Data of ffmpeg
     * @returns The images that are complete now
     */
    public push(chunk: Buffer): Buffer[] {
        this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
        const frames: Buffer[] = [];
        for (;;) {
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
