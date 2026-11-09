/*
 * Snapshots with confirmation (audit B.11.16). A snapshot wakes a battery camera and Blink needs seconds for it.
 * The garage door relies on these images, so an old one must never look new: the image only counts as
 * new if both its address and its content have changed. The old image stays until then.
 */

import { AbortedError, BusyError, describeError } from '../api/errors';
import type { BlinkDevice, Homescreen } from '../api/homescreen';
import type { CommandStatus } from '../api/rest';
import { captureTime, hashOf, type ImageStore } from './image-store';
import type { ObjectTree } from './tree';

/** Outcome of a snapshot */
export type SnapshotResult = 'confirmed' | 'unconfirmed' | 'rejected' | 'busy' | 'offline' | 'throttled';

/** Waits before the further attempts after "System is busy" */
export const SNAPSHOT_BUSY_RETRY_MS = [6_000, 12_000];
/** No further attempts at a camera after "System is busy" came up every time */
export const SNAPSHOT_BUSY_COOLDOWN_MS = 2 * 60_000;
/** A newer image is not needed yet: saves the battery of the camera if several displays ask for one */
export const SNAPSHOT_MIN_GAP_MS = 30_000;
/** Distance between two queries of the command status */
export const SNAPSHOT_COMMAND_POLL_MS = 1_000;
/** Queries of the command status */
export const SNAPSHOT_COMMAND_POLL_MAX = 45;
/** Distance between two reads of the homescreen */
export const SNAPSHOT_READ_MS = 2_000;
/** Reads of the homescreen after the command has finished */
export const SNAPSHOT_READS_AFTER_COMMAND = 8;
/** Reads of the homescreen if Blink gave no command ID */
export const SNAPSHOT_READS_WITHOUT_COMMAND = 30;

