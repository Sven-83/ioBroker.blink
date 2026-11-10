/*
 * Media list of the Blink cloud (motion clips with thumbnail and detection), `media/changed`.
 * Format seen on a real account on 10.11.2026: { limit, purge_id, refresh_count, media: [ { id, created_at,
 * updated_at, deleted, device_id, network_id, type: "video", source: "pir" | "cv_motion" | "snapshot", thumbnail,
 * media, metadata: JSON text with pts_length_ms and, on a detection, cv_detection: ["person"] } ] }.
 * Deleted entries are reported as well.
 */

import { toId } from './homescreen';
import { field, parseJson } from './http';

/** One entry of the media list */
export interface MediaEntry {
    /** ID of the clip */
    id: number;
    /** Device that recorded it */
    deviceId: number;
    /** Network of the device */
    networkId: number | undefined;
    /** Time of the recording (ms) */
    createdAt: number;
    /** Deleted in the app */
    deleted: boolean;
    /** "video" for a clip */
    type: string;
    /** What started it: "pir" (motion sensor), "cv_motion" (camera detection), "snapshot" (photo) */
    source: string;
    /** What Blink detected (person, animal, vehicle, package), empty if nothing */
    detections: string[];
    /** Length of the clip in ms */
    lengthMs: number | undefined;
    /** Address of the clip at Blink, never stored or logged */
    media: string | undefined;
    /** Address of the thumbnail at Blink, never stored or logged */
    thumbnail: string | undefined;
}

/** A page of the media list */
export interface MediaPage {
    /** Readable entries of the page */
    entries: MediaEntry[];
    /** Entries Blink sends at most per page */
    limit: number | undefined;
}

/** Detection names allowed into states: lower case words only */
const DETECTION = /^[a-z][a-z_]{0,29}$/;

/**
 * Non-empty text, otherwise undefined.
 *
 * @param value - Raw value
 */
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * Detections of an entry from its metadata (JSON text or object).
 *
 * @param metadata - Raw metadata
 */
function detectionsOf(metadata: unknown): { detections: string[]; lengthMs: number | undefined } {
    const parsed: unknown = typeof metadata === 'string' ? parseJson(metadata) : metadata;
    const raw = field(parsed, 'cv_detection');
    const detections = (Array.isArray(raw) ? raw : [])
        .map(item => (typeof item === 'string' ? item : field(item, 'type')))
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim().toLowerCase())
        .filter(item => DETECTION.test(item));
    const length = field(parsed, 'pts_length_ms');
    return {
        detections: [...new Set(detections)],
        lengthMs: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : undefined,
    };
}

/**
 * One entry, undefined if it lacks what is needed (ID, device, time).
 *
 * @param entry - Raw entry
 */
function parseEntry(entry: unknown): MediaEntry | undefined {
    const id = toId(field(entry, 'id'));
    const deviceId = toId(field(entry, 'device_id'));
    const created = field(entry, 'created_at');
    const createdAt = typeof created === 'string' ? Date.parse(created) : NaN;
    if (id === undefined || deviceId === undefined || !Number.isFinite(createdAt)) {
        return undefined;
    }
    return {
        id,
        deviceId,
        networkId: toId(field(entry, 'network_id')),
        createdAt,
        deleted: field(entry, 'deleted') === true,
        type: text(field(entry, 'type')) ?? '',
        source: text(field(entry, 'source')) ?? '',
        ...detectionsOf(field(entry, 'metadata')),
        media: text(field(entry, 'media')),
        thumbnail: text(field(entry, 'thumbnail')),
    };
}

/**
 * A page of `media/changed`, undefined if the answer is not one.
 *
 * @param body - Parsed answer
 */
export function parseMediaPage(body: unknown): MediaPage | undefined {
    const media = field(body, 'media');
    if (!Array.isArray(media)) {
        return undefined;
    }
    const limit = toId(field(body, 'limit'));
    return {
        entries: media.map(parseEntry).filter((entry): entry is MediaEntry => entry !== undefined),
        limit,
    };
}

