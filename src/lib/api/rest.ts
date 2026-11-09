/*
 * REST client of the Blink cloud. Uses the region and account of the session.
 */

import { UA_APP } from './constants';
import { ApiError, BusyError, RateLimitedError, SessionExpiredError } from './errors';
import { parseHomescreen, toId, type Homescreen } from './homescreen';
import { field, parseJson, retryAfterMs, type HttpClient, type HttpResponse } from './http';
import type { Session } from './types';

/** State of a command at Blink */
export type CommandStatus = 'running' | 'done' | 'failed';

/** Answers of a path this API version does not know: only these try the other path */
const UNKNOWN_PATH = [404, 405, 410];

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
    if (response.status === 401) {
        throw new SessionExpiredError('access token rejected');
    }
    if (response.status === 429) {
        throw new RateLimitedError(retryAfterMs(response));
    }
    if (response.status === 409) {
        throw new BusyError();
    }
    if (response.status < 200 || response.status >= 300) {
        throw new ApiError(what, response.status);
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
        const paths = [
            `/api/v1/accounts/${session.accountId}/networks/${networkId}/state/${action}`,
            `/network/${networkId}/${action}`,
        ];
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
        check(response!, `Sending ${action} to Blink`);
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
        if (field(body, 'complete') === true) {
            return 'done';
        }
        const status = field(body, 'status');
        return typeof status === 'number' && status !== 0 ? 'failed' : 'running';
    }
}
