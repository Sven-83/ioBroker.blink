/*
 * Last image of each camera in the file storage of the adapter (audit B.5.8, B.11.7): the state only holds
 * the address. Images are personal data, so they are deleted after the retention period (audit B.10.22).
 *
 * Blink keeps the last image of a camera in the cloud. Fetching it does not wake the camera, so changed
 * images can be picked up while polling.
 */

import { createHash } from 'node:crypto';
import type { BlinkDevice } from '../api/homescreen';
import { AbortedError, ApiError, describeError } from '../api/errors';
import type { ObjectTree } from './tree';

/** What the store needs from the adapter */
export interface ImageHost {
    /** Downloads an image from Blink */
    download(thumbnail: string): Promise<Buffer>;
    /** Writes a file into the storage of the instance */
    writeFile(name: string, data: Buffer): Promise<unknown>;
    /** Deletes a file from the storage of the instance */
    deleteFile(name: string): Promise<unknown>;
    /** All imageInfo states of earlier runs, by camera ID */
    readInfos(): Promise<Map<number, unknown>>;
    /** Address of a file of the instance, as seen from the web adapter */
    urlOf(name: string): string;
    /** Log message on level debug */
    debug(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

/** What is known about the last image of a camera */
interface ImageInfo {
    /** Hash of the address at Blink. The address itself is not stored */
    ref: string;
    /** Hash of the file */
    hash: string;
    /** Time of the download */
    savedAt: number;
    /** The file exists */
    stored: boolean;
}

/**
 * Hash of a value.
 *
 * @param value - Text or file
 */
export function hashOf(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Time of an image from the "ts" parameter of its address.
 *
 * @param thumbnail - Address at Blink
 * @param now - Current time
 * @returns Time in ms, undefined if the address has no believable time
 */
export function captureTime(thumbnail: string, now: number): number | undefined {
    let ts: string | null;
    try {
        ts = new URL(thumbnail, 'https://blink.invalid').searchParams.get('ts');
    } catch {
        return undefined;
    }
    let time = NaN;
    if (ts && /^\d{10}$/.test(ts)) {
        time = Number(ts) * 1000;
    } else if (ts && /^\d{13}$/.test(ts)) {
        time = Number(ts);
    } else if (ts && /^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        time = Date.parse(ts);
    }
    return Number.isFinite(time) && time >= Date.UTC(2020, 0, 1) && time <= now + 5 * 60_000 ? time : undefined;
}

function parseInfo(value: unknown): ImageInfo | undefined {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    try {
        const info = JSON.parse(value) as Partial<ImageInfo>;
        return typeof info.ref === 'string' && typeof info.hash === 'string' && typeof info.savedAt === 'number'
            ? { ref: info.ref, hash: info.hash, savedAt: info.savedAt, stored: info.stored === true }
            : undefined;
    } catch {
        return undefined;
    }
}

/** Keeps the last image of each camera */
export class ImageStore {
    private infos: Map<number, ImageInfo> | undefined;
    private readonly blocked = new Set<number>();
    /** Addresses that could not be fetched: tried again after a restart or with a new image, not on every poll */
    private readonly failed = new Map<number, string>();

    /**
     * @param host - Adapter functions
     * @param tree - Object tree
     * @param retentionMs - Images are deleted this long after their download
     */
    public constructor(
        private readonly host: ImageHost,
        private readonly tree: ObjectTree,
        private readonly retentionMs: number,
    ) {}

    /**
     * A snapshot of this camera is running and looks after the image itself.
     *
     * @param cameraId - Camera ID
     * @param active - Snapshot started or ended
     */
    public block(cameraId: number, active: boolean): void {
        if (active) {
            this.blocked.add(cameraId);
        } else {
            this.blocked.delete(cameraId);
        }
    }

    /**
     * Fetches the images Blink has changed. An error of one image does not stop the others,
     * one that concerns the whole cloud waits for the next poll.
     *
     * @param devices - Devices of the homescreen
     */
    public async sync(devices: BlinkDevice[]): Promise<void> {
        for (const device of devices) {
            if (this.blocked.has(device.id) || !device.thumbnail) {
                continue;
            }
            const ref = hashOf(device.thumbnail);
            if (this.failed.get(device.id) === ref) {
                continue;
            }
            try {
                await this.refresh(device);
                this.failed.delete(device.id);
            } catch (err) {
                if (!(err instanceof ApiError)) {
                    if (!(err instanceof AbortedError)) {
                        this.host.debug(`Images not updated: ${describeError(err)}`);
                    }
                    return;
                }
                this.failed.set(device.id, ref);
                this.host.warn(`Camera ${device.id}: ${describeError(err)}`);
            }
        }
    }

    /**
     * Fetches the image of a device if its address has changed. A new address with the same content does not
     * make an old image look new.
     *
     * @param device - Device of the homescreen
     */
    public async refresh(device: BlinkDevice): Promise<void> {
        if (!device.thumbnail) {
            return;
        }
        const ref = hashOf(device.thumbnail);
        const info = await this.info(device.id);
        if (info?.ref === ref) {
            return;
        }
        const data = await this.host.download(device.thumbnail);
        if (info?.hash === hashOf(data)) {
            await this.remember(device.id, { ...info, ref });
            return;
        }
        // the address is the only source of the time: without it the age of this image is unknown
        await this.save(device.id, device.thumbnail, data, captureTime(device.thumbnail, Date.now()) ?? 0);
    }

    /**
     * Hash of the current image.
     *
     * @param cameraId - Camera ID
     */
    public async currentHash(cameraId: number): Promise<string | undefined> {
        return (await this.info(cameraId))?.hash;
    }

    /**
     * Stores an image.
     *
     * @param cameraId - Camera ID
     * @param thumbnail - Address at Blink
     * @param data - JPEG file
     * @param time - Time of the image, 0 if unknown
     */
    public async save(cameraId: number, thumbnail: string, data: Buffer, time: number): Promise<void> {
        const name = fileName(cameraId);
        const savedAt = Date.now();
        await this.host.writeFile(name, data);
        await this.remember(cameraId, { ref: hashOf(thumbnail), hash: hashOf(data), savedAt, stored: true });
        await this.tree.setValue(`cameras.${cameraId}.imageTime`, time);
        // the time in the address makes a browser load the new image
        await this.tree.setValue(`cameras.${cameraId}.image`, `${this.host.urlOf(name)}?t=${savedAt}`);
    }

    /**
     * Deletes the images older than the retention period. What Blink still reports is not fetched again,
     * only a new image of the camera comes back.
     *
     * @param now - Current time
     */
    public async expire(now: number): Promise<void> {
        const infos = await this.all();
        for (const [cameraId, info] of infos) {
            if (!info.stored || now - info.savedAt < this.retentionMs) {
                continue;
            }
            try {
                await this.host.deleteFile(fileName(cameraId));
            } catch (err) {
                const message = describeError(err);
                if (!/not ?exist|ENOENT/i.test(message)) {
                    this.host.debug(`Camera ${cameraId}: image not deleted: ${message}`);
                    continue;
                }
            }
            await this.tree.setValue(`cameras.${cameraId}.image`, '');
            await this.tree.setValue(`cameras.${cameraId}.imageTime`, 0);
            await this.remember(cameraId, { ...info, stored: false });
        }
    }

    private async remember(cameraId: number, info: ImageInfo): Promise<void> {
        (await this.all()).set(cameraId, info);
        await this.tree.setValue(`cameras.${cameraId}.imageInfo`, JSON.stringify(info));
    }

    private async info(cameraId: number): Promise<ImageInfo | undefined> {
        return (await this.all()).get(cameraId);
    }

    private async all(): Promise<Map<number, ImageInfo>> {
        if (!this.infos) {
            const infos = new Map<number, ImageInfo>();
            for (const [cameraId, value] of await this.host.readInfos()) {
                const info = parseInfo(value);
                if (info) {
                    infos.set(cameraId, info);
                }
            }
            this.infos = infos;
        }
        return this.infos;
    }
}

/**
 * File of the last image.
 *
 * @param cameraId - Camera ID
 */
export function fileName(cameraId: number): string {
    return `cameras/${cameraId}.jpg`;
}
