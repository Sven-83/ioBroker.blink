import { expect } from 'chai';
import type { BlinkDevice, Homescreen } from '../api/homescreen';
import { ObjectTree, type TreeHost } from './tree';

function device(values: Partial<BlinkDevice> = {}): BlinkDevice {
    return {
        id: 1,
        kind: 'camera',
        name: 'a',
        type: undefined,
        networkId: undefined,
        serial: undefined,
        status: undefined,
        enabled: undefined,
        batteryLow: undefined,
        batteryLevel: undefined,
        batteryVoltage: undefined,
        temperature: undefined,
        wifi: undefined,
        lfr: undefined,
        thumbnail: undefined,
        ...values,
    };
}

function screen(...devices: BlinkDevice[]): Homescreen {
    return { networks: [], syncModules: [], devices };
}

function fakeHost(existing: string[] = []): TreeHost & {
    objects: Map<string, ioBroker.SettableObject>;
    writes: [string, ioBroker.StateValue][];
    messages: string[];
} {
    const objects = new Map<string, ioBroker.SettableObject>();
    const writes: [string, ioBroker.StateValue][] = [];
    const messages: string[] = [];
    return {
        objects,
        writes,
        messages,
        writeObject: id => {
            objects.set(id, { type: 'meta', common: { name: '', type: 'meta.user' }, native: {} });
            return Promise.resolve();
        },
        writeState: (id, value) => {
            writes.push([id, value]);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve(existing),
        info: message => messages.push(message),
    };
}

describe('model/tree', () => {
    it('creates folder, device and only the states with a value', async () => {
        const host = fakeHost();
        await new ObjectTree(host).apply(screen(device({ temperature: 0, batteryLow: false })));
        expect([...host.objects.keys()]).to.have.members([
            'cameras',
            'cameras.1',
            'cameras.1.name',
            'cameras.1.available',
            'cameras.1.kind',
            'cameras.1.batteryLow',
            'cameras.1.temperature',
            // states of the commands exist without a value from Blink
            'cameras.1.motionPending',
            'cameras.1.motionResult',
            'cameras.1.snapshot',
            'cameras.1.snapshotPending',
            'cameras.1.snapshotResult',
            'cameras.1.motionTime',
            'cameras.1.motionDetection',
            'cameras.1.motionSource',
            'cameras.1.image',
            'cameras.1.imageTime',
            'cameras.1.imageInfo',
            'cameras.1.liveActive',
            'cameras.1.liveResult',
        ]);
        expect(host.writes).to.deep.include(['cameras.1.temperature', 0]);
        expect(host.writes).to.deep.include(['cameras.1.batteryLow', false]);
    });

    it('writes nothing when nothing changed', async () => {
        const host = fakeHost();
        const tree = new ObjectTree(host);
        await tree.apply(screen(device({ wifi: 3 })));
        const objects = host.objects.size;
        host.objects.clear();
        host.writes.length = 0;

        await tree.apply(screen(device({ wifi: 3 })));
        expect(host.objects.size).to.equal(0);
        expect(host.writes).to.deep.equal([]);

        await tree.apply(screen(device({ wifi: 2 })));
        expect(host.objects.size).to.equal(0);
        expect(host.writes).to.deep.equal([['cameras.1.wifi', 2]]);
        expect(objects).to.be.greaterThan(0);
    });

    it('updates the device object when it is renamed', async () => {
        const host = fakeHost();
        const tree = new ObjectTree(host);
        await tree.apply(screen(device()));
        host.objects.clear();
        await tree.apply(screen(device({ name: 'b' })));
        expect([...host.objects.keys()]).to.deep.equal(['cameras.1']);
    });

    it('marks devices Blink no longer reports and brings them back', async () => {
        const host = fakeHost();
        const tree = new ObjectTree(host);
        await tree.apply(screen(device(), device({ id: 2 })));
        host.writes.length = 0;

        await tree.apply(screen(device()));
        expect(host.writes).to.deep.equal([['cameras.2.available', false]]);
        expect(host.messages).to.have.length(1);

        await tree.apply(screen(device()));
        expect(host.messages, 'reported only once').to.have.length(1);

        await tree.apply(screen(device(), device({ id: 2 })));
        expect(host.writes).to.deep.include(['cameras.2.available', true]);
    });

    it('also marks devices from an earlier run', async () => {
        const host = fakeHost(['cameras.9']);
        await new ObjectTree(host).apply(screen(device()));
        expect(host.writes).to.deep.include(['cameras.9.available', false]);
    });

    it('does not store a value as written when the write failed', async () => {
        const host = fakeHost();
        const tree = new ObjectTree(host);
        const write = host.writeState;
        host.writeState = () => Promise.reject(new Error('database gone'));
        let failed = false;
        await tree.apply(screen(device())).catch(() => {
            failed = true;
        });
        expect(failed).to.equal(true);

        host.writeState = write;
        await tree.apply(screen(device()));
        expect(host.writes).to.deep.include(['cameras.1.name', 'a']);
    });
});
