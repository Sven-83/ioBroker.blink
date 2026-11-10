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
    /** Can be switched by the user */
    write?: boolean;
    /** A button has nothing to read */
    read?: boolean;
    /** Text of the possible values */
    states?: Record<string, string>;
    /** Polled value. Without it the state belongs to a command: created always, never written when polling */
    get?: (item: T) => ioBroker.StateValue | undefined;
    /** Value after the start of the adapter, for a state without polled value */
    initial?: ioBroker.StateValue;
    /** Default value in the object (common.def) */
    def?: ioBroker.StateValue;
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
    { key: 'armed', name: 'Armed', type: 'boolean', role: 'switch', write: true, get: item => item.armed },
    { key: 'armPending', name: 'Arm command running', type: 'boolean', role: 'indicator.working', initial: false },
    {
        key: 'armResult',
        name: 'Result of the last arm command',
        type: 'string',
        role: 'text',
        states: { confirmed: 'confirmed', rejected: 'rejected', unconfirmed: 'not confirmed' },
    },
    // a setting of the user: neither polled nor reset on start, see arm-selection.ts
    {
        key: 'armWithAll',
        name: 'Armed by "arm selected"',
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: true,
    },
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
    {
        key: 'enabled',
        name: 'Motion detection enabled',
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        get: item => item.enabled,
    },
    {
        key: 'motionPending',
        name: 'Motion detection command running',
        type: 'boolean',
        role: 'indicator.working',
        initial: false,
    },
    {
        key: 'motionResult',
        name: 'Result of the last motion detection command',
        type: 'string',
        role: 'text',
        states: { confirmed: 'confirmed', rejected: 'rejected', unconfirmed: 'not confirmed' },
    },
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
    { key: 'snapshot', name: 'Take a snapshot', type: 'boolean', role: 'button', read: false, write: true },
    { key: 'snapshotPending', name: 'Snapshot running', type: 'boolean', role: 'indicator.working', initial: false },
    {
        key: 'snapshotResult',
        name: 'Result of the last snapshot',
        type: 'string',
        role: 'text',
        states: {
            confirmed: 'new image',
            unconfirmed: 'no new image',
            rejected: 'failed',
            busy: 'Blink is busy',
            offline: 'camera offline',
            throttled: 'image is still recent',
        },
    },
    // motion clips (phase 7.2): written by the motion tracker, not from the homescreen
    { key: 'motionTime', name: 'Time of the last motion clip', type: 'number', role: 'value.time' },
    {
        key: 'motionDetection',
        name: 'Detected in the last motion clip (person, animal, vehicle, package), empty if nothing',
        type: 'string',
        role: 'text',
    },
    {
        key: 'motionSource',
        name: 'What started the last motion clip',
        type: 'string',
        role: 'text',
        states: { pir: 'motion sensor', cv_motion: 'camera detection' },
    },
    { key: 'image', name: 'Address of the last image', type: 'string', role: 'url' },
    { key: 'imageTime', name: 'Time of the last image, 0 if unknown', type: 'number', role: 'value.time' },
    { key: 'imageInfo', name: 'Internal data of the last image', type: 'string', role: 'json' },
    { key: 'liveActive', name: 'Live image running', type: 'boolean', role: 'indicator.working', initial: false },
    {
        key: 'liveResult',
        name: 'State of the live image',
        type: 'string',
        role: 'text',
        states: {
            running: 'running',
            ended: 'ended',
            idle: 'ended, nobody watched',
            failed: 'failed',
            certificate: 'certificate of the stream server not accepted',
            noFfmpeg: 'ffmpeg not found',
            offline: 'camera offline',
            unsupported: 'not offered by Blink for this camera',
            disabled: 'switched off in the settings',
            busy: 'another live image is running',
            rejected: 'not possible at the moment',
        },
    },
];

/** Keeps the object tree in line with the homescreen, with as few database writes as possible */
export class ObjectTree {
    private readonly objects = new Map<string, string>();
    private readonly values = new Map<string, ioBroker.StateValue>();
    private readonly held = new Set<string>();
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
                const id = `${base}.${def.key}`;
                const value = def.get ? def.get(item) : this.values.has(id) ? undefined : def.initial;
                if (value === undefined && def.get) {
                    continue;
                }
                await this.ensureObject(id, {
                    type: 'state',
                    common: {
                        name: def.name,
                        type: def.type,
                        role: def.role,
                        read: def.read ?? true,
                        write: def.write ?? false,
                        ...(def.unit ? { unit: def.unit } : {}),
                        ...(def.states ? { states: def.states } : {}),
                        ...(def.def !== undefined ? { def: def.def } : {}),
                    },
                    native: {},
                });
                if (value !== undefined) {
                    await this.setValue(id, value);
                }
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

    /**
     * Last value written to a state.
     *
     * @param id - Relative state ID
     */
    public value(id: string): ioBroker.StateValue | undefined {
        return this.values.get(id);
    }

    /**
     * Keeps polled values away from a state while a command is running on it.
     *
     * @param id - Relative state ID
     */
    public hold(id: string): void {
        this.held.add(id);
    }

    /**
     * Ends hold(). The value is written even if it equals the last one: it has to replace the
     * user's unacknowledged request.
     *
     * @param id - Relative state ID
     * @param value - Real value; if unknown the state stays as it is until the next poll
     */
    public async release(id: string, value: ioBroker.StateValue | undefined): Promise<void> {
        this.held.delete(id);
        this.values.delete(id);
        if (value !== undefined) {
            await this.setValue(id, value);
        }
    }

    /**
     * Writes a state with ack: true if its value has changed.
     *
     * @param id - Relative state ID
     * @param value - New value
     * @returns The value was written
     */
    public async setValue(id: string, value: ioBroker.StateValue): Promise<boolean> {
        if (this.held.has(id) || this.values.get(id) === value) {
            return false;
        }
        await this.host.writeState(id, value);
        this.values.set(id, value);
        return true;
    }
}
