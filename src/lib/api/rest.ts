/*
 * REST client of the Blink cloud. Uses the region and account of the session.
 */

import { RATE_LIMIT_FALLBACK_S, UA_APP } from './constants';
import { ApiError, BusyError, RateLimitedError, SessionExpiredError } from './errors';
import { parseHomescreen, toId, type DeviceKind, type Homescreen } from './homescreen';
import { field, parseJson, retryAfterMs, type HttpClient, type HttpResponse } from './http';
import type { Session } from './types';

/** State of a command at Blink */
export type CommandStatus = 'running' | 'done' | 'failed';

/** Answers of a path this API version does not know: only these try the other path */
const UNKNOWN_PATH = [404, 405, 410];

/** Largest image accepted from Blink */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The bearer token only goes to hosts of the Blink cloud */
const BLINK_HOST = /(^|\.)immedia-semi\.com$/;

/**
 * Address of an image from the "thumbnail" field of the homescreen.
 *
 * @param thumbnail - Value of the field, usually a path
 * @param restOrigin - REST origin of the account
 * @returns The URL, undefined if it does not point to the Blink cloud
 */
export function imageUrl(thumbnail: string, restOrigin: string): string | undefined {
    let url: URL;
    try {
        url = new URL(thumbnail, restOrigin);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' || !(url.origin === restOrigin || BLINK_HOST.test(url.hostname))) {
        return undefined;
    }
    if (!/\.jpe?g$/i.test(url.pathname)) {
        url.pathname += '.jpg';
    }
    return url.toString();
}

/**
 * Paths that ask a device for a new image: the usual one of its family first.
 *
 * @param accountId - Account ID
 * @param networkId - Network ID
 * @param kind - Device family
 * @param deviceId - Device ID
 */
function snapshotPaths(accountId: number, networkId: number, kind: DeviceKind, deviceId: number): string[] {
    const network = `/network/${networkId}`;
    const account = `/api/v1/accounts/${accountId}/networks/${networkId}`;
    const camera = `${network}/camera/${deviceId}/thumbnail`;
    if (kind === 'camera') {
        return [camera, `${network}/cameras/${deviceId}/thumbnail`, `${account}/cameras/${deviceId}/thumbnail`];
    }
    const family = kind === 'mini' ? 'owl' : 'doorbell';
    return [
        `${account}/${family}s/${deviceId}/thumbnail`,
        `${account}/${family}/${deviceId}/thumbnail`,
        `${network}/${family}s/${deviceId}/thumbnail`,
        `${network}/${family}/${deviceId}/thumbnail`,
        camera,
    ];
}

function headers(session: Session): Record<string, string> {
    return {
        Authorization: `Bearer ${session.accessToken}`,
        'User-Agent': UA_APP,
        Accept: 'application/json',
    };
}

/**
 * Throws the matching error for every answer other than 2xx.
 *
 * @param response - Answer of Blink
 * @param what - Action for the error message
 */
function check(response: HttpResponse, what: string): void {
    checkStatus(response.status, response, what);
}

function checkStatus(status: number, response: HttpResponse | undefined, what: string): void {
    if (status === 401) {
        throw new SessionExpiredError('access token rejected');
    }
    if (status === 429) {
        throw new RateLimitedError(response ? retryAfterMs(response) : RATE_LIMIT_FALLBACK_S * 1000);
    }
    if (status === 409) {
        throw new BusyError();
    }
    if (status < 200 || status >= 300) {
        throw new ApiError(what, status);
    }
}

/** Authenticated requests of one account */
export class RestClient {
    /**
     * @param http - HTTP client
     */
    public constructor(private readonly http: HttpClient) {}

    /**
     * Reads networks, Sync Modules and devices.
     *
     * @param session - Logged-in session
     */
    public async homescreen(session: Session): Promise<Homescreen> {
        const what = 'Reading the Blink homescreen';
        const response = await this.http.request(
            `${session.restOrigin}/api/v3/accounts/${session.accountId}/homescreen`,
            { headers: headers(session) },
        );
        check(response, what);
        const homescreen = parseHomescreen(parseJson(response.body));
        if (!homescreen) {
            throw new ApiError(`${what} (unexpected answer)`, response.status);
        }
        return homescreen;
    }

