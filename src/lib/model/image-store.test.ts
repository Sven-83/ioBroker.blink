import { expect } from 'chai';
import { ApiError, RateLimitedError } from '../api/errors';
import type { BlinkDevice } from '../api/homescreen';
import { ImageStore, captureTime, fileName, hashOf, type ImageHost } from './image-store';
import { ObjectTree } from './tree';

const HOUR = 3_600_000;

function device(id: number, thumbnail: string | undefined): BlinkDevice {
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
        thumbnail,
    };
}

function setup(options: { stored?: Map<number, unknown>; retention?: number } = {}): {
    store: ImageStore;
    tree: ObjectTree;
    files: Map<string, Buffer>;
    states: Map<string, ioBroker.StateValue>;
    downloads: string[];
    messages: string[];
    responses: Map<string, Buffer | Error>;
    failDelete: { error?: Error };
} {
    const files = new Map<string, Buffer>();
    const states = new Map<string, ioBroker.StateValue>();
    const downloads: string[] = [];
    const messages: string[] = [];
    const responses = new Map<string, Buffer | Error>();
    const failDelete: { error?: Error } = {};
    const tree = new ObjectTree({
        writeObject: () => Promise.resolve(),
        writeState: (id, value) => {
            states.set(id, value);
            return Promise.resolve();
        },
        listDevices: () => Promise.resolve([]),
        info: () => undefined,
    });
    const host: ImageHost = {
        download: thumbnail => {
            downloads.push(thumbnail);
            const response = responses.get(thumbnail) ?? Buffer.from(`image of ${thumbnail}`);
            return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
        },
        writeFile: (name, data) => {
            files.set(name, data);
            return Promise.resolve();
        },
        deleteFile: name => {
            if (failDelete.error) {
                return Promise.reject(failDelete.error);
            }
            files.delete(name);
            return Promise.resolve();
        },
        readInfos: () => Promise.resolve(options.stored ?? new Map<number, unknown>()),
        urlOf: name => `/blink.0/${name}`,
        debug: message => messages.push(message),
        warn: message => messages.push(message),
    };
    return {
        store: new ImageStore(host, tree, options.retention ?? 24 * HOUR),
        tree,
        files,
        states,
        downloads,
        messages,
        responses,
        failDelete,
    };
}

describe('model/image-store captureTime', () => {
    const now = Date.UTC(2026, 10, 9);

    it('reads seconds, milliseconds and dates', () => {
        const seconds = Math.floor(now / 1000) - 60;
        expect(captureTime(`/media/1?ts=${seconds}`, now)).to.equal(seconds * 1000);
        expect(captureTime(`/media/1?ts=${now - 60_000}`, now)).to.equal(now - 60_000);
        expect(captureTime('/media/1?ts=2026-11-08T10:00:00Z', now)).to.equal(Date.UTC(2026, 10, 8, 10));
    });

    it('does not believe a missing, odd or future time', () => {
        expect(captureTime('/media/1', now)).to.equal(undefined);
        expect(captureTime('/media/1?ts=abc', now)).to.equal(undefined);
        expect(captureTime('/media/1?ts=1000000000', now), 'before 2020').to.equal(undefined);
        expect(captureTime(`/media/1?ts=${now + HOUR}`, now), 'in the future').to.equal(undefined);
    });
});

