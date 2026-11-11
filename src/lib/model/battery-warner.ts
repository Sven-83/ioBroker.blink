/*
 * Battery warning (opt-in): one message per device when Blink reports a low battery. It relies on the
 * "low" flag of the homescreen only, so it needs no request of its own and wakes no camera. The next
 * warning for a device needs the battery to be fine again in between and at least a day to have passed.
 * What was sent is kept in a state, so a restart does not repeat a warning. No images are sent.
 */

import { AbortedError, describeError } from '../api/errors';
import type { Homescreen } from '../api/homescreen';

/** State that keeps the warnings sent, relative to the instance */
export const BATTERY_STATE = 'info.batteryWarnings';
/** Least time between two warnings of the same device */
export const BATTERY_REPEAT_MS = 24 * 3_600_000;

/** What the warning needs from the adapter */
export interface BatteryHost {
    /** Sends a message; rejects if it could not be delivered */
    send(text: string): Promise<void>;
    /** Stored value of BATTERY_STATE */
    read(): Promise<ioBroker.StateValue | undefined>;
    /** Writes BATTERY_STATE with ack: true */
    write(value: string): Promise<unknown>;
    /** Log message on level debug */
    debug(message: string): void;
    /** Log message on level info */
    info(message: string): void;
    /** Log message on level warn */
    warn(message: string): void;
}

interface Entry {
    /** Time of the last warning */
    at: number;
    /** The battery has been low since that warning */
    active: boolean;
}

/**
 * Text of the warning.
 *
 * @param german - Language of the system is German
 * @param device - Name of the device
 * @param network - Name of its network, if known
 */
export function batteryText(german: boolean, device: string, network: string | undefined): string {
    const where = network ? ` (${network})` : '';
    return german
        ? `Blink: Batterie schwach bei „${device}“${where}. Bitte bald wechseln.`
        : `Blink: battery low on "${device}"${where}. Please replace it soon.`;
}

/**
 * Text of the test message from the instance settings.
 *
 * @param german - Language of the system is German
 */
export function batteryTestText(german: boolean): string {
    return german
        ? 'Blink: Testnachricht. Batteriewarnungen kommen hier an.'
        : 'Blink: test message. Battery warnings arrive here.';
}

/** Sends a warning per device whose battery Blink reports as low */
export class BatteryWarner {
    private entries: Map<number, Entry> | undefined;
    private failing = false;

    /**
     * @param host - Adapter functions
     * @param german - Language of the messages is German
     */
    public constructor(
        private readonly host: BatteryHost,
        private readonly german: boolean,
    ) {}

    /**
     * Checks the devices of a homescreen. A failed message is tried again on the next poll.
     *
     * @param homescreen - Current homescreen
     * @param now - Current time
     */
    public async check(homescreen: Homescreen, now = Date.now()): Promise<void> {
        const entries = await this.load();
        let changed = false;
        for (const [id, entry] of entries) {
            if (!entry.active && now - entry.at >= BATTERY_REPEAT_MS) {
                entries.delete(id);
                changed = true;
            }
        }
        for (const device of homescreen.devices) {
            const entry = entries.get(device.id);
            if (device.batteryLow === false) {
                if (entry?.active) {
                    entry.active = false;
                    changed = true;
                }
                continue;
            }
            // undefined: no battery (Mini) or nothing reported
            if (device.batteryLow !== true || entry?.active || (entry && now - entry.at < BATTERY_REPEAT_MS)) {
                continue;
            }
            const network = homescreen.networks.find(item => item.id === device.networkId)?.name;
            try {
                await this.host.send(batteryText(this.german, device.name, network));
            } catch (err) {
                if (err instanceof AbortedError) {
                    throw err;
                }
                const message = `Battery warning not sent: ${describeError(err)}. Next attempt on the next poll`;
                if (this.failing) {
                    this.host.debug(message);
                } else {
                    this.failing = true;
                    this.host.warn(message);
                }
                break;
            }
            this.failing = false;
            entries.set(device.id, { at: now, active: true });
            changed = true;
            this.host.info(`Camera ${device.id}: battery warning sent`);
        }
        if (changed) {
            await this.host.write(JSON.stringify(Object.fromEntries(entries)));
        }
    }

    private async load(): Promise<Map<number, Entry>> {
        if (!this.entries) {
            const entries = new Map<number, Entry>();
            const stored = await this.host.read();
            try {
                const parsed: unknown = typeof stored === 'string' && stored ? JSON.parse(stored) : {};
                for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                    const id = Number(key);
                    const entry = value as Partial<Entry> | null;
                    if (
                        Number.isSafeInteger(id) &&
                        typeof entry?.at === 'number' &&
                        typeof entry.active === 'boolean'
                    ) {
                        entries.set(id, { at: entry.at, active: entry.active });
                    }
                }
            } catch {
                // damaged value: start empty, at worst a warning is sent again
            }
            this.entries = entries;
        }
        return this.entries;
    }
}
