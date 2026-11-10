/*
 * Last motion clip of each device in the file storage of the adapter (phase 7.3): clips/<id>.mp4, one file per
 * device, a new clip replaces the old one. The states only hold the address of the file (clip, clipTime).
 * Clips are personal data: deleted after the retention period (audit B.10.22) and as soon as the clip is
 * deleted at Blink (e.g. in the app), because only clips that still exist count (Sven 10.11.2026).
 *
 * Blink may need a moment after a recording before the clip can be downloaded: a failed download is tried
 * again on the next polls, a few times at most.
 */

import { AbortedError, ApiError, describeError } from '../api/errors';
import type { MotionClip } from './motion';
import type { ObjectTree } from './tree';

/** Attempts per clip (one per poll) */
export const CLIP_ATTEMPTS = 3;

/** What the store needs from the adapter */
export interface ClipHost {
    /** Downloads a clip from Blink */
    download(media: string): Promise<Buffer>;
    /** Writes a file into the storage of the instance */
    writeFile(name: string, data: Buffer): Promise<unknown>;
    /** Deletes a file from the storage of the instance */
    deleteFile(name: string): Promise<unknown>;
    /** All clipInfo states of earlier runs, by device ID */
    readInfos(): Promise<Map<number, unknown>>;
    /** Address of a file of the instance, as seen from the web adapter */
    urlOf(name: string): string;
    /** Log message on level debug */
    debug(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

/** What is known about the stored clip of a device */
interface ClipInfo {
    /** ID of the clip at Blink */
    id: number;
    /** Time of the recording */
    time: number;
    /** Time of the download */
    savedAt: number;
    /** The file exists */
    stored: boolean;
}

/** A clip waiting for its download */
interface Wanted {
    clip: MotionClip;
    attempts: number;
}

/**
 * File of the last clip.
 *
 * @param deviceId - Device ID
 */
export function clipFileName(deviceId: number): string {
    return `clips/${deviceId}.mp4`;
}

/**
 * Stored info, undefined if it is not readable.
 *
 * @param value - Value of the clipInfo state
 */
function parseInfo(value: unknown): ClipInfo | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const info = JSON.parse(value) as Partial<ClipInfo>;
        if (
            typeof info.id === 'number' &&
            typeof info.time === 'number' &&
            typeof info.savedAt === 'number' &&
            typeof info.stored === 'boolean'
        ) {
            return { id: info.id, time: info.time, savedAt: info.savedAt, stored: info.stored };
        }
    } catch {
        // unreadable: as if there were none
    }
    return undefined;
}

/** Keeps the last clip of each device */
export class ClipStore {
    private infos: Map<number, ClipInfo> | undefined;
    private readonly wanted = new Map<number, Wanted>();

    /**
     * @param host - Adapter functions
     * @param tree - Object tree
     * @param retentionMs - Clips are deleted this long after their download
     */
    public constructor(
        private readonly host: ClipHost,
        private readonly tree: ObjectTree,
        private readonly retentionMs: number,
    ) {}

    /**
     * A device has a new clip: download it on the next sync. A newer clip replaces one still waiting.
     *
     * @param deviceId - Device ID
     * @param clip - New clip
     */
    public want(deviceId: number, clip: MotionClip): void {
        const waiting = this.wanted.get(deviceId);
        if (!clip.media || (waiting && waiting.clip.time >= clip.time)) {
            return;
        }
        this.wanted.set(deviceId, { clip, attempts: 0 });
    }

    /**
     * Downloads the clips that are waiting. An error of one clip does not stop the others, one that concerns
     * the whole cloud waits for the next poll.
     */
    public async sync(): Promise<void> {
        for (const [deviceId, item] of [...this.wanted]) {
            const info = await this.info(deviceId);
            if (info?.stored && info.id === item.clip.id) {
                this.wanted.delete(deviceId);
                continue;
            }
            item.attempts++;
            try {
                const data = await this.host.download(item.clip.media!);
                await this.save(deviceId, item.clip, data);
                this.wanted.delete(deviceId);
            } catch (err) {
                if (!(err instanceof ApiError)) {
                    item.attempts--;
                    if (!(err instanceof AbortedError)) {
                        this.host.debug(`Clips not updated: ${describeError(err)}`);
                    }
                    return;
                }
                if (item.attempts >= CLIP_ATTEMPTS) {
                    this.wanted.delete(deviceId);
                    this.host.warn(`Camera ${deviceId}: clip not downloaded: ${describeError(err)}`);
                } else {
                    this.host.debug(`Camera ${deviceId}: clip not downloaded yet: ${describeError(err)}`);
                }
            }
        }
    }

    /**
     * Clips deleted at Blink: their stored copies are deleted too, waiting downloads dropped.
     *
     * @param clipIds - IDs of the deleted clips
     */
    public async deleted(clipIds: Set<number>): Promise<void> {
        for (const [deviceId, item] of [...this.wanted]) {
            if (clipIds.has(item.clip.id)) {
                this.wanted.delete(deviceId);
            }
        }
        for (const [deviceId, info] of await this.all()) {
            if (info.stored && clipIds.has(info.id)) {
                await this.remove(deviceId, info, 'deleted at Blink');
            }
        }
    }

    /**
     * Deletes the clips older than the retention period.
     *
     * @param now - Current time
     */
    public async expire(now: number): Promise<void> {
        for (const [deviceId, info] of await this.all()) {
            if (info.stored && now - info.savedAt >= this.retentionMs) {
                await this.remove(deviceId, info, 'retention period over');
            }
        }
    }

    private async save(deviceId: number, clip: MotionClip, data: Buffer): Promise<void> {
        const name = clipFileName(deviceId);
        const savedAt = Date.now();
        await this.host.writeFile(name, data);
        await this.remember(deviceId, { id: clip.id, time: clip.time, savedAt, stored: true });
        await this.tree.setValue(`cameras.${deviceId}.clipTime`, clip.time);
        // the time in the address makes a browser load the new clip
        await this.tree.setValue(`cameras.${deviceId}.clip`, `${this.host.urlOf(name)}?t=${savedAt}`);
        this.host.debug(`Camera ${deviceId}: clip stored, ${data.length} bytes`);
    }

    private async remove(deviceId: number, info: ClipInfo, reason: string): Promise<void> {
        try {
            await this.host.deleteFile(clipFileName(deviceId));
        } catch (err) {
            const message = describeError(err);
            if (!/not ?exist|ENOENT/i.test(message)) {
                this.host.debug(`Camera ${deviceId}: clip not deleted: ${message}`);
                return;
            }
        }
        await this.tree.setValue(`cameras.${deviceId}.clip`, '');
        await this.tree.setValue(`cameras.${deviceId}.clipTime`, 0);
        await this.remember(deviceId, { ...info, stored: false });
        this.host.debug(`Camera ${deviceId}: clip deleted (${reason})`);
    }

    private async remember(deviceId: number, info: ClipInfo): Promise<void> {
        (await this.all()).set(deviceId, info);
        await this.tree.setValue(`cameras.${deviceId}.clipInfo`, JSON.stringify(info));
    }

    private async info(deviceId: number): Promise<ClipInfo | undefined> {
        return (await this.all()).get(deviceId);
    }

    private async all(): Promise<Map<number, ClipInfo>> {
        if (!this.infos) {
            const infos = new Map<number, ClipInfo>();
            for (const [deviceId, value] of await this.host.readInfos()) {
                const info = parseInfo(value);
                if (info) {
                    infos.set(deviceId, info);
                }
            }
            this.infos = infos;
        }
        return this.infos;
    }
}
