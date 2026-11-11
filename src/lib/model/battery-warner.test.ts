import { expect } from 'chai';
import { AbortedError } from '../api/errors';
import type { BlinkDevice, Homescreen } from '../api/homescreen';
import { BATTERY_REPEAT_MS, BatteryWarner, batteryText, type BatteryHost } from './battery-warner';

const NOW = 1_800_000_000_000;

function device(id: number, batteryLow: boolean | undefined, networkId = 1): BlinkDevice {
    return { id, name: `Camera ${id}`, networkId, batteryLow } as BlinkDevice;
}

function homescreen(...devices: BlinkDevice[]): Homescreen {
    return { networks: [{ id: 1, name: 'Home' }], syncModules: [], devices } as unknown as Homescreen;
}

function setup(
    stored?: string,
    fail?: Error,
): {
    warner: BatteryWarner;
    sent: string[];
    writes: string[];
    messages: string[];
    host: BatteryHost;
    failWith: (err: Error | undefined) => void;
} {
    const sent: string[] = [];
    const writes: string[] = [];
    const messages: string[] = [];
    let error = fail;
    let value = stored;
    const host: BatteryHost = {
        send: text => {
            if (error) {
                return Promise.reject(error);
            }
            sent.push(text);
            return Promise.resolve();
        },
        read: () => Promise.resolve(value),
        write: next => {
            writes.push(next);
            value = next;
            return Promise.resolve();
        },
        debug: message => messages.push(`debug: ${message}`),
        info: message => messages.push(`info: ${message}`),
        warn: message => messages.push(`warn: ${message}`),
    };
    return {
        warner: new BatteryWarner(host, true),
        sent,
        writes,
        messages,
        host,
        failWith: err => (error = err),
    };
}

describe('BatteryWarner', () => {
    it('warns once per device with a low battery, with name and network', async () => {
        const { warner, sent } = setup();
        await warner.check(homescreen(device(1, true), device(2, false), device(3, undefined)), NOW);
        await warner.check(homescreen(device(1, true)), NOW + 60_000);
        await warner.check(homescreen(device(1, true)), NOW + 2 * BATTERY_REPEAT_MS);
        expect(sent).to.deep.equal(['Blink: Batterie schwach bei „Camera 1“ (Home). Bitte bald wechseln.']);
    });

    it('warns again only after the battery was fine and a day has passed', async () => {
        const { warner, sent } = setup();
        await warner.check(homescreen(device(1, true)), NOW);
        await warner.check(homescreen(device(1, false)), NOW + 3_600_000);
        await warner.check(homescreen(device(1, true)), NOW + 7_200_000);
        expect(sent, 'fine again, but within a day').to.have.length(1);
        await warner.check(homescreen(device(1, true)), NOW + BATTERY_REPEAT_MS);
        expect(sent).to.have.length(2);
    });

    it('does not repeat a warning after a restart', async () => {
        const first = setup();
        await first.warner.check(homescreen(device(1, true)), NOW);
        const restarted = setup(first.writes.at(-1));
        await restarted.warner.check(homescreen(device(1, true)), NOW + 2 * BATTERY_REPEAT_MS);
        expect(restarted.sent).to.deep.equal([]);
    });

    it('starts empty with a damaged stored value', async () => {
        const { warner, sent } = setup('{not json');
        await warner.check(homescreen(device(1, true)), NOW);
        expect(sent).to.have.length(1);
    });

    it('tries again on the next poll if sending fails, and warns only once', async () => {
        const { warner, sent, writes, messages, failWith } = setup(undefined, new Error('telegram.0 is not running'));
        await warner.check(homescreen(device(1, true), device(2, true)), NOW);
        await warner.check(homescreen(device(1, true), device(2, true)), NOW + 60_000);
        expect(sent).to.deep.equal([]);
        expect(writes).to.deep.equal([]);
        expect(messages.filter(line => line.startsWith('warn:'))).to.have.length(1);
        failWith(undefined);
        await warner.check(homescreen(device(1, true), device(2, true)), NOW + 120_000);
        expect(sent).to.have.length(2);
    });

    it('passes an abort on', async () => {
        const { warner } = setup(undefined, new AbortedError());
        let error: unknown;
        await warner.check(homescreen(device(1, true)), NOW).catch((err: unknown) => (error = err));
        expect(error).to.be.instanceOf(AbortedError);
    });

    it('writes only when something changed', async () => {
        const { warner, writes } = setup();
        await warner.check(homescreen(device(1, false), device(2, undefined)), NOW);
        expect(writes).to.deep.equal([]);
    });

    it('writes English texts and leaves out an unknown network', () => {
        expect(batteryText(false, 'Garden', undefined)).to.equal(
            'Blink: battery low on "Garden". Please replace it soon.',
        );
    });
});