describe('model/image-store', () => {
    it('stores a new image and its address, not the address at Blink', async () => {
        const { store, files, states } = setup();
        await store.sync([device(5, '/media/5/a?ts=1700000000')]);

        expect(files.get(fileName(5))?.toString()).to.equal('image of /media/5/a?ts=1700000000');
        expect(states.get('cameras.5.image')).to.match(/^\/blink\.0\/cameras\/5\.jpg\?t=\d+$/);
        expect(states.get('cameras.5.imageTime')).to.equal(1_700_000_000_000);
        expect(JSON.stringify([...states])).to.not.contain('/media/5');
    });

    it('fetches an image only once', async () => {
        const { store, downloads } = setup();
        await store.sync([device(5, '/a')]);
        await store.sync([device(5, '/a')]);
        expect(downloads).to.deep.equal(['/a']);
    });

    it('does not fetch again after a restart', async () => {
        const first = setup();
        await first.store.sync([device(5, '/a')]);
        const stored = new Map<number, unknown>([[5, first.states.get('cameras.5.imageInfo')]]);

        const second = setup({ stored });
        await second.store.sync([device(5, '/a')]);
        expect(second.downloads).to.deep.equal([]);
    });

    it('survives damaged stored data', async () => {
        const { store, downloads } = setup({
            stored: new Map<number, unknown>([
                [5, '{broken'],
                [6, '{"ref":1}'],
                [7, null],
            ]),
        });
        await store.sync([device(5, '/a'), device(6, '/b'), device(7, '/c')]);
        expect(downloads).to.have.lengthOf(3);
    });

    it('keeps the unknown age of an image without a time as 0', async () => {
        const { store, states } = setup();
        await store.sync([device(5, '/a')]);
        expect(states.get('cameras.5.imageTime')).to.equal(0);
    });

    it('does not make an old image look new when only its address changes', async () => {
        const { store, states, responses } = setup();
        responses.set('/a?ts=1700000000', Buffer.from('same'));
        responses.set('/b?ts=1700000999', Buffer.from('same'));
        await store.sync([device(5, '/a?ts=1700000000')]);
        const image = states.get('cameras.5.image');
        await store.sync([device(5, '/b?ts=1700000999')]);

        expect(states.get('cameras.5.imageTime')).to.equal(1_700_000_000_000);
        expect(states.get('cameras.5.image')).to.equal(image);
    });

    it('leaves a camera alone while its snapshot is running', async () => {
        const { store, downloads } = setup();
        store.block(5, true);
        await store.sync([device(5, '/a')]);
        expect(downloads).to.deep.equal([]);
        store.block(5, false);
        await store.sync([device(5, '/a')]);
        expect(downloads).to.deep.equal(['/a']);
    });

    it('skips devices without an image', async () => {
        const { store, downloads } = setup();
        await store.sync([device(5, undefined)]);
        expect(downloads).to.deep.equal([]);
    });

    it('goes on after a broken image and does not try it on every poll', async () => {
        const { store, downloads, files, responses, messages } = setup();
        responses.set('/a', new ApiError('Downloading', 404));
        await store.sync([device(5, '/a'), device(6, '/b')]);
        expect(files.has(fileName(6))).to.equal(true);
        expect(messages.join()).to.contain('Camera 5');

        await store.sync([device(5, '/a'), device(6, '/b')]);
        expect(downloads).to.deep.equal(['/a', '/b']);

        await store.sync([device(5, '/a2'), device(6, '/b')]);
        expect(files.has(fileName(5)), 'a new image is tried').to.equal(true);
    });

    it('stops for this poll when the whole cloud has a problem', async () => {
        const { store, downloads, responses } = setup();
        responses.set('/a', new RateLimitedError(1000));
        await store.sync([device(5, '/a'), device(6, '/b')]);
        expect(downloads).to.deep.equal(['/a']);

        responses.delete('/a');
        await store.sync([device(5, '/a'), device(6, '/b')]);
        expect(downloads, 'tried again on the next poll').to.deep.equal(['/a', '/a', '/b']);
    });

    describe('retention', () => {
        it('keeps images within the period', async () => {
            const { store, files } = setup();
            await store.sync([device(5, '/a')]);
            await store.expire(Date.now() + 23 * HOUR);
            expect(files.has(fileName(5))).to.equal(true);
        });

        it('deletes older images and empties the states', async () => {
            const { store, files, states } = setup();
            await store.sync([device(5, '/a?ts=1700000000')]);
            await store.expire(Date.now() + 25 * HOUR);
            expect(files.has(fileName(5))).to.equal(false);
            expect(states.get('cameras.5.image')).to.equal('');
            expect(states.get('cameras.5.imageTime')).to.equal(0);
        });

        it('does not fetch a deleted image again, only a new one', async () => {
            const { store, files, downloads } = setup();
            await store.sync([device(5, '/a')]);
            await store.expire(Date.now() + 25 * HOUR);
            await store.sync([device(5, '/a')]);
            expect(downloads).to.deep.equal(['/a']);
            await store.sync([device(5, '/b')]);
            expect(files.has(fileName(5))).to.equal(true);
        });

        it('also deletes images of cameras Blink no longer reports', async () => {
            const first = setup();
            await first.store.sync([device(5, '/a')]);
            const stored = new Map<number, unknown>([[5, first.states.get('cameras.5.imageInfo')]]);

            const second = setup({ stored });
            second.files.set(fileName(5), Buffer.from('old'));
            await second.store.expire(Date.now() + 25 * HOUR);
            expect(second.files.has(fileName(5))).to.equal(false);
        });

        it('tries again if a file could not be deleted', async () => {
            const { store, files, failDelete, states } = setup();
            await store.sync([device(5, '/a')]);
            failDelete.error = new Error('disk gone');
            await store.expire(Date.now() + 25 * HOUR);
            expect(states.get('cameras.5.image')).to.not.equal('');

            failDelete.error = undefined;
            await store.expire(Date.now() + 25 * HOUR);
            expect(files.has(fileName(5))).to.equal(false);
            expect(states.get('cameras.5.image')).to.equal('');
        });

        it('accepts a file that is already gone', async () => {
            const { store, failDelete, states } = setup();
            await store.sync([device(5, '/a')]);
            failDelete.error = new Error('Not exists');
            await store.expire(Date.now() + 25 * HOUR);
            expect(states.get('cameras.5.image')).to.equal('');
        });
    });

    it('hashes text and files alike', () => {
        expect(hashOf('a')).to.equal(hashOf(Buffer.from('a')));
    });
});
