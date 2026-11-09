import { expect } from 'chai';
import { ArmSelection, type SelectionHost } from './arm-selection';

function setup(
    stored: [number, ioBroker.StateValue][] = [],
    failRequest?: number,
): {
    selection: ArmSelection;
    writes: [number, boolean][];
    requests: [number, boolean][];
    messages: string[];
    reads: () => number;
} {
    const writes: [number, boolean][] = [];
    const requests: [number, boolean][] = [];
    const messages: string[] = [];
    let readCount = 0;
    const host: SelectionHost = {
        readStored: () => {
            readCount++;
            return Promise.resolve(new Map(stored));
        },
        write: (id, value) => {
            writes.push([id, value]);
            return Promise.resolve();
        },
        request: (id, armed) => {
            requests.push([id, armed]);
            return id === failRequest ? Promise.reject(new Error('cloud gone')) : Promise.resolve();
        },
        info: message => messages.push(message),
    };
    return { selection: new ArmSelection(host), writes, requests, messages, reads: () => readCount };
}

describe('ArmSelection', () => {
    it('gives a new network the default true and keeps a stored choice', async () => {
        const { selection, writes } = setup([[2, false]]);
        await selection.ensure([1, 2, 3]);
        expect(writes).to.deep.equal([
            [1, true],
            [3, true],
        ]);
        expect(selection.isSelected(1)).to.equal(true);
        expect(selection.isSelected(2)).to.equal(false);
    });

    it('reads the stored choice only once, also when asked twice at the same time', async () => {
        const { selection, reads, writes } = setup([[1, true]]);
        await Promise.all([selection.ensure([1]), selection.ensure([1])]);
        await selection.ensure([1]);
        expect(reads()).to.equal(1);
        expect(writes).to.deep.equal([]);
    });

    it('treats a stored value that is not true or false as missing', async () => {
        const { selection, writes } = setup([[1, 'yes']]);
        await selection.ensure([1]);
        expect(writes).to.deep.equal([[1, true]]);
    });

    it('keeps a choice of the user and puts the old one back for an invalid value', async () => {
        const { selection, writes } = setup([[1, true]]);
        await selection.set(1, false);
        expect(selection.isSelected(1)).to.equal(false);
        await selection.set(1, 'off');
        expect(writes).to.deep.equal([
            [1, false],
            [1, false],
        ]);
        expect(selection.isSelected(1)).to.equal(false);
    });

    it('arms only selected networks that are not armed yet', async () => {
        const { selection, requests } = setup([
            [1, true],
            [2, false],
            [3, true],
            [4, true],
        ]);
        await selection.run('armSelected', [
            { id: 1, armed: false },
            { id: 2, armed: false },
            { id: 3, armed: true },
            { id: 4, armed: undefined },
            { id: 5, armed: false },
        ]);
        // 5 has no stored choice yet: a new network belongs to the selection
        expect(requests).to.deep.equal([
            [1, true],
            [4, true],
            [5, true],
        ]);
    });

    it('disarms every network that is not known as disarmed, whatever the choice', async () => {
        const { selection, requests } = setup([[1, false]]);
        await selection.run('disarmAll', [
            { id: 1, armed: true },
            { id: 2, armed: false },
            { id: 3, armed: undefined },
        ]);
        expect(requests).to.deep.equal([
            [1, false],
            [3, false],
        ]);
    });

    it('says so when there is nothing to switch', async () => {
        const { selection, requests, messages } = setup([[1, false]]);
        await selection.run('armSelected', [{ id: 1, armed: false }]);
        await selection.run('disarmAll', [{ id: 1, armed: false }]);
        expect(requests).to.deep.equal([]);
        expect(messages).to.deep.equal([
            'Arm selected: no selected network is disarmed',
            'Disarm all: no network is armed',
        ]);
    });

    it('switches the other networks when one of them fails, then reports the failure', async () => {
        const { selection, requests } = setup([], 1);
        let error: unknown;
        try {
            await selection.run('armSelected', [
                { id: 1, armed: false },
                { id: 2, armed: false },
            ]);
        } catch (err) {
            error = err;
        }
        expect(requests).to.deep.equal([
            [1, true],
            [2, true],
        ]);
        expect((error as Error).message).to.equal('cloud gone');
    });
});
