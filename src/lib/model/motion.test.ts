import { expect } from 'chai';
import { parseMediaPage, type MediaEntry, type MediaPage } from '../api/media';
import { MEDIA_FIRST_LOOK_MS, MEDIA_OVERLAP_MS, MotionTracker, newestClips, type MotionHost } from './motion';

const T0 = Date.parse('2026-01-01T12:00:00Z');

/**
 * Invented entry of the media list (no real IDs).
 *
 * @param overrides - Fields to change
 */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 100,
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        deleted: false,
        device_id: 11,
        network_id: 1,
        type: 'video',
        source: 'pir',
        thumbnail: '/media/x/thumb',
        media: '/media/x/clip.mp4',
        metadata: '{"pts_length_ms":20000}',
        ...overrides,
    };
}

function entry(overrides: Record<string, unknown> = {}): MediaEntry {
    return parseMediaPage({ media: [raw(overrides)] })!.entries[0];
}

describe('api/media parseMediaPage', () => {
    it('rejects answers without a media list', () => {
        expect(parseMediaPage(undefined)).to.equal(undefined);
        expect(parseMediaPage({ limit: 25 })).to.equal(undefined);
    });

    it('reads an entry with the detections from the metadata text', () => {
        const parsed = entry({
            source: 'cv_motion',
            metadata: '{"pts_length_ms":5000,"cv_detection":["Person","animal"]}',
        });
        expect(parsed).to.deep.include({
            id: 100,
            deviceId: 11,
            networkId: 1,
            createdAt: T0,
            deleted: false,
            type: 'video',
            source: 'cv_motion',
            detections: ['person', 'animal'],
            lengthMs: 5000,
        });
    });

    it('accepts detections as objects and as a metadata object, and drops odd names', () => {
        expect(
            entry({ metadata: { cv_detection: [{ type: 'vehicle' }, 'package', '<b>', 7] } }).detections,
        ).to.deep.equal(['vehicle', 'package']);
        expect(entry({ metadata: null }).detections).to.deep.equal([]);
        expect(entry({ metadata: 'not json' }).lengthMs).to.equal(undefined);
    });

    it('skips entries without ID, device or time and keeps the limit', () => {
        const page = parseMediaPage({
            limit: 25,
            media: [raw(), raw({ id: null }), raw({ device_id: 'x' }), raw({ created_at: 'never' })],
        });
        expect(page?.entries).to.have.length(1);
        expect(page?.limit).to.equal(25);
    });
});

describe('model/motion newestClips', () => {
    it('takes the newest motion clip per device and ignores photos, deleted and already known clips', () => {
        const entries = [
            entry({ id: 1, created_at: new Date(T0).toISOString() }),
            entry({ id: 2, created_at: new Date(T0 + 60_000).toISOString() }),
            entry({ id: 3, created_at: new Date(T0 + 120_000).toISOString(), deleted: true }),
            entry({ id: 4, created_at: new Date(T0 + 180_000).toISOString(), source: 'snapshot' }),
            entry({ id: 5, device_id: 12, created_at: new Date(T0).toISOString() }),
            entry({ id: 6, device_id: 13, created_at: new Date(T0).toISOString() }),
        ];
        const result = newestClips(entries, new Map([[13, T0]]));
        expect([...result.keys()]).to.deep.equal([11, 12]);
        expect(result.get(11)?.id).to.equal(2);
    });
});

describe('model/motion MotionTracker', () => {
    function host(
        pages: MediaPage[],
        times = new Map<number, number>(),
        devices = [11, 12],
    ): MotionHost & {
        reads: { since: number; page: number }[];
        writes: [number, string, string | number][];
    } {
        const reads: { since: number; page: number }[] = [];
        const writes: [number, string, string | number][] = [];
        return {
            reads,
            writes,
            read: (since, page) => {
                reads.push({ since, page });
                return Promise.resolve(pages.shift() ?? { entries: [], limit: 25 });
            },
            readTimes: () => Promise.resolve(times),
            devices: () => new Set(devices),
            write: (deviceId, key, value) => {
                writes.push([deviceId, key, value]);
                return Promise.resolve();
            },
            debug: () => undefined,
        };
    }

    it('writes detection and source before the time, and remembers the clip address only in memory', async () => {
        const h = host([
            { entries: [entry({ source: 'cv_motion', metadata: '{"cv_detection":["person"]}' })], limit: 25 },
        ]);
        const tracker = new MotionTracker(h);
        expect(await tracker.poll(T0 + 1000)).to.equal(1);
        expect(h.writes).to.deep.equal([
            [11, 'motionDetection', 'person'],
            [11, 'motionSource', 'cv_motion'],
            [11, 'motionTime', T0],
        ]);
        expect(tracker.clip(11)).to.deep.include({ id: 100, time: T0, media: '/media/x/clip.mp4' });
    });

    it('looks back one day on the first poll and only a little behind the last poll afterwards', async () => {
        const h = host([]);
        const tracker = new MotionTracker(h);
        await tracker.poll(T0);
        await tracker.poll(T0 + 60_000);
        expect(h.reads.map(read => read.since)).to.deep.equal([
            T0 - MEDIA_FIRST_LOOK_MS - MEDIA_OVERLAP_MS,
            T0 - MEDIA_OVERLAP_MS,
        ]);
    });

    it('starts after a restart at the newest known clip and does not write it again', async () => {
        const h = host([{ entries: [entry()], limit: 25 }], new Map([[11, T0]]));
        const tracker = new MotionTracker(h);
        expect(await tracker.poll(T0 + 5 * 60_000)).to.equal(0);
        expect(h.reads[0].since).to.equal(T0 - MEDIA_OVERLAP_MS);
        expect(h.writes).to.deep.equal([]);
    });

    it('reads further pages only while they are full, at most three', async () => {
        const full = (base: number): MediaPage => ({
            entries: Array.from({ length: 2 }, (_, i) => entry({ id: base + i })),
            limit: 2,
        });
        const h = host([full(1), full(3), full(5), full(7)]);
        await new MotionTracker(h).poll(T0 + 1000);
        expect(h.reads.map(read => read.page)).to.deep.equal([1, 2, 3]);
    });

    it('ignores devices that are not in the homescreen', async () => {
        const h = host([{ entries: [entry({ device_id: 99 })], limit: 25 }]);
        expect(await new MotionTracker(h).poll(T0 + 1000)).to.equal(0);
        expect(h.writes).to.deep.equal([]);
    });

    it('reads the same changes again after a failed write', async () => {
        const h = host([
            { entries: [entry()], limit: 25 },
            { entries: [entry()], limit: 25 },
        ]);
        let fail = true;
        const write = h.write;
        h.write = (...args) => {
            if (fail) {
                fail = false;
                return Promise.reject(new Error('database gone'));
            }
            return write(...args);
        };
        const tracker = new MotionTracker(h);
        await tracker.poll(T0 + 1000).catch(() => undefined);
        expect(await tracker.poll(T0 + 2000)).to.equal(1);
        expect(h.reads[1].since).to.equal(h.reads[0].since);
    });
});