/** Longest text of a sample value in the overview */
const SAMPLE_TEXT = 60;

/** Deepest level shown in the sample (detections lie in nested lists) */
const SAMPLE_DEPTH = 4;

/**
 * Type of a JSON value for the overview.
 *
 * @param value - Value
 */
function kind(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return `array(${value.length})`;
    }
    return typeof value;
}

/**
 * A value shortened for the log: addresses replaced (they lead to the clips and images, never into the log),
 * long texts cut, nesting limited, arrays with the first entry only.
 *
 * @param value - Value
 * @param depth - Nesting level
 */
function sample(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        if (/^(\/|https?:|wss?:|rtsps?:|immis?:)/i.test(value) || /\.(mp4|jpe?g|m3u8)\b/i.test(value)) {
            return `<address ${value.length}>`;
        }
        return value.length > SAMPLE_TEXT ? `${value.slice(0, SAMPLE_TEXT)}…(${value.length})` : value;
    }
    if (Array.isArray(value)) {
        return depth >= SAMPLE_DEPTH
            ? `array(${value.length})`
            : value.slice(0, 1).map(item => sample(item, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
        if (depth >= SAMPLE_DEPTH) {
            return 'object';
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sample(item, depth + 1)]));
    }
    return value;
}

/**
 * Overview of one page of `media/changed`: top-level fields, number of entries, the fields of all entries with
 * their types and the newest entry shortened.
 *
 * @param body - Parsed answer
 */
export function describeMediaPage(body: unknown): string {
    if (body === null || typeof body !== 'object') {
        return `no object: ${kind(body)}`;
    }
    const top = Object.entries(body)
        .map(([key, value]) => `${key}:${kind(value)}`)
        .join(', ');
    const media = field(body, 'media');
    if (!Array.isArray(media)) {
        return `top {${top}}, no "media" list`;
    }
    const fields = new Map<string, Set<string>>();
    for (const entry of media) {
        if (entry !== null && typeof entry === 'object') {
            for (const [key, value] of Object.entries(entry)) {
                const kinds = fields.get(key) ?? new Set<string>();
                kinds.add(kind(value).replace(/\(\d+\)$/, ''));
                fields.set(key, kinds);
            }
        }
    }
    const fieldList = [...fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, kinds]) => `${key}:${[...kinds].join('|')}`)
        .join(', ');
    return (
        `top {${top}}, ${media.length} entries, fields {${fieldList}}, ` +
        `values {${countValues(media, 'type')}; ${countValues(media, 'source')}}, ` +
        `metadata {${metadataKeys(media)}}, first ${JSON.stringify(sample(media[0]))}`
    );
}

/**
 * How often each value of a short text field occurs, e.g. `source: pir 12, cv_motion 3`.
 *
 * @param media - Entries
 * @param key - Field
 */
function countValues(media: unknown[], key: string): string {
    const counts = new Map<string, number>();
    for (const entry of media) {
        const value = field(entry, key);
        const text = typeof value === 'string' && value.length <= 30 ? value : kind(value);
        counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return `${key}: ${[...counts].map(([value, n]) => `${value} ${n}`).join(', ')}`;
}

/**
 * Keys inside "metadata" (Blink sends it as JSON text) over all entries, with a sample of each value. The
 * detections (person, animal, ...) are expected here.
 *
 * @param media - Entries
 */
function metadataKeys(media: unknown[]): string {
    const keys = new Map<string, unknown>();
    for (const entry of media) {
        const raw = field(entry, 'metadata');
        const parsed: unknown = typeof raw === 'string' ? parseJson(raw) : raw;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed)) {
                if (!keys.has(key)) {
                    keys.set(key, sample(value, 1));
                }
            }
        }
    }
    return [...keys].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
}
