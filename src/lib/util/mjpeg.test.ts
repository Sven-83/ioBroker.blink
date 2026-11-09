import { expect } from 'chai';
import { FrameSplitter } from './mjpeg';

const jpeg = (content: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(content), Buffer.from([0xff, 0xd9])]);

describe('util/mjpeg FrameSplitter', () => {
    it('finds whole images', () => {
        const frames = new FrameSplitter().push(Buffer.concat([jpeg('a'), jpeg('b')]));
        expect(frames).to.deep.equal([jpeg('a'), jpeg('b')]);
    });

    it('joins an image that arrives in pieces', () => {
        const splitter = new FrameSplitter();
        const image = jpeg('abc');
        expect(splitter.push(image.subarray(0, 3))).to.deep.equal([]);
        expect(splitter.push(image.subarray(3))).to.deep.equal([image]);
    });

    it('finds markers split over two pieces', () => {
        const splitter = new FrameSplitter();
        const image = jpeg('abc');
        expect(splitter.push(image.subarray(0, image.length - 1))).to.deep.equal([]);
        expect(splitter.push(image.subarray(image.length - 1))).to.deep.equal([image]);
    });

    it('skips data outside of images', () => {
        const splitter = new FrameSplitter();
        expect(splitter.push(Buffer.from('noise'))).to.deep.equal([]);
        expect(splitter.push(Buffer.concat([Buffer.from('noise'), jpeg('a')]))).to.deep.equal([jpeg('a')]);
    });

    it('does not grow without limit', () => {
        const splitter = new FrameSplitter();
        const big = Buffer.alloc(9 * 1024 * 1024, 0x11);
        splitter.push(Buffer.concat([Buffer.from([0xff, 0xd8]), big]));
        expect(splitter.push(jpeg('a'))).to.deep.equal([jpeg('a')]);
    });
});
