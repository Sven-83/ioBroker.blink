import { expect } from 'chai';
import { AbortedError, ApiError, BusyError } from '../api/errors';
import type { BlinkDevice, Homescreen } from '../api/homescreen';
import type { CommandStatus } from '../api/rest';
import { ImageStore } from './image-store';
import {
    SNAPSHOT_BUSY_RETRY_MS,
    SNAPSHOT_READS_AFTER_COMMAND,
    SNAPSHOT_READS_WITHOUT_COMMAND,
    SnapshotQueue,
    type SnapshotHost,
} from './snapshot-queue';
import { ObjectTree } from './tree';

const CAM = 5;
const RESULT = `cameras.${CAM}.snapshotResult`;
const PENDING = `cameras.${CAM}.snapshotPending`;
const TIME = `cameras.${CAM}.imageTime`;

function device(id: number, overrides: Partial<BlinkDevice> = {}): BlinkDevice {
    return {
        id,
        kind: 'camera',
        name: 'Test',
        type: undefined,
        networkId: 1,
        serial: undefined,
        status: 'done',
        enabled: true,
        batteryLow: false,
        batteryLevel: 3,
        batteryVoltage: undefined,
        temperature: undefined,
        wifi: undefined,
        lfr: undefined,
        thumbnail: '/old?ts=1700000000',
        ...overrides,
    };
}

function homescreen(...devices: BlinkDevice[]): Homescreen {
    return { networks: [], syncModules: [], devices };
}

interface Script {
    online?: boolean;
    /** Answers of the homescreen, the last one stays */
    screens?: (Homescreen | Error)[];
    trigger?: (() => number | undefined)[];
    status?: (CommandStatus | Error)[];
    images?: Map<string, Buffer | Error>;
}

