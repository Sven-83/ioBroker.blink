/*
 * Normalizes the answer of GET /api/v3/accounts/{id}/homescreen. Blink changes field names and nesting
 * between device generations; the variants handled here are known from community clients
 * (e.g. Pischleuder1/ioBroker.blink, MIT). Only this request is used, so polling never wakes a battery camera.
 */

import { field } from './http';

/** Device family, taken from the list the device is reported in - never from fixed device IDs */
export type DeviceKind = 'camera' | 'mini' | 'doorbell';

/** Blink network ("system") */
export interface BlinkNetwork {
    /** Network ID */
    id: number;
    /** Display name */
    name: string;
    /** Armed state */
    armed: boolean | undefined;
}

/** Sync Module */
export interface BlinkSyncModule {
    /** Sync Module ID */
    id: number;
    /** Display name */
    name: string;
    /** Network it belongs to */
    networkId: number | undefined;
    /** Serial number */
    serial: string | undefined;
    /** e.g. "online" */
    status: string | undefined;
    /** Local storage switched on */
    localStorageEnabled: boolean | undefined;
    /** e.g. "active" */
    localStorageStatus: string | undefined;
}

/** Camera, Mini or doorbell */
export interface BlinkDevice {
    /** Device ID */
    id: number;
    /** Device family */
    kind: DeviceKind;
    /** Display name */
    name: string;
    /** Model name of the API, e.g. "catalina" */
    type: string | undefined;
    /** Network it belongs to */
    networkId: number | undefined;
    /** Serial number */
    serial: string | undefined;
    /** Status text of the API */
    status: string | undefined;
    /** Motion detection switched on */
    enabled: boolean | undefined;
    /** Blink reports a low battery */
    batteryLow: boolean | undefined;
    /** Battery bars */
    batteryLevel: number | undefined;
    /** Battery voltage in V */
    batteryVoltage: number | undefined;
    /** Temperature in °C */
    temperature: number | undefined;
    /** Wi-Fi signal bars */
    wifi: number | undefined;
    /** Signal bars to the Sync Module */
    lfr: number | undefined;
    /** Address of the last image at Blink. Stays in memory: it does not belong into states or the log */
    thumbnail: string | undefined;
}

/** Normalized homescreen */
export interface Homescreen {
    /** All networks */
    networks: BlinkNetwork[];
    /** All Sync Modules */
    syncModules: BlinkSyncModule[];
    /** All cameras, Minis and doorbells */
    devices: BlinkDevice[];
}

function first(...values: unknown[]): unknown {
    return values.find(value => value !== undefined && value !== null);
}

/**
 * Positive integer ID of the API, undefined for anything else.
 *
 * @param value - Raw value
 */
export function toId(value: unknown): number | undefined {
    const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'string' && !value.trim()) {
        return undefined;
    }
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
}