/** What the queue needs from the adapter */
export interface SnapshotHost {
    /** The adapter is connected to the Blink cloud */
    online(): boolean;
    /** Device of the last homescreen */
    device(cameraId: number): BlinkDevice | undefined;
    /** Reads the homescreen from Blink */
    read(): Promise<Homescreen>;
    /** Asks a device for a new image, returns the command ID if Blink gave one */
    trigger(device: BlinkDevice, networkId: number): Promise<number | undefined>;
    /** Asks Blink for the state of a command */
    commandStatus(networkId: number, commandId: number): Promise<CommandStatus>;
    /** Downloads an image from Blink */
    download(thumbnail: string): Promise<Buffer>;
    /** Waits */
    wait(ms: number): Promise<void>;
    /** Log message on level debug */
    debug(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

function ids(cameraId: number): { pending: string; result: string } {
    const base = `cameras.${cameraId}`;
    return { pending: `${base}.snapshotPending`, result: `${base}.snapshotResult` };
}

/** Runs the snapshots of all cameras: one after the other per network, as a Sync Module handles one command */
export class SnapshotQueue {
    private readonly running = new Set<number>();
    private readonly lanes = new Map<number, Promise<unknown>>();
    private readonly lastImage = new Map<number, number>();
    private readonly busyUntil = new Map<number, number>();

    /**
     * @param host - Adapter functions
     * @param tree - Object tree
     * @param images - Image store
     */
    public constructor(
        private readonly host: SnapshotHost,
        private readonly tree: ObjectTree,
        private readonly images: ImageStore,
    ) {}

    /**
     * Requests a new image. A request for a camera that already has one running changes nothing.
     *
     * @param cameraId - Camera ID
     */
    public async request(cameraId: number): Promise<void> {
        if (this.running.has(cameraId)) {
            return;
        }
        const { pending, result } = ids(cameraId);
        const refused = this.refusal(cameraId);
        if (refused) {
            await this.tree.setValue(result, '');
            await this.tree.setValue(result, refused);
            return;
        }
        const networkId = this.host.device(cameraId)?.networkId;
        if (networkId === undefined) {
            this.host.warn(`Camera ${cameraId}: Blink does not report this camera or its network`);
            await this.tree.setValue(result, '');
            await this.tree.setValue(result, 'rejected');
            return;
        }

        this.running.add(cameraId);
        try {
            await this.tree.setValue(pending, true);
            // emptied, so that the same result twice in a row is visible as a new result
            await this.tree.setValue(result, '');
            const run = (this.lanes.get(networkId) ?? Promise.resolve()).then(() => this.take(cameraId));
            this.lanes.set(
                networkId,
                run.catch(() => undefined),
            );
            const outcome = await run;
            await this.tree.setValue(result, outcome);
            await this.tree.setValue(pending, false);
        } finally {
            this.running.delete(cameraId);
        }
    }

    private refusal(cameraId: number): SnapshotResult | undefined {
        if (!this.host.online()) {
            this.host.warn(`Camera ${cameraId}: not connected to Blink, snapshot dropped`);
            return 'rejected';
        }
        const now = Date.now();
        if ((this.busyUntil.get(cameraId) ?? 0) > now) {
            return 'busy';
        }
        return now - (this.lastImage.get(cameraId) ?? 0) < SNAPSHOT_MIN_GAP_MS ? 'throttled' : undefined;
    }

    private async take(cameraId: number): Promise<SnapshotResult> {
        const started = Date.now();
        this.images.block(cameraId, true);
        try {
            const outcome = await this.execute(cameraId);
            this.host.debug(`Camera ${cameraId}: snapshot took ${Date.now() - started} ms: ${outcome}`);
            return outcome;
        } catch (err) {
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.warn(`Camera ${cameraId}: snapshot failed: ${describeError(err)}`);
            return 'rejected';
        } finally {
            this.images.block(cameraId, false);
        }
    }

    private async execute(cameraId: number): Promise<SnapshotResult> {
        const device = (await this.host.read()).devices.find(item => item.id === cameraId);
        if (device?.networkId === undefined) {
            this.host.warn(`Camera ${cameraId}: Blink does not report this camera or its network`);
            return 'rejected';
        }
        if (device.status === 'offline') {
            this.host.warn(`Camera ${cameraId} is offline, no snapshot`);
            return 'offline';
        }

        const baseRef = device.thumbnail;
        try {
            await this.images.refresh(device);
        } catch (err) {
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.debug(`Camera ${cameraId}: last image not available: ${describeError(err)}`);
        }
        const baseHash = await this.images.currentHash(cameraId);

        let commandId: number | undefined;
        try {
            commandId = await this.trigger(device, device.networkId);
        } catch (err) {
            if (err instanceof BusyError) {
                this.busyUntil.set(cameraId, Date.now() + SNAPSHOT_BUSY_COOLDOWN_MS);
                this.host.warn(`Camera ${cameraId}: Blink is busy, no snapshot for the next minutes`);
                return 'busy';
            }
            throw err;
        }

        const status = commandId === undefined ? undefined : await this.follow(device.networkId, commandId, cameraId);
        // a failed command gets one look: an image that arrived anyway is still an image
        const reads =
            status === 'failed'
                ? 1
                : commandId === undefined
                  ? SNAPSHOT_READS_WITHOUT_COMMAND
                  : SNAPSHOT_READS_AFTER_COMMAND;
        for (let attempt = 0; attempt < reads; attempt++) {
            await this.host.wait(SNAPSHOT_READ_MS);
            if (await this.newImage(cameraId, baseRef, baseHash)) {
                this.lastImage.set(cameraId, Date.now());
                return 'confirmed';
            }
        }
        return status === 'failed' ? 'rejected' : 'unconfirmed';
    }

    private async trigger(device: BlinkDevice, networkId: number): Promise<number | undefined> {
        for (const delay of [...SNAPSHOT_BUSY_RETRY_MS, undefined]) {
            try {
                return await this.host.trigger(device, networkId);
            } catch (err) {
                if (!(err instanceof BusyError) || delay === undefined) {
                    throw err;
                }
                await this.host.wait(delay);
            }
        }
        return undefined;
    }

    private async follow(networkId: number, commandId: number, cameraId: number): Promise<CommandStatus> {
        for (let attempt = 0; attempt < SNAPSHOT_COMMAND_POLL_MAX; attempt++) {
            await this.host.wait(SNAPSHOT_COMMAND_POLL_MS);
            try {
                const status = await this.host.commandStatus(networkId, commandId);
                if (status !== 'running') {
                    return status;
                }
            } catch (err) {
                if (err instanceof AbortedError) {
                    throw err;
                }
                this.host.debug(`Camera ${cameraId}: command status not available: ${describeError(err)}`);
                return 'running';
            }
        }
        return 'running';
    }

    private async newImage(
        cameraId: number,
        baseRef: string | undefined,
        baseHash: string | undefined,
    ): Promise<boolean> {
        try {
            const thumbnail = (await this.host.read()).devices.find(item => item.id === cameraId)?.thumbnail;
            if (!thumbnail || thumbnail === baseRef) {
                return false;
            }
            const data = await this.host.download(thumbnail);
            if (hashOf(data) === baseHash) {
                this.host.debug(`Camera ${cameraId}: new address, but the image is still the old one`);
                return false;
            }
            const now = Date.now();
            await this.images.save(cameraId, thumbnail, data, captureTime(thumbnail, now) ?? now);
            return true;
        } catch (err) {
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.debug(`Camera ${cameraId}: new image not available yet: ${describeError(err)}`);
            return false;
        }
    }
}
