import { expect } from 'chai';
import { ApiError, RateLimitedError } from '../api/errors';
import { CLIP_ATTEMPTS, ClipStore, clipFileName, type ClipHost } from './clip-store';
import type { MotionClip } from './motion';
import { ObjectTree } from './tree';

const HOUR = 3_600_000;

/**
 * Invented clip (no real IDs).
 *
 * @param id - Clip ID
 * @param time - Time of the recording
 */
function clip(id: number, time = 1_000): MotionClip {
    return { id, time, detections: [], source: 'pir', lengthMs: 20_000, media: `/media/clip-${id}.mp4` };
}

/**
 * Store with a fake adapter.
 *
 * @param options - Stored infos and retention
 * @param options.stored - clipInfo states of an earlier run
 * @param options.retention - Retention in ms
 */
function setup(options: { stored?: Map<number, unknown>; retention?: number } = {}): {
    store: ClipStore;
    files: Map<string, Buffer>;
    states: Map<string, ioBroker.StateValue>;
    downloads: string[];
    warnings: string[];
    responses: Map<string, Buffer | Error>;
} {
    const files = new Map<string, Buffer>();
    const states = new Map<string, ioBroker.StateValue>();
    const downloads: string[] = [];
    const warnings: string[] = [];
    const responses = new Map<string, Buffer | Error>();
    const tree = new ObjectTree({
        writeObject: () => Promise.resolve(),
        writeState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve([]),
        info: () => undefined,
    });
    const host: ClipHost = {
        download: media => {
            downloads.push(media);
            const response = responses.get(media) ?? Buffer.from(`video ${media}`);
            return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
        },
        writeFile: (name, data) => {
            files.set(name, data);
            return Promise.resolve();
        },
        deleteFile: name => {
            if (!files.delete(name)) {
                return Promise.reject(new Error('Not exists'));
            }
            return Promise.resolve();
        },
        readInfos: () => Promise.resolve(options.stored ?? new Map()),
        urlOf: name => `/blink.0/${name}`,
        debug: () => undefined,
        warn: message => warnings.push(message),
    };
    return {
        store: new ClipStore(host, tree, options.retention ?? 24 * HOUR),
        files,
        states,
        downloads,
        warnings,
        responses,
    };
}

describe('model/clip-store', () => {
    it('stores the clip of a device as one file and writes its address and time', async () => {
        const { store, files, states } = setup();
        store.want(11, clip(1, 5_000));
        await store.sync();
        expect(files.get(clipFileName(11))?.toString()).to.equal('video /media/clip-1.mp4');
        expect(states.get('cameras.11.clip')).to.match(/^\/blink\.0\/clips\/11\.mp4\?t=\d+$/);
        expect(states.get('cameras.11.clipTime')).to.equal(5_000);
        expect(JSON.parse(String(states.get('cameras.11.clipInfo')))).to.include({ id: 1, time: 5_000, stored: true });
    });

    it('replaces the file with a newer clip and never with an older one', async () => {
        const { store, downloads } = setup();
        store.want(11, clip(2, 2_000));
        store.want(11, clip(1, 1_000));
        await store.sync();
        expect(downloads).to.deep.equal(['/media/clip-2.mp4']);
    });

    it('does not download a clip that is already stored', async () => {
        const stored = new Map<number, unknown>([
            [11, JSON.stringify({ id: 1, time: 1, savedAt: Date.now(), stored: true })],
        ]);
        const { store, downloads } = setup({ stored });
        store.want(11, clip(1));
        await store.sync();
        expect(downloads).to.deep.equal([]);
    });

    it('tries a clip Blink does not have yet again on the next polls, then gives up with a warning', async () => {
        const { store, downloads, warnings, responses } = setup();
        responses.set('/media/clip-1.mp4', new ApiError('Downloading a Blink clip', 404));
        store.want(11, clip(1));
        for (let poll = 0; poll < CLIP_ATTEMPTS + 2; poll++) {
            await store.sync();
        }
        expect(downloads).to.have.length(CLIP_ATTEMPTS);
        expect(warnings).to.have.length(1);
        expect(warnings[0]).to.contain('Camera 11: clip not downloaded');
    });

    it('stops at a problem of the whole cloud without counting an attempt', async () => {
        const { store, downloads, responses } = setup();
        responses.set('/media/clip-1.mp4', new RateLimitedError(60_000));
        store.want(11, clip(1));
        store.want(12, { ...clip(2), media: '/media/clip-2.mp4' });
        await store.sync();
        expect(downloads).to.deep.equal(['/media/clip-1.mp4']);
        responses.delete('/media/clip-1.mp4');
        await store.sync();
        expect(downloads).to.deep.equal(['/media/clip-1.mp4', '/media/clip-1.mp4', '/media/clip-2.mp4']);
    });

    it('deletes the stored copy when the clip is deleted at Blink, and drops a waiting download', async () => {
        const { store, files, states, downloads } = setup();
        store.want(11, clip(1));
        await store.sync();
        store.want(12, clip(2));
        await store.deleted(new Set([1, 2]));
        expect(files.has(clipFileName(11))).to.equal(false);
        expect(states.get('cameras.11.clip')).to.equal('');
        expect(states.get('cameras.11.clipTime')).to.equal(0);
        await store.sync();
        expect(downloads).to.deep.equal(['/media/clip-1.mp4']);
    });

    it('keeps clips of other IDs when something else is deleted', async () => {
        const { store, files } = setup();
        store.want(11, clip(1));
        await store.sync();
        await store.deleted(new Set([99]));
        expect(files.has(clipFileName(11))).to.equal(true);
    });

    it('deletes clips after the retention period, also those of an earlier run', async () => {
        const old = Date.now() - 25 * HOUR;
        const stored = new Map<number, unknown>([[12, JSON.stringify({ id: 7, time: 1, savedAt: old, stored: true })]]);
        const { store, files, states } = setup({ stored });
        files.set(clipFileName(12), Buffer.from('old'));
        store.want(11, clip(1));
        await store.sync();
        await store.expire(Date.now() + 23 * HOUR);
        expect(files.has(clipFileName(11))).to.equal(true);
        expect(files.has(clipFileName(12))).to.equal(false);
        expect(states.get('cameras.12.clip')).to.equal('');
        await store.expire(Date.now() + 25 * HOUR);
        expect(files.has(clipFileName(11))).to.equal(false);
    });

    it('treats a file that is already gone as deleted and ignores unreadable infos', async () => {
        const stored = new Map<number, unknown>([
            [12, JSON.stringify({ id: 7, time: 1, savedAt: 0, stored: true })],
            [13, '{broken'],
        ]);
        const { store, states } = setup({ stored });
        await store.expire(Date.now());
        expect(JSON.parse(String(states.get('cameras.12.clipInfo')))).to.include({ stored: false });
        expect(states.has('cameras.13.clipInfo')).to.equal(false);
    });
});