function toText(value: unknown): string | undefined {
    if (typeof value === 'number') {
        return String(value);
    }
    return typeof value === 'string' && value ? value : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/**
 * Battery voltage in V. Blink sends either volts or hundredths of a volt.
 *
 * @param value - Raw value
 */
export function toVolt(value: unknown): number | undefined {
    const raw = toNumber(value);
    if (raw === undefined) {
        return undefined;
    }
    return round(Math.abs(raw) >= 10 ? raw / 100 : raw, 2);
}

function temperature(fahrenheit: unknown, celsius: unknown): number | undefined {
    const c = toNumber(celsius);
    if (c !== undefined) {
        return round(c, 1);
    }
    const f = toNumber(fahrenheit);
    return f === undefined ? undefined : round(((f - 32) * 5) / 9, 1);
}

function parseNetwork(entry: unknown): BlinkNetwork | undefined {
    const network = field(entry, 'network') ?? entry;
    const id = toId(first(field(network, 'id'), field(network, 'network_id')));
    if (id === undefined) {
        return undefined;
    }
    return {
        id,
        name: toText(field(network, 'name')) ?? String(id),
        armed: toBoolean(field(network, 'armed')),
    };
}

function parseSyncModule(entry: unknown, networkId?: number): BlinkSyncModule | undefined {
    const sync = field(entry, 'sync_module') ?? entry;
    const id = toId(first(field(sync, 'id'), field(sync, 'sync_module_id')));
    if (id === undefined) {
        return undefined;
    }
    return {
        id,
        name: toText(field(sync, 'name')) ?? String(id),
        networkId: toId(field(sync, 'network_id')) ?? networkId,
        serial: toText(first(field(sync, 'serial'), field(sync, 'serial_number'))),
        status: toText(field(sync, 'status')),
        localStorageEnabled: toBoolean(field(sync, 'local_storage_enabled')),
        localStorageStatus: toText(field(sync, 'local_storage_status')),
    };
}

function parseDevice(entry: unknown, kind: DeviceKind): BlinkDevice | undefined {
    const device = field(entry, 'device') ?? entry;
    const rawStatus = first(field(entry, 'camera_status'), field(entry, 'status'), field(device, 'status'));
    const status = typeof rawStatus === 'object' ? rawStatus : undefined;
    const signals = first(field(status, 'signals'), field(device, 'signals'), field(entry, 'signals'));
    const value = (...keys: string[]): unknown =>
        first(...keys.flatMap(key => [field(signals, key), field(status, key), field(device, key), field(entry, key)]));

    const id = toId(first(field(device, 'id'), field(device, 'camera_id'), field(entry, 'id')));
    if (id === undefined) {
        return undefined;
    }
    const battery = first(field(device, 'battery'), field(entry, 'battery'));
    return {
        id,
        kind,
        name: toText(first(field(device, 'name'), field(entry, 'name'))) ?? String(id),
        type: toText(first(field(device, 'type'), field(entry, 'type'))),
        networkId: toId(value('network_id')),
        serial: toText(value('serial')),
        status: typeof rawStatus === 'object' ? undefined : toText(rawStatus),
        enabled: toBoolean(value('enabled')),
        batteryLow: typeof battery === 'string' ? battery.toLowerCase() === 'low' : undefined,
        batteryLevel: toNumber(first(field(signals, 'battery'), value('battery_level'))),
        batteryVoltage: toVolt(value('battery_voltage', 'battery_volt')),
        temperature: temperature(value('temp', 'temperature', 'temp_f'), value('temp_c', 'temperature_c')),
        wifi: toNumber(value('wifi', 'wifi_strength')),
        lfr: toNumber(value('lfr', 'lfr_strength')),
        thumbnail: toText(value('thumbnail')),
    };
}

/**
 * Normalizes a homescreen answer. Entries without a valid ID are skipped.
 *
 * @param body - Parsed JSON
 * @returns The homescreen, or undefined if the answer is not a homescreen at all
 */
export function parseHomescreen(body: unknown): Homescreen | undefined {
    const rawNetworks = field(body, 'networks');
    if (!Array.isArray(rawNetworks)) {
        return undefined;
    }
    const networks = rawNetworks.map(parseNetwork).filter(item => item !== undefined);

    const syncById = new Map<number, BlinkSyncModule>();
    for (const entry of list(field(body, 'sync_modules'))) {
        const sync = parseSyncModule(entry);
        if (sync) {
            syncById.set(sync.id, sync);
        }
    }
    // some accounts report the Sync Module inside the network
    for (const entry of rawNetworks) {
        const network = field(entry, 'network') ?? entry;
        const nested = first(field(entry, 'sync_module'), field(network, 'sync_module'));
        const sync = nested === undefined ? undefined : parseSyncModule(nested, parseNetwork(entry)?.id);
        if (sync && !syncById.has(sync.id)) {
            syncById.set(sync.id, sync);
        }
    }

    const families: [string, DeviceKind][] = [
        ['cameras', 'camera'],
        ['owls', 'mini'],
        ['doorbells', 'doorbell'],
    ];
    const devices = families.flatMap(([key, kind]) =>
        list(field(body, key))
            .map(entry => parseDevice(entry, kind))
            .filter(item => item !== undefined),
    );
    return { networks, syncModules: [...syncById.values()], devices };
}
