/*
 * Motion clips of the devices (phase 7.2): the newest clip of each device from the media list of the cloud,
 * written to cameras.<id>.motionTime / motionDetection / motionSource. Runs inside the polling chain, reads
 * only entries changed since the last poll and never goes back behind what the states already show, so a
 * restart overwrites nothing.
 *
 * Addresses of clips stay in memory (for the clip download, phase 7.3); they never reach states or the log.
 */

import type { MediaEntry, MediaPage } from '../api/media';

/** Pages read at most per poll (a page has 25 entries) */
export const MEDIA_MAX_PAGES = 3;
/** Read again this far behind the last poll: Blink may report a clip a little later than its time */
export const MEDIA_OVERLAP_MS = 10 * 60 * 1000;
/** Furthest back on the first poll without known times */
export const MEDIA_FIRST_LOOK_MS = 24 * 60 * 60 * 1000;

/** Sources that are a motion clip; "snapshot" is a photo asked for by the user */
const MOTION_SOURCES = new Set(['pir', 'cv_motion']);

/** What the tracker needs from the adapter */
export interface MotionHost {
    /** One page of the media list changed since a time (ms) */
    read(since: number, page: number): Promise<MediaPage>;
    /** motionTime of earlier runs, by device ID */
    readTimes(): Promise<Map<number, number>>;
    /** Devices of the current homescreen */
    devices(): Set<number>;
    /** Writes a state of a device with ack: true */
    write(
        deviceId: number,
        key: 'motionTime' | 'motionDetection' | 'motionSource',
        value: string | number,
    ): Promise<unknown>;
    /** A device has a new motion clip (after its states are written) */
    newClip?(deviceId: number, clip: MotionClip): Promise<unknown>;
    /** Clips deleted at Blink (e.g. in the app), by clip ID */
    deletedClips?(clipIds: Set<number>): Promise<unknown>;
    /** Log message on level debug */
    debug(message: string): void;
}

/** Last motion clip of a device */
export interface MotionClip {
    /** ID of the clip */
    id: number;
    /** Time of the recording (ms) */
    time: number;
    /** What Blink detected */
    detections: string[];
    /** What started it */
    source: string;
    /** Length in ms */
    lengthMs: number | undefined;
    /** Address of the clip at Blink */
    media: string | undefined;
}

/**
 * The entry is a motion clip that is still there.
 *
 * @param entry - Entry of the media list
 */
export function isMotionClip(entry: MediaEntry): boolean {
    return !entry.deleted && entry.type === 'video' && MOTION_SOURCES.has(entry.source);
}

/**
 * Newest motion clip of each device that is newer than the known time.
 *
 * @param entries - Entries of the media list
 * @param known - Time of the last known clip, by device ID
 */
export function newestClips(entries: MediaEntry[], known: Map<number, number>): Map<number, MediaEntry> {
    const newest = new Map<number, MediaEntry>();
    for (const entry of entries) {
        if (!isMotionClip(entry) || entry.createdAt <= (known.get(entry.deviceId) ?? 0)) {
            continue;
        }
        const current = newest.get(entry.deviceId);
        if (!current || entry.createdAt > current.createdAt) {
            newest.set(entry.deviceId, entry);
        }
    }
    return newest;
}

/** Keeps motionTime/motionDetection/motionSource of the devices up to date */
export class MotionTracker {
    private known: Map<number, number> | undefined;
    private since: number | undefined;
    private readonly clips = new Map<number, MotionClip>();

    /**
     * @param host - Adapter functions
     */
    public constructor(private readonly host: MotionHost) {}

    /**
     * Last motion clip of a device seen since the start of the adapter.
     *
     * @param deviceId - Device ID
     */
    public clip(deviceId: number): MotionClip | undefined {
        return this.clips.get(deviceId);
    }

    /**
     * Reads the changes since the last poll and writes the new clips.
     *
     * @param now - Current time
     * @returns Number of devices with a new clip
     */
    public async poll(now: number): Promise<number> {
        this.known ??= await this.host.readTimes();
        if (this.since === undefined) {
            const latest = Math.max(0, ...this.known.values());
            this.since = Math.max(latest, now - MEDIA_FIRST_LOOK_MS);
        }
        const from = this.since - MEDIA_OVERLAP_MS;
        const entries: MediaEntry[] = [];
        for (let page = 1; page <= MEDIA_MAX_PAGES; page++) {
            const result = await this.host.read(from, page);
            entries.push(...result.entries);
            if (result.entries.length === 0 || result.entries.length < (result.limit ?? Infinity)) {
                break;
            }
        }
        const devices = this.host.devices();
        const newest = newestClips(
            entries.filter(entry => devices.has(entry.deviceId)),
            this.known,
        );
        for (const [deviceId, entry] of newest) {
            await this.host.write(deviceId, 'motionDetection', entry.detections.join(','));
            await this.host.write(deviceId, 'motionSource', entry.source);
            // time last: a script that reacts to motionTime finds the other two already set
            await this.host.write(deviceId, 'motionTime', entry.createdAt);
            this.known.set(deviceId, entry.createdAt);
            const clip: MotionClip = {
                id: entry.id,
                time: entry.createdAt,
                detections: entry.detections,
                source: entry.source,
                lengthMs: entry.lengthMs,
                media: entry.media,
            };
            this.clips.set(deviceId, clip);
            await this.host.newClip?.(deviceId, clip);
        }
        const deletedIds = new Set(entries.filter(entry => entry.deleted).map(entry => entry.id));
        if (deletedIds.size > 0) {
            await this.host.deletedClips?.(deletedIds);
        }
        this.since = now;
        const deleted = entries.filter(entry => entry.deleted).length;
        const other = entries.filter(entry => !entry.deleted && !isMotionClip(entry)).length;
        const unknown = entries.filter(entry => !devices.has(entry.deviceId)).length;
        const oldest = entries.length > 0 ? Math.min(...entries.map(entry => entry.createdAt)) : undefined;
        this.host.debug(
            `Media: ${entries.length} entries since the last poll (${deleted} deleted, ${other} no motion clip, ` +
                `${unknown} unknown devices${oldest ? `, oldest ${Math.round((now - oldest) / 60_000)} min ago` : ''}), ` +
                `${newest.size} devices with a new clip`,
        );
        return newest.size;
    }
}