    /**
     * Arms or disarms a network: current path of the app first, the older one only if that path is unknown.
     * Only an unknown path is retried, as any other answer may mean the command has arrived.
     *
     * @param session - Logged-in session
     * @param networkId - Network ID
     * @param armed - Requested state
     * @returns Command ID, if Blink gave one
     */
    public async setArmed(session: Session, networkId: number, armed: boolean): Promise<number | undefined> {
        const action = armed ? 'arm' : 'disarm';
        return this.command(
            session,
            [
                `/api/v1/accounts/${session.accountId}/networks/${networkId}/state/${action}`,
                `/network/${networkId}/${action}`,
            ],
            `Sending ${action} to Blink`,
        );
    }

    /**
     * Asks a device for a new image. This wakes a battery camera, so it only runs on request.
     *
     * @param session - Logged-in session
     * @param networkId - Network ID
     * @param kind - Device family
     * @param deviceId - Device ID
     * @returns Command ID, if Blink gave one
     */
    public snapshot(
        session: Session,
        networkId: number,
        kind: DeviceKind,
        deviceId: number,
    ): Promise<number | undefined> {
        return this.command(
            session,
            snapshotPaths(session.accountId, networkId, kind, deviceId),
            'Asking Blink for a snapshot',
        );
    }

    /**
     * Downloads the image a "thumbnail" field points to. This does not wake the camera: Blink has the image.
     *
     * @param session - Logged-in session
     * @param thumbnail - Value of the field
     * @returns The JPEG file
     */
    public async downloadImage(session: Session, thumbnail: string): Promise<Buffer> {
        const what = 'Downloading a Blink image';
        const url = imageUrl(thumbnail, session.restOrigin);
        if (!url) {
            throw new ApiError(`${what} (address outside of Blink)`, 0);
        }
        const response = await this.http.download(
            url,
            { ...headers(session), Accept: 'image/jpeg,image/*' },
            IMAGE_MAX_BYTES,
        );
        checkStatus(response.status, undefined, what);
        if (response.body[0] !== 0xff || response.body[1] !== 0xd8 || response.body[2] !== 0xff) {
            throw new ApiError(`${what} (not a JPEG)`, response.status);
        }
        return response.body;
    }

    /**
     * Sends a command. Only an unknown path tries the next one, as any other answer may mean it has arrived.
     *
     * @param session - Logged-in session
     * @param paths - Paths to try, in this order
     * @param what - Action for the error message
     * @returns Command ID, if Blink gave one
     */
    private async command(session: Session, paths: string[], what: string): Promise<number | undefined> {
        let response: HttpResponse | undefined;
        for (const path of paths) {
            response = await this.http.request(`${session.restOrigin}${path}`, {
                method: 'POST',
                headers: { ...headers(session), 'Content-Type': 'application/json' },
            });
            if (!UNKNOWN_PATH.includes(response.status)) {
                break;
            }
        }
        check(response!, what);
        const body = parseJson(response!.body);
        return toId(field(body, 'id') ?? field(body, 'command_id'));
    }

    /**
     * State of a command.
     *
     * @param session - Logged-in session
     * @param networkId - Network ID
     * @param commandId - Command ID
     */
    public async commandStatus(session: Session, networkId: number, commandId: number): Promise<CommandStatus> {
        const response = await this.http.request(`${session.restOrigin}/network/${networkId}/command/${commandId}`, {
            headers: headers(session),
        });
        check(response, 'Reading the Blink command status');
        const body = parseJson(response.body);
        const status = field(body, 'status');
        // seen live on success: complete=true status=0. Any other status counts as a failure, finished or not
        if (typeof status === 'number' && status !== 0) {
            return 'failed';
        }
        return field(body, 'complete') === true ? 'done' : 'running';
    }
}
