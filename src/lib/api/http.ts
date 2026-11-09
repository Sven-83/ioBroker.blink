/*
 * Small HTTP layer on top of the global fetch: timeout, manual redirects, cookie jar, test origin.
 */

import { RATE_LIMIT_FALLBACK_S, REQUEST_TIMEOUT_MS } from './constants';
import { AbortedError } from './errors';

/** Response with the body already read as text */
export interface HttpResponse {
    /** HTTP status */
    status: number;
    /** Response headers */
    headers: Headers;
    /** Body as text */
    body: string;
    /** Location header, if any */
    location: string | undefined;
}

/** Request options */
export interface HttpRequest {
    /** Default GET */
    method?: 'GET' | 'POST';
    /** Extra request headers */
    headers?: Record<string, string>;
    /** Form fields (sent as application/x-www-form-urlencoded) */
    form?: Record<string, string>;
    /** JSON body */
    json?: unknown;
    /** Cookies of the OAuth flow, read and updated */
    cookies?: CookieJar;
}

/** Minimal cookie jar for the OAuth host (name -> value, no domain/path handling needed) */
export class CookieJar {
    private readonly cookies = new Map<string, string>();

    /**
     * @param entries - Cookies to start with (restored pending login)
     */
    public constructor(entries: Record<string, string> = {}) {
        for (const [name, value] of Object.entries(entries)) {
            this.cookies.set(name, value);
        }
    }

    /**
     * Stores the cookies of a response.
     *
     * @param headers - Response headers
     */
    public update(headers: Headers): void {
        for (const line of headers.getSetCookie()) {
            const pair = line.split(';', 1)[0];
            const eq = pair.indexOf('=');
            if (eq > 0) {
                this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        }
    }

    /** Value of the Cookie request header, empty if there are no cookies */
    public header(): string {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    /** Plain object for storing a pending login */
    public toJSON(): Record<string, string> {
        return Object.fromEntries(this.cookies);
    }
}

/** HTTP client options */
export interface HttpClientOptions {
    /** Replaces the origin of every request (integration tests: http://127.0.0.1:port) */
    testOrigin?: string;
    /** Timeout per request */
    timeoutMs?: number;
    /** Aborts all requests when the adapter unloads */
    signal?: AbortSignal;
    /** Receives one line per response, see describeResponse() */
    trace?: (line: string) => void;
}

/** Most field names of one response in a trace line */
const TRACE_MAX_FIELDS = 300;
/** Field names that look like this are part of the API. Anything else could be data (IDs, addresses) */
const TRACE_FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
/** Top-level fields whose value is shown, only if it is a number or boolean: they say how a command ended */
const TRACE_VALUES = ['complete', 'status', 'status_code'];

function collectFields(value: unknown, path: string, names: Set<string>): void {
    if (names.size >= TRACE_MAX_FIELDS) {
        return;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            collectFields(entry, `${path}[]`, names);
        }
    } else if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            const name = TRACE_FIELD.test(key) ? key : '*';
            collectFields(entry, path ? `${path}.${name}` : name, names);
        }
    } else if (path) {
        names.add(path);
    }
}

/**
 * Line for the debug log: shows how Blink answers without showing the data of the account. Query, numbers
 * in the path and all values stay out, except the status values of a command.
 *
 * @param method - HTTP method
 * @param url - Requested URL
 * @param status - HTTP status
 * @param ms - Duration
 * @param body - Response body
 */
export function describeResponse(method: string, url: string, status: number, ms: number, body: string): string {
    const path = new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
    const parsed = parseJson(body);
    const names = new Set<string>();
    collectFields(parsed, '', names);
    const values = TRACE_VALUES.flatMap(key => {
        const value = field(parsed, key);
        return typeof value === 'number' || typeof value === 'boolean' ? [`${key}=${value}`] : [];
    });
    return `${method} ${path} -> ${status} in ${ms} ms, fields: ${[...names].join(' ') || '-'}${
        values.length > 0 ? `, values: ${values.join(' ')}` : ''
    }`;
}

/** Thin fetch wrapper used by the OAuth flow and the REST client */
export class HttpClient {
    private readonly testOrigin: string | undefined;
    private readonly timeoutMs: number;
    private readonly signal: AbortSignal | undefined;
    private readonly trace: ((line: string) => void) | undefined;

    /**
     * @param options - Client options
     */
    public constructor(options: HttpClientOptions = {}) {
        this.testOrigin = options.testOrigin;
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        this.signal = options.signal;
        this.trace = options.trace;
    }

    /**
     * URL as it is really requested (with the test origin, if set).
     *
     * @param url - Absolute https URL of the Blink cloud
     */
    public resolve(url: string): string {
        if (!this.testOrigin) {
            return url;
        }
        const parsed = new URL(url);
        return `${this.testOrigin}${parsed.pathname}${parsed.search}`;
    }

    /**
     * Sends a request without following redirects.
     *
     * @param url - Absolute https URL of the Blink cloud
     * @param request - Method, headers, body and cookie jar
     */
    public async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
        if (this.signal?.aborted) {
            throw new AbortedError();
        }
        // the requests carry the password and tokens: never send them over a connection that is not verified
        if (!this.testOrigin && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
            throw new Error('TLS certificate checks are switched off in this process, nothing is sent to Blink');
        }
        const headers: Record<string, string> = { 'Accept-Language': 'en-US,en;q=0.9', ...request.headers };
        let body: string | undefined;
        if (request.form) {
            body = new URLSearchParams(request.form).toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (request.json !== undefined) {
            body = JSON.stringify(request.json);
            headers['Content-Type'] = 'application/json';
        }
        const cookie = request.cookies?.header();
        if (cookie) {
            headers.Cookie = cookie;
        }

        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
        const started = Date.now();
        let response: Response;
        try {
            response = await fetch(this.resolve(url), {
                method: request.method ?? 'GET',
                headers,
                body,
                redirect: 'manual',
                signal,
            });
        } catch (err) {
            if (this.signal?.aborted) {
                throw new AbortedError();
            }
            throw err;
        }
        request.cookies?.update(response.headers);
        const text = await response.text();
        this.trace?.(describeResponse(request.method ?? 'GET', url, response.status, Date.now() - started, text));
        return {
            status: response.status,
            headers: response.headers,
            body: text,
            location: response.headers.get('location') ?? undefined,
        };
    }
}

/**
 * Parses JSON, returns undefined instead of throwing.
 *
 * @param text - Response body
 */
export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * Reads a property of an unknown JSON value.
 *
 * @param value - Parsed JSON
 * @param key - Property name
 */
export function field(value: unknown, key: string): unknown {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Wait time of a rate-limit answer: Retry-After header, next_time_in_secs in the body, otherwise a fallback.
 *
 * @param response - Answer with status 429
 */
export function retryAfterMs(response: HttpResponse): number {
    for (const raw of [response.headers.get('retry-after'), field(parseJson(response.body), 'next_time_in_secs')]) {
        const seconds = Number(raw);
        if (raw !== null && Number.isFinite(seconds) && seconds > 0) {
            return Math.ceil(seconds) * 1000;
        }
    }
    return RATE_LIMIT_FALLBACK_S * 1000;
}
