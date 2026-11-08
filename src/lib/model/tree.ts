/*
 * Object tree of the adapter: networks.<id>, syncModules.<id>, cameras.<id>.
 * IDs of the API are the object IDs, so renaming a device in the Blink app keeps its states.
 * States are created when Blink first reports a value (a Mini has no battery) and only written on change.
 */

import type { BlinkDevice, BlinkNetwork, BlinkSyncModule, Homescreen } from '../api/homescreen';

/** What the tree needs from the adapter */
export interface TreeHost {
    /** Creates or extends an object */
    writeObject(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    /** Writes a state with ack: true */
    writeState(id: string, value: ioBroker.StateValue): Promise<unknown>;
    /** Relative IDs of all device objects from earlier runs */
    listDevices(): Promise<string[]>;
    /** Log message */
    info(message: string): void;
}

interface StateDef<T> {
    key: string;
    name: string;
    type: 'string' | 'number' | 'boolean';
    role: string;
    unit?: string;
    get: (item: T) => ioBroker.StateValue | undefined;
}

const AVAILABLE_KEY = 'available';

function common<T>(): StateDef<T & { name: string }>[] {
    return [
        { key: 'name', name: 'Name', type: 'string', role: 'info.name', get: item => item.name },
        {
            key: AVAILABLE_KEY,
            name: 'Reported by Blink',
            type: 'boolean',
            role: 'indicator.reachable',
            get: () => true,
        },
    ];
}

const NETWORK_STATES: StateDef<BlinkNetwork>[] = [
    ...common<BlinkNetwork>(),
    { key: 'armed', name: 'Armed', type: 'boolean', role: 'indicator', get: item => item.armed },
];

const SYNC_STATES: StateDef<BlinkSyncModule>[] = [
    ...common<BlinkSyncModule>(),
    { key: 'networkId', name: 'Network ID', type: 'number', role: 'info', get: item => item.networkId },
    { key: 'serial', name: 'Serial number', type: 'string', role: 'info.serial', get: item => item.serial },
    { key: 'status', name: 'Status', type: 'string', role: 'info.status', get: item => item.status },
    {
        key: 'localStorageEnabled',
        name: 'Local storage enabled',
        type: 'boolean',
        role: 'indicator',
        get: item => item.localStorageEnabled,
    },
    {
        key: 'localStorageStatus',
        name: 'Local storage status',
        type: 'string',
        role: 'info.status',
        get: item => item.localStorageStatus,
    },
];

const DEVICE_STATES: StateDef<BlinkDevice>[] = [
    ...common<BlinkDevice>(),
    { key: 'kind', name: 'Device family', type: 'string', role: 'info', get: item => item.kind },
    { key: 'type', name: 'Model', type: 'string', role: 'info', get: item => item.type },
    { key: 'networkId', name: 'Network ID', type: 'number', role: 'info', get: item => item.networkId },
    { key: 'serial', name: 'Serial number', type: 'string', role: 'info.serial', get: item => item.serial },
    { key: 'status', name: 'Status', type: 'string', role: 'info.status', get: item => item.status },
    { key: 'enabled', name: 'Motion detection enabled', type: 'boolean', role: 'indicator', get: item => item.enabled },
    { key: 'batteryLow', name: 'Battery low', type: 'boolean', role: 'indicator.lowbat', get: item => item.batteryLow },
    { key: 'batteryLevel', name: 'Battery bars', type: 'number', role: 'value', get: item => item.batteryLevel },
    {
        key: 'batteryVoltage',
        name: 'Battery voltage',
        type: 'number',
        role: 'value.voltage',
        unit: 'V',
        get: item => item.batteryVoltage,
    },
    {
        key: 'temperature',
        name: 'Temperature',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        get: item => item.temperature,
    },
    { key: 'wifi', name: 'Wi-Fi signal bars', type: 'number', role: 'value', get: item => item.wifi },
    { key: 'lfr', name: 'Signal bars to the Sync Module', type: 'number', role: 'value', get: item => item.lfr },
];

/** Keeps the object tree in line with the homescreen, with as few database writes as possible */
export class ObjectTree {
    private readonly objects = new Map<string, string>();
    private readonly values = new Map<string, ioBroker.StateValue>();
    private known: Set<string> | undefined;

    /**
     * @param host - Adapter functions
     */
    public constructor(private readonly host: TreeHost) {}

    /**
     * Writes a homescreen into the tree. Devices Blink no longer reports stay (with their history and
     * scripts referring to them) and get available = false; removing them is the user's decision.
     *
     * @param homescreen - Current homescreen
     */
    public async apply(homescreen: Homescreen): Promise<void> {
        const seen = new Set<string>();
        await this.section('networks', 'Networks', homescreen.networks, NETWORK_STATES, seen);
        await this.section('syncModules', 'Sync Modules', homescreen.syncModules, SYNC_STATES, seen);
        await this.section('cameras', 'Cameras', homescreen.devices, DEVICE_STATES, seen);

        this.known ??= new Set(await this.host.listDevices());
        for (const id of this.known) {
            if (!seen.has(id) && (await this.setValue(`${id}.${AVAILABLE_KEY}`, false))) {
                this.host.info(`${id} is no longer reported by Blink`);
            }
        }
        for (const id of seen) {
            this.known.add(id);
        }
    }

    private async section<T extends { id: number; name: string }>(
        folder: string,
        folderName: string,
        items: T[],
        defs: StateDef<T>[],
        seen: Set<string>,
    ): Promise<void> {
        if (items.length > 0) {
            await this.ensureObject(folder, { type: 'folder', common: { name: folderName }, native: {} });
        }
        for (const item of items) {
            const base = `${folder}.${item.id}`;
            seen.add(base);
            await this.ensureObject(base, { type: 'device', common: { name: item.name }, native: {} });
            for (const def of defs) {
                const value = def.get(item);
                if (value === undefined) {
                    continue;
                }
                const id = `${base}.${def.key}`;
                await this.ensureObject(id, {
                    type: 'state',
                    common: {
                        name: def.name,
                        type: def.type,
                        role: def.role,
                        read: true,
                        write: false,
                        ...(def.unit ? { unit: def.unit } : {}),
                    },
                    native: {},
                });
                await this.setValue(id, value);
            }
        }
    }

    private async ensureObject(id: string, object: ioBroker.SettableObject): Promise<void> {
        const signature = JSON.stringify(object);
        if (this.objects.get(id) !== signature) {
            await this.host.writeObject(id, object);
            this.objects.set(id, signature);
        }
    }

    private async setValue(id: string, value: ioBroker.StateValue): Promise<boolean> {
        if (this.values.get(id) === value) {
            return false;
        }
        await this.host.writeState(id, value);
        this.values.set(id, value);
        return true;
    }
}
