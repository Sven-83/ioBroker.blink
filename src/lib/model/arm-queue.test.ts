import { expect } from 'chai';
import { AbortedError, ApiError, BusyError } from '../api/errors';
import type { CommandStatus } from '../api/rest';
import { ARM_READBACK_MS, ArmQueue, BUSY_RETRIES, COMMAND_POLL_MAX, MOTION_SWITCH, type ArmHost } from './arm-queue';
import { ObjectTree } from './tree';

const NET = 7;
const ARMED = `networks.${NET}.armed`;
const PENDING = `networks.${NET}.armPending`;
const RESULT = `networks.${NET}.armResult`;

interface Script {
    online?: boolean;
    send?: (() => number | undefined)[];
    status?: (CommandStatus | Error)[];
    reads?: (boolean | Error | undefined)[];
    failWrites?: boolean;
}

function setup(script: Script = {}): {
    queue: ArmQueue;
    tree: ObjectTree;
    writes: [string, ioBroker.StateValue][];
    sent: boolean[];
    waits: number[];
    messages: string[];
    host: ArmHost;
} {
    const writes: [string, ioBroker.StateValue][] = [];
    const sent: boolean[] = [];
    const waits: number[] = [];
    const messages: string[] = [];
    const tree = new ObjectTree({
        writeObject: () => Promise.resolve(),
        writeState: (id, value) => {
            if (script.failWrites) {
                return Promise.reject(new Error('database gone'));
            }
            writes.push([id, value]);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve([]),
        info: () => undefined,
    });
    const host: ArmHost = {
        online: () => script.online ?? true,
        send: (_id, armed) => {
            sent.push(armed);
            const next = script.send?.shift();
            return Promise.resolve().then(() => (next ? next() : undefined));
        },
        commandStatus: () => {
            const next = script.status?.shift() ?? 'running';
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        read: () => {
            const next = script.reads?.shift();
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        wait: ms => {
            waits.push(ms);
            return Promise.resolve();
        },
        info: message => messages.push(message),
        warn: message => messages.push(message),
    };
    return { queue: new ArmQueue(host, tree), tree, writes, sent, waits, messages, host };
}

function lastWrite(writes: [string, ioBroker.StateValue][], id: string): ioBroker.StateValue | undefined {
    return writes.filter(([written]) => written === id).at(-1)?.[1];
}

describe('model/arm-queue motion detection', () => {
    it('switches the motion detection of a camera with the same readback', async () => {
        const { tree, writes, host, messages } = setup({
            send: [() => 12, () => 13],
            status: ['done', 'failed'],
            reads: [false, true],
        });
        const queue = new ArmQueue(host, tree, MOTION_SWITCH);
        await queue.request(3, false);
        expect(writes[0]).to.deep.equal(['cameras.3.motionPending', true]);
        expect(lastWrite(writes, 'cameras.3.enabled')).to.equal(false);
        expect(lastWrite(writes, 'cameras.3.motionResult')).to.equal('confirmed');
        expect(lastWrite(writes, 'cameras.3.motionPending')).to.equal(false);
        expect(messages).to.deep.include('Camera 3 motion detection is off');

        await queue.request(3, false);
        expect(messages.at(-1)).to.equal('Camera 3 motion detection: could not be switched off');
    });
});

describe('model/arm-queue', () => {
    it('reports pending at once and confirms from the readback', async () => {
        const { queue, tree, writes, sent } = setup({ send: [() => 11], status: ['done'], reads: [true] });
        await tree.setValue(ARMED, false);
        writes.length = 0;
        await queue.request(NET, true);
        expect(sent).to.deep.equal([true]);
        expect(writes[0]).to.deep.equal([PENDING, true]);
        expect(lastWrite(writes, ARMED)).to.equal(true);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
        expect(lastWrite(writes, PENDING)).to.equal(false);
    });

    it('does not wait for the fixed readbacks when the command finished', async () => {
        const { queue, waits } = setup({ send: [() => 11], status: ['running', 'done'], reads: [true] });
        await queue.request(NET, true);
        expect(waits).to.have.length(2);
    });

    it('reads back after 5 and 15 s without a command ID', async () => {
        const { queue, writes, waits } = setup({ reads: [false, true] });
        await queue.request(NET, true);
        expect(waits).to.have.length(ARM_READBACK_MS.length);
        expect(waits[0]).to.be.within(ARM_READBACK_MS[0] - 100, ARM_READBACK_MS[0]);
        expect(waits[1]).to.be.within(ARM_READBACK_MS[1] - 100, ARM_READBACK_MS[1]);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
    });

    it('sets the real state when Blink never confirms', async () => {
        const { queue, tree, writes, messages } = setup({ reads: [false, false] });
        await tree.setValue(ARMED, false);
        writes.length = 0;
        await queue.request(NET, true);
        // written although the cache already says false: the user's request has to be replaced
        expect(lastWrite(writes, ARMED)).to.equal(false);
        expect(lastWrite(writes, RESULT)).to.equal('unconfirmed');
        expect(messages.join()).to.include('not confirmed');
    });

    it('stops early when the command failed and the state is unchanged', async () => {
        const { queue, writes, waits } = setup({ send: [() => 11], status: ['failed'], reads: [false] });
        await queue.request(NET, true);
        expect(waits).to.have.length(1);
        expect(lastWrite(writes, ARMED)).to.equal(false);
        expect(lastWrite(writes, RESULT)).to.equal('rejected');
    });

    it('believes the read state, even if the command status says failed', async () => {
        const { queue, writes } = setup({ send: [() => 11], status: ['failed'], reads: [true] });
        await queue.request(NET, true);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
    });

    it('falls back to the readback when the command status is not available', async () => {
        const { queue, writes, waits } = setup({
            send: [() => 11],
            status: [new ApiError('status', 404)],
            reads: [true],
        });
        await queue.request(NET, true);
        expect(waits).to.have.length(2);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
    });

    it('limits the queries of the command status', async () => {
        const { queue, waits } = setup({ send: [() => 11], reads: [true] });
        await queue.request(NET, true);
        expect(waits).to.have.length(COMMAND_POLL_MAX + 1);
    });

    it('rejects a failed command and keeps the last known state', async () => {
        const fail = (): number => {
            throw new ApiError('arm', 500);
        };
        const { queue, tree, writes, sent } = setup({ send: [fail], reads: [undefined] });
        await tree.setValue(ARMED, false);
        writes.length = 0;
        await queue.request(NET, true);
        expect(sent).to.have.length(1);
        expect(lastWrite(writes, ARMED)).to.equal(false);
        expect(lastWrite(writes, RESULT)).to.equal('rejected');
    });

    it('confirms when the request timed out but the command got through', async () => {
        const fail = (): number => {
            throw new Error('timeout');
        };
        const { queue, writes } = setup({ send: [fail], reads: [true] });
        await queue.request(NET, true);
        expect(lastWrite(writes, ARMED)).to.equal(true);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
    });

    it('retries when Blink is busy, but not endlessly', async () => {
        const busy = (): number => {
            throw new BusyError();
        };
        const first = setup({ send: [busy, () => 11], status: ['done'], reads: [true] });
        await first.queue.request(NET, true);
        expect(first.sent).to.have.length(2);
        expect(lastWrite(first.writes, RESULT)).to.equal('confirmed');

        const second = setup({ send: Array<() => number>(10).fill(busy), reads: [false] });
        await second.queue.request(NET, true);
        expect(second.sent).to.have.length(BUSY_RETRIES + 1);
        expect(lastWrite(second.writes, RESULT)).to.equal('rejected');
    });

    it('drops the command while offline, without a request', async () => {
        const { queue, tree, writes, sent } = setup({ online: false });
        await tree.setValue(ARMED, true);
        writes.length = 0;
        await queue.request(NET, false);
        expect(sent).to.deep.equal([]);
        expect(lastWrite(writes, ARMED)).to.equal(true);
        expect(lastWrite(writes, RESULT)).to.equal('rejected');
    });

    it('never invents a state that is not known', async () => {
        const { queue, writes } = setup({ online: false });
        await queue.request(NET, true);
        expect(lastWrite(writes, ARMED)).to.equal(undefined);
        expect(lastWrite(writes, PENDING)).to.equal(false);
    });

    it('keeps only the latest request while a command runs', async () => {
        const context = setup({ reads: [true, false] });
        const { queue, writes, sent, host } = context;
        const wait = host.wait;
        let requested = false;
        host.wait = async ms => {
            if (!requested) {
                requested = true;
                await queue.request(NET, false);
                await queue.request(NET, true);
                await queue.request(NET, false);
            }
            return wait(ms);
        };
        await queue.request(NET, true);
        expect(sent).to.deep.equal([true, false]);
        expect(lastWrite(writes, ARMED)).to.equal(false);
        expect(writes.filter(([id]) => id === ARMED)).to.have.length(1);
    });

    it('ignores a repeated request for the running state', async () => {
        const context = setup({ reads: [true] });
        const { queue, sent, host } = context;
        const wait = host.wait;
        host.wait = async ms => {
            await queue.request(NET, true);
            return wait(ms);
        };
        await queue.request(NET, true);
        expect(sent).to.deep.equal([true]);
    });

    it('runs networks independently', async () => {
        const { queue, sent } = setup({ reads: [true, true] });
        await Promise.all([queue.request(1, true), queue.request(2, true)]);
        expect(sent).to.have.length(2);
    });

    it('stops silently when the adapter shuts down', async () => {
        const abort = (): number => {
            throw new AbortedError();
        };
        const { queue, messages } = setup({ send: [abort] });
        let thrown: unknown;
        await queue.request(NET, true).catch((err: unknown) => {
            thrown = err;
        });
        expect(thrown).to.be.instanceOf(AbortedError);
        expect(messages).to.deep.equal([]);
    });

    it('is not blocked after a failed write', async () => {
        const script: Script = { failWrites: true, send: [() => 11], status: ['done'], reads: [true] };
        const { queue, tree, writes, sent } = setup(script);
        let failed = false;
        await queue.request(NET, true).catch(() => {
            failed = true;
        });
        expect(failed).to.equal(true);

        script.failWrites = false;
        await queue.request(NET, true);
        expect(sent).to.deep.equal([true]);
        expect(lastWrite(writes, ARMED)).to.equal(true);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');

        // polled values reach the state again
        await tree.apply({ networks: [{ id: NET, name: 'n', armed: false }], syncModules: [], devices: [] });
        expect(lastWrite(writes, ARMED)).to.equal(false);
    });

    it('makes a repeated result visible', async () => {
        const { queue, writes } = setup({ reads: [true, true] });
        await queue.request(NET, true);
        await queue.request(NET, true);
        const results = writes.filter(([id]) => id === RESULT).map(([, value]) => value);
        expect(results).to.deep.equal(['', 'confirmed', '', 'confirmed']);
    });

    it('restores the known state after an invalid request', async () => {
        const { queue, tree, writes } = setup();
        await tree.setValue(ARMED, true);
        writes.length = 0;
        await queue.restore(NET);
        expect(writes).to.deep.equal([[ARMED, true]]);
    });
});

describe('model/tree holding a state', () => {
    it('keeps polled values away from a held state', async () => {
        const { tree, writes } = setup();
        await tree.setValue(ARMED, false);
        tree.hold(ARMED);
        writes.length = 0;
        await tree.apply({ networks: [{ id: NET, name: 'n', armed: true }], syncModules: [], devices: [] });
        expect(lastWrite(writes, ARMED)).to.equal(undefined);
        expect(tree.value(ARMED)).to.equal(false);

        await tree.release(ARMED, false);
        expect(lastWrite(writes, ARMED)).to.equal(false);
        await tree.apply({ networks: [{ id: NET, name: 'n', armed: true }], syncModules: [], devices: [] });
        expect(lastWrite(writes, ARMED)).to.equal(true);
    });

    it('creates the command states once and does not reset them when polling', async () => {
        const { tree, writes } = setup();
        const screen = { networks: [{ id: NET, name: 'n', armed: true }], syncModules: [], devices: [] };
        await tree.apply(screen);
        expect(lastWrite(writes, PENDING)).to.equal(false);
        await tree.setValue(PENDING, true);
        await tree.setValue(RESULT, 'confirmed');
        await tree.apply(screen);
        expect(lastWrite(writes, PENDING)).to.equal(true);
        expect(lastWrite(writes, RESULT)).to.equal('confirmed');
    });
});
