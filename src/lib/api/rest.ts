/*
 * REST client of the Blink cloud. Uses the region and account of the session.
 */

import { UA_APP } from './constants';
import { ApiError, RateLimitedError, SessionExpiredError } from './errors';
import { parseHomescreen, type Homescreen } from './homescreen';
import { parseJson, retryAfterMs, type HttpClient } from './http';
import type { Session } from './types';

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
            {
                headers: {
                    Authorization: `Bearer ${session.accessToken}`,
                    'User-Agent': UA_APP,
                    Accept: 'application/json',
                },
            },
        );
        if (response.status === 401) {
            throw new SessionExpiredError('access token rejected');
        }
        if (response.status === 429) {
            throw new RateLimitedError(retryAfterMs(response));
        }
        if (response.status !== 200) {
            throw new ApiError(what, response.status);
        }
        const homescreen = parseHomescreen(parseJson(response.body));
        if (!homescreen) {
            throw new ApiError(`${what} (unexpected answer)`, response.status);
        }
        return homescreen;
    }
}