function setup(script: Script = {}): {
    queue: SnapshotQueue;
    writes: [string, ioBroker.StateValue][];
    triggered: number[];
    waits: number[];
    messages: string[];
    files: Map<string, Buffer>;
} {
    const writes: [string, ioBroker.StateValue][] = [];
    const triggered: number[] = [];
    const waits: number[] = [];
    const messages: string[] = [];
    const files = new Map<string, Buffer>();
    const tree = new ObjectTree({
        writeObject: () => Promise.resolve(),
        writeState: (id, value) => {
            writes.push([id, value]);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve([]),
        info: () => undefined,
    });
    const download = (thumbnail: string): Promise<Buffer> => {
        const image = script.images?.get(thumbnail) ?? Buffer.from(`image of ${thumbnail.split('?')[0]}`);
        return image instanceof Error ? Promise.reject(image) : Promise.resolve(image);
    };
    const images = new ImageStore(
        {
            download,
            writeFile: (name, data) => {
                files.set(name, data);
                return Promise.resolve();
            },
            deleteFile: () => Promise.resolve(),
            readInfos: () => Promise.resolve(new Map<number, unknown>()),
            urlOf: name => `/blink.0/${name}`,
            debug: message => messages.push(message),
            warn: message => messages.push(message),
        },
        tree,
        3_600_000,
    );
    const screens = script.screens ?? [homescreen(device(CAM))];
    const host: SnapshotHost = {
        online: () => script.online ?? true,
        device: id => {
            const first = screens.find(screen => !(screen instanceof Error)) as Homescreen | undefined;
            return first?.devices.find(item => item.id === id);
        },
        read: () => {
            const next = screens.length > 1 ? screens.shift()! : screens[0];
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        trigger: item => {
            triggered.push(item.id);
            const next = script.trigger?.shift();
            return Promise.resolve().then(() => (next ? next() : 77));
        },
        commandStatus: () => {
            const next = script.status?.shift() ?? 'done';
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        download,
        wait: ms => {
            waits.push(ms);
            return Promise.resolve();
        },
        debug: message => messages.push(message),
        warn: message => messages.push(message),
    };
    return { queue: new SnapshotQueue(host, tree, images), writes, triggered, waits, messages, files };
}

function last(writes: [string, ioBroker.StateValue][], id: string): ioBroker.StateValue | undefined {
    return writes.filter(([key]) => key === id).pop()?.[1];
}

const OLD = homescreen(device(CAM));
const NEW_TIME = 1_750_000_000;
const NEW = homescreen(device(CAM, { thumbnail: `/new?ts=${NEW_TIME}` }));

describe('model/snapshot-queue', () => {
    it('confirms a new image: pending at once, the file replaced, the time from Blink', async () => {
        const { queue, writes, files, triggered } = setup({ screens: [OLD, NEW] });
        await queue.request(CAM);

        expect(writes[0]).to.deep.equal([PENDING, true]);
        expect(last(writes, RESULT)).to.equal('confirmed');
        expect(last(writes, PENDING)).to.equal(false);
        expect(triggered).to.deep.equal([CAM]);
        expect(files.get(`cameras/${CAM}.jpg`)?.toString()).to.equal('image of /new');
        expect(last(writes, TIME)).to.equal(NEW_TIME * 1000);
    });

    it('uses the current time for a confirmed image without a time', async () => {
        const before = Date.now();
        const { queue, writes } = setup({ screens: [OLD, homescreen(device(CAM, { thumbnail: '/new' }))] });
        await queue.request(CAM);
        expect(last(writes, TIME)).to.be.at.least(before);
    });

    it('keeps the old image when Blink never delivers a new one', async () => {
        const { queue, writes, files } = setup({ screens: [OLD] });
        await queue.request(CAM);

        expect(last(writes, RESULT)).to.equal('unconfirmed');
        expect(last(writes, PENDING)).to.equal(false);
        expect(files.get(`cameras/${CAM}.jpg`)?.toString()).to.equal('image of /old');
        expect(last(writes, TIME), 'time of the old image').to.equal(1_700_000_000_000);
    });

    it('does not accept a new address with the old content', async () => {
        const images = new Map<string, Buffer>([
            ['/old?ts=1700000000', Buffer.from('same')],
            [`/new?ts=${NEW_TIME}`, Buffer.from('same')],
        ]);
        const { queue, writes } = setup({ screens: [OLD, NEW], images });
        await queue.request(CAM);

        expect(last(writes, RESULT)).to.equal('unconfirmed');
        expect(last(writes, TIME)).to.equal(1_700_000_000_000);
    });

    it('waits for the image after the command has finished', async () => {
        const { queue, writes } = setup({ screens: [OLD, OLD, OLD, NEW], status: ['running', 'running', 'done'] });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('confirmed');
    });

    it('reads longer without a command ID', async () => {
        const { queue, waits } = setup({ screens: [OLD], trigger: [() => undefined] });
        await queue.request(CAM);
        expect(waits).to.have.lengthOf(SNAPSHOT_READS_WITHOUT_COMMAND);
    });

    it('gives up after the set number of reads', async () => {
        const { queue, waits } = setup({ screens: [OLD], status: ['done'] });
        await queue.request(CAM);
        expect(waits).to.have.lengthOf(1 + SNAPSHOT_READS_AFTER_COMMAND);
    });

    it('reports a failed command, unless an image arrived anyway', async () => {
        const failed = setup({ screens: [OLD], status: ['failed'] });
        await failed.queue.request(CAM);
        expect(last(failed.writes, RESULT)).to.equal('rejected');

        const arrived = setup({ screens: [OLD, NEW], status: ['failed'] });
        await arrived.queue.request(CAM);
        expect(last(arrived.writes, RESULT)).to.equal('confirmed');
    });

    it('does not wake an offline camera', async () => {
        const offline = homescreen(device(CAM, { status: 'offline' }));
        const { queue, writes, triggered } = setup({ screens: [offline] });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('offline');
        expect(triggered).to.deep.equal([]);
    });

    it('sends nothing while not connected', async () => {
        const { queue, writes, triggered } = setup({ online: false });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('rejected');
        expect(triggered).to.deep.equal([]);
    });

    it('refuses a camera Blink does not report', async () => {
        const { queue, writes, triggered } = setup();
        await queue.request(99);
        expect(last(writes, 'cameras.99.snapshotResult')).to.equal('rejected');
        expect(triggered).to.deep.equal([]);
    });

    it('tries again after "busy", then rests for this camera', async () => {
        const busy = (): number => {
            throw new BusyError();
        };
        const { queue, writes, triggered, waits } = setup({ screens: [OLD], trigger: [busy, busy, busy] });
        await queue.request(CAM);

        expect(last(writes, RESULT)).to.equal('busy');
        expect(triggered).to.have.lengthOf(3);
        expect(waits).to.deep.equal(SNAPSHOT_BUSY_RETRY_MS);

        await queue.request(CAM);
        expect(triggered, 'cooldown').to.have.lengthOf(3);
        expect(last(writes, RESULT)).to.equal('busy');
    });

    it('takes the image if "busy" clears', async () => {
        const busy = (): number => {
            throw new BusyError();
        };
        const { queue, writes } = setup({ screens: [OLD, NEW], trigger: [busy] });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('confirmed');
    });

    it('reports other errors and does not stay pending', async () => {
        const refuse = (): number => {
            throw new ApiError('Asking Blink for a snapshot', 500);
        };
        const { queue, writes } = setup({ trigger: [refuse] });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('rejected');
        expect(last(writes, PENDING)).to.equal(false);
    });

    it('goes on if the old image cannot be fetched', async () => {
        const images = new Map<string, Buffer | Error>([['/old?ts=1700000000', new ApiError('Downloading', 404)]]);
        const { queue, writes } = setup({ screens: [OLD, NEW], images });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('confirmed');
    });

    it('goes on after a failed read', async () => {
        const { queue, writes } = setup({ screens: [OLD, new Error('timeout'), NEW] });
        await queue.request(CAM);
        expect(last(writes, RESULT)).to.equal('confirmed');
    });

    it('spares the battery: no second snapshot right after a new image', async () => {
        const { queue, writes, triggered } = setup({ screens: [OLD, NEW] });
        await queue.request(CAM);
        await queue.request(CAM);
        expect(triggered).to.have.lengthOf(1);
        expect(last(writes, RESULT)).to.equal('throttled');
    });

    it('does not count a second request while one is running', async () => {
        const { queue, triggered } = setup({ screens: [OLD, NEW] });
        await Promise.all([queue.request(CAM), queue.request(CAM)]);
        expect(triggered).to.have.lengthOf(1);
    });

    it('takes the cameras of a network one after the other', async () => {
        const order: string[] = [];
        const first = device(CAM);
        const second = device(6);
        const { queue } = setup({ screens: [homescreen(first, second)], trigger: [] });
        const internal = queue as unknown as { execute: (id: number) => Promise<string> };
        const original = internal.execute.bind(queue);
        internal.execute = async id => {
            order.push(`start ${id}`);
            const result = await original(id);
            order.push(`end ${id}`);
            return result;
        };
        await Promise.all([queue.request(CAM), queue.request(6)]);
        expect(order).to.deep.equal([`start ${CAM}`, `end ${CAM}`, 'start 6', 'end 6']);
    });

    it('writes no result when the adapter shuts down', async () => {
        const { queue, writes } = setup({ screens: [new AbortedError(), OLD] });
        let error: unknown;
        try {
            await queue.request(CAM);
        } catch (err) {
            error = err;
        }
        expect(error).to.be.instanceOf(AbortedError);
        expect(writes.filter(([id, value]) => id === RESULT && value !== '')).to.deep.equal([]);
    });
});
