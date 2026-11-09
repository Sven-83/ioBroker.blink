/*
 * Arm/disarm commands with readback (audit B.11.16). Blink accepts a command and sets "armed" seconds later,
 * so networks.<id>.armed only gets ack: true with the state really read back from Blink.
 * One command per network at a time; of further requests only the latest is kept.
 */

import type { CommandStatus } from '../api/rest';
import { AbortedError, BusyError, describeError } from '../api/errors';
import type { ObjectTree } from './tree';

/** Outcome of a command */
export type ArmResult = 'confirmed' | 'rejected' | 'unconfirmed';

/** Reads of the armed state, counted from the moment Blink accepted the command */
export const ARM_READBACK_MS = [5_000, 15_000];
/** Distance between two queries of the command status */
export const COMMAND_POLL_MS = 1_000;
/** Queries of the command status before relying on the readback alone */
export const COMMAND_POLL_MAX = 10;
/** Wait after Blink answered "System is busy" */
export const BUSY_RETRY_MS = 5_000;
/** Further attempts after "System is busy" */
export const BUSY_RETRIES = 2;

/** What the queue needs from the adapter */
export interface ArmHost {
    /** The adapter is connected to the Blink cloud */
    online(): boolean;
    /** Sends the command, returns the command ID if Blink gave one */
    send(networkId: number, armed: boolean): Promise<number | undefined>;
    /** Asks Blink for the state of a command */
    commandStatus(networkId: number, commandId: number): Promise<CommandStatus>;
    /** Reads the armed state from Blink */
    read(networkId: number): Promise<boolean | undefined>;
    /** Waits */
    wait(ms: number): Promise<void>;
    /** Log message on level info */
    info(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

interface Entry {
    running: boolean;
    next: boolean | undefined;
}

interface Outcome {
    result: ArmResult;
    actual: boolean | undefined;
}

/**
 * Object IDs of the command states of a network.
 *
 * @param networkId - Network ID
 */
export function armIds(networkId: number): { armed: string; pending: string; result: string } {
    const base = `networks.${networkId}`;
    return { armed: `${base}.armed`, pending: `${base}.armPending`, result: `${base}.armResult` };
}

/** Runs the arm/disarm commands of all networks */
export class ArmQueue {
    private readonly networks = new Map<number, Entry>();

    /**
     * @param host - Adapter functions
     * @param tree - Object tree
     */
    public constructor(
        private readonly host: ArmHost,
        private readonly tree: ObjectTree,
    ) {}

    /**
     * Requests a state. Runs right away, or after the running command of this network.
     *
     * @param networkId - Network ID
     * @param armed - Requested state
     */
    public async request(networkId: number, armed: boolean): Promise<void> {
        const entry = this.networks.get(networkId);
        if (entry) {
            entry.next = armed === entry.running ? undefined : armed;
            return;
        }
        const created: Entry = { running: armed, next: undefined };
        this.networks.set(networkId, created);
        await this.drain(networkId, created);
    }

    /**
     * Puts back the last known state after an invalid request.
     *
     * @param networkId - Network ID
     */
    public async restore(networkId: number): Promise<void> {
        if (!this.networks.has(networkId)) {
            const { armed } = armIds(networkId);
            await this.tree.release(armed, this.known(armed));
        }
    }

    private async drain(networkId: number, entry: Entry): Promise<void> {
        const ids = armIds(networkId);
        this.tree.hold(ids.armed);
        try {
            await this.tree.setValue(ids.pending, true);
            // emptied, so that the same result twice in a row is visible as a new result
            await this.tree.setValue(ids.result, '');
            for (;;) {
                const armed = entry.running;
                const outcome = await this.execute(networkId, armed, entry);
                if (entry.next === undefined) {
                    this.networks.delete(networkId);
                    await this.tree.release(ids.armed, outcome.actual ?? this.known(ids.armed));
                    await this.tree.setValue(ids.result, outcome.result);
                    await this.tree.setValue(ids.pending, false);
                    this.report(networkId, armed, outcome.result);
                    return;
                }
                entry.running = entry.next;
                entry.next = undefined;
            }
        } catch (err) {
            // a failed write must not block this network until the next restart
            this.networks.delete(networkId);
            await this.tree.release(ids.armed, undefined);
            throw err;
        }
    }

    private async execute(networkId: number, armed: boolean, entry: Entry): Promise<Outcome> {
        const known = this.known(armIds(networkId).armed);
        if (!this.host.online()) {
            this.host.warn(`Network ${networkId}: not connected to Blink, command dropped`);
            return { result: 'rejected', actual: known };
        }

        let commandId: number | undefined;
        try {
            commandId = await this.send(networkId, armed);
        } catch (err) {
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.warn(`Network ${networkId}: command failed: ${describeError(err)}`);
            // a timeout can hide an accepted command, so the state read back decides
            const actual = await this.read(networkId);
            return { result: actual === armed ? 'confirmed' : 'rejected', actual: actual ?? known };
        }

        const accepted = Date.now();
        let actual = known;
        if (commandId !== undefined) {
            const status = await this.followCommand(networkId, commandId);
            if (status !== 'running') {
                actual = (await this.read(networkId)) ?? actual;
                if (actual === armed) {
                    return { result: 'confirmed', actual };
                }
                if (status === 'failed') {
                    return { result: 'rejected', actual };
                }
            }
        }
        for (const delay of ARM_READBACK_MS) {
            if (entry.next !== undefined) {
                break;
            }
            await this.host.wait(Math.max(0, accepted + delay - Date.now()));
            actual = (await this.read(networkId)) ?? actual;
            if (actual === armed) {
                return { result: 'confirmed', actual };
            }
        }
        return { result: 'unconfirmed', actual };
    }

    private async send(networkId: number, armed: boolean): Promise<number | undefined> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.host.send(networkId, armed);
            } catch (err) {
                if (!(err instanceof BusyError) || attempt >= BUSY_RETRIES) {
                    throw err;
                }
                await this.host.wait(BUSY_RETRY_MS);
            }
        }
    }

    /**
     * Follows a command until it is finished. An error stops the queries: the readback still gives the result.
     *
     * @param networkId - Network ID
     * @param commandId - Command ID
     * @returns The last known status; "running" if it did not finish
     */
    private async followCommand(networkId: number, commandId: number): Promise<CommandStatus> {
        for (let attempt = 0; attempt < COMMAND_POLL_MAX; attempt++) {
            await this.host.wait(COMMAND_POLL_MS);
            try {
                const status = await this.host.commandStatus(networkId, commandId);
                if (status !== 'running') {
                    return status;
                }
            } catch (err) {
                if (err instanceof AbortedError) {
                    throw err;
                }
                this.host.info(`Network ${networkId}: command status not available: ${describeError(err)}`);
                return 'running';
            }
        }
        return 'running';
    }

    private async read(networkId: number): Promise<boolean | undefined> {
        try {
            return await this.host.read(networkId);
        } catch (err) {
            if (err instanceof AbortedError) {
                throw err;
            }
            this.host.info(`Network ${networkId}: readback failed: ${describeError(err)}`);
            return undefined;
        }
    }

    private known(id: string): boolean | undefined {
        const value = this.tree.value(id);
        return typeof value === 'boolean' ? value : undefined;
    }

    private report(networkId: number, armed: boolean, result: ArmResult): void {
        const target = armed ? 'armed' : 'disarmed';
        if (result === 'confirmed') {
            this.host.info(`Network ${networkId} is ${target}`);
        } else if (result === 'unconfirmed') {
            this.host.warn(`Network ${networkId}: Blink has not confirmed the change to ${target}`);
        } else {
            this.host.warn(`Network ${networkId}: could not be ${target}`);
        }
    }
}
