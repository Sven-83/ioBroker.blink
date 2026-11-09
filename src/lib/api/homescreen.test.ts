import { expect } from 'chai';
import { parseHomescreen, toVolt } from './homescreen';

describe('api/homescreen', () => {
    it('rejects answers that are not a homescreen', () => {
        expect(parseHomescreen(undefined)).to.equal(undefined);
        expect(parseHomescreen({})).to.equal(undefined);
        expect(parseHomescreen({ networks: 'x' })).to.equal(undefined);
    });

    it('accepts an account without devices', () => {
        expect(parseHomescreen({ networks: [] })).to.deep.equal({ networks: [], syncModules: [], devices: [] });
    });

    it('takes the device family from the list, not from IDs', () => {
        const parsed = parseHomescreen({
            networks: [],
            cameras: [{ id: 1, name: 'a' }],
            owls: [{ id: 2, name: 'b' }],
            doorbells: [{ id: 3, name: 'c' }],
        });
        expect(parsed?.devices.map(device => device.kind)).to.deep.equal(['camera', 'mini', 'doorbell']);
    });

    it('reads a flat camera', () => {
        const parsed = parseHomescreen({
            networks: [],
            cameras: [
                {
                    id: 1,
                    name: 'a',
                    network_id: 9,
                    serial: 'X1',
                    type: 'catalina',
                    enabled: true,
                    status: 'done',
                    battery: 'ok',
                    thumbnail: '/media/1/a?ts=1',
                    signals: { lfr: 5, wifi: 4, temp: 68, battery: 3 },
                },
            ],
        });
        expect(parsed?.devices[0]).to.deep.equal({
            id: 1,
            kind: 'camera',
            name: 'a',
            type: 'catalina',
            networkId: 9,
            serial: 'X1',
            status: 'done',
            enabled: true,
            batteryLow: false,
            batteryLevel: 3,
            batteryVoltage: undefined,
            temperature: 20,
            wifi: 4,
            lfr: 5,
            thumbnail: '/media/1/a?ts=1',
        });
    });

    it('reads nested device data and a status object', () => {
        const parsed = parseHomescreen({
            networks: [],
            doorbells: [
                {
                    device: { camera_id: '7', name: 'b', network_id: '9', battery: 'LOW' },
                    camera_status: { battery_voltage: 148, temperature_c: 12.34, wifi_strength: 2 },
                },
            ],
        });
        const device = parsed?.devices[0];
        expect(device).to.include({ id: 7, networkId: 9, batteryLow: true, batteryVoltage: 1.48, temperature: 12.3 });
        expect(device?.wifi).to.equal(2);
        expect(device?.status).to.equal(undefined);
    });

    it('leaves missing values undefined instead of inventing them', () => {
        const device = parseHomescreen({ networks: [], owls: [{ id: 1 }] })?.devices[0];
        expect(device?.name).to.equal('1');
        expect(device?.batteryLow).to.equal(undefined);
        expect(device?.temperature).to.equal(undefined);
        expect(device?.wifi).to.equal(undefined);
    });

    it('keeps a value of 0', () => {
        const device = parseHomescreen({ networks: [], cameras: [{ id: 1, signals: { wifi: 0, temp: 32 } }] })
            ?.devices[0];
        expect(device?.wifi).to.equal(0);
        expect(device?.temperature).to.equal(0);
    });

    it('skips entries without a valid ID', () => {
        const parsed = parseHomescreen({
            networks: [{ name: 'x' }, { id: -1 }, { id: 'a.b' }, null, { id: 5, name: 'ok', armed: false }],
            cameras: [{ name: 'x' }, { id: '../1' }],
        });
        expect(parsed?.networks).to.deep.equal([{ id: 5, name: 'ok', armed: false }]);
        expect(parsed?.devices).to.deep.equal([]);
    });

    it('finds Sync Modules at both places without duplicates', () => {
        const parsed = parseHomescreen({
            networks: [
                { id: 1, name: 'n1', sync_module: { id: 11, name: 'nested', serial: 'S1' } },
                { network: { id: 2, name: 'n2' }, sync_module: { id: 12, name: 'twice' } },
            ],
            sync_modules: [{ sync_module: { id: 12, name: 'top', network_id: 2, status: 'online' } }],
        });
        expect(parsed?.networks.map(network => network.id)).to.deep.equal([1, 2]);
        expect(parsed?.syncModules.map(sync => [sync.id, sync.name, sync.networkId])).to.deep.equal([
            [12, 'top', 2],
            [11, 'nested', 1],
        ]);
    });

    it('converts battery values to volts', () => {
        expect(toVolt(148)).to.equal(1.48);
        expect(toVolt('2.9')).to.equal(2.9);
        expect(toVolt('')).to.equal(undefined);
        expect(toVolt(null)).to.equal(undefined);
    });
});
