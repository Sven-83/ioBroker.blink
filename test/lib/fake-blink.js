// @ts-nocheck
'use strict';

/*
 * Simulated Blink cloud (OAuth + REST) on 127.0.0.1 for unit and integration tests.
 * Only invented data: no real accounts, tokens, serial numbers or images.
 */

const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');

const EMAIL = 'user@example.invalid';
const PASSWORD = 'correct-horse';
const PIN = '481516';
const ACCOUNT_ID = 4242;
const TIER = 'e006';

/** Invented homescreen with one device of each family */
function defaultHomescreen() {
    return {
        networks: [{ id: 1001, name: 'Test Home', armed: true }],
        sync_modules: [
            {
                id: 2001,
                name: 'Test Sync',
                network_id: 1001,
                serial: 'TESTSYNC0001',
                status: 'online',
                local_storage_enabled: true,
                local_storage_status: 'active',
            },
        ],
        cameras: [
            {
                id: 3001,
                name: 'Test Camera',
                network_id: 1001,
                serial: 'TESTCAM0001',
                type: 'catalina',
                enabled: true,
                status: 'done',
                battery: 'ok',
                thumbnail: '/media/3001/thumb-1?ts=1700000000',
                signals: { lfr: 5, wifi: 4, temp: 68, battery: 3 },
            },
        ],
        owls: [
            {
                id: 3002,
                name: 'Test Mini',
                network_id: 1001,
                serial: 'TESTMINI0001',
                type: 'owl',
                enabled: false,
                status: 'online',
                thumbnail: '/media/3002/thumb-1.jpg',
            },
        ],
        doorbells: [
            {
                id: 3003,
                name: 'Test Doorbell',
                network_id: 1001,
                serial: 'TESTBELL0001',
                type: 'lotus',
                enabled: true,
                status: 'done',
                battery: 'low',
                battery_voltage: 148,
                thumbnail: '/media/3003/thumb-1?ts=1700000000',
                signals: { wifi: 2, temp: 50, battery: 1 },
            },
        ],
    };
}

/**
 * Starts the fake cloud.
 *
 * @param {object} [options]
 * @param {'none'|'412'|'tsv'} [options.twoFactor] - 2FA behaviour of the sign-in
 * @param {boolean} [options.rateLimit2fa] - 2FA verify answers 429
 * @param {number} [options.expiresIn] - Lifetime of access tokens in seconds
 * @param {number} [options.homescreenStatus] - HTTP status of the homescreen (other than 200: error answer)
 * @param {unknown} [options.homescreen] - Answer of the homescreen
 * @param {number} [options.armNewPathStatus] - HTTP status of the current arm path (other than 200: error answer)
 * @param {number} [options.armBusyCount] - Number of arm requests answered with "System is busy"
 * @param {number} [options.armDelayMs] - Time until a command is finished and "armed" changes
 * @param {boolean} [options.armIgnored] - Commands are accepted, but "armed" never changes
 * @param {boolean} [options.armCommandFails] - Commands report a failure, "armed" does not change
 * @param {number} [options.snapshotBusyCount] - Number of snapshot requests answered with "System is busy"
 * @param {number} [options.snapshotDelayMs] - Time until a new image is there
 * @param {boolean} [options.snapshotIgnored] - Snapshots are accepted, but no new image comes
 * @param {boolean} [options.snapshotSameContent] - The address of the image changes, its content does not
 * @param {boolean} [options.snapshotCommandFails] - Snapshot commands report a failure, no new image comes
 * @param {number} [options.imageStatus] - HTTP status of image downloads (other than 200: error answer)
 * @param {string} [options.imageBody] - Answer of image downloads instead of an image
 * @param {object} [options.commandAnswer] - Fixed answer of the command status
 * @param {object} [options.liveAnswer] - Answer to the start of a live session
 */
async function startFakeBlink(options = {}) {
    const config = {
        twoFactor: 'none',
        rateLimit2fa: false,
        expiresIn: 14_400,
        homescreenStatus: 200,
        homescreen: defaultHomescreen(),
        armNewPathStatus: 200,
        armBusyCount: 0,
        armDelayMs: 0,
        armIgnored: false,
        armCommandFails: false,
        snapshotBusyCount: 0,
        snapshotDelayMs: 0,
        snapshotIgnored: false,
        snapshotSameContent: false,
        snapshotCommandFails: false,
        imageStatus: 200,
        liveAnswer: {
            command_id: 950,
            server: 'immis://stream-test.immedia-semi.com:443/fake-transaction__IMDS_TEST?client_id=250',
            liveview_token: 'fake-live-token',
            duration: 300,
        },
        ...options,
    };
    const commands = new Map(); // id -> { doneAt, failed }
    let nextCommandId = 900;
    const sessions = new Map(); // sid -> { challenge, csrf, authenticated, awaiting2fa }
    const codes = new Map(); // code -> challenge
    const accessTokens = new Set();
    const refreshTokens = new Set();
    const allIssued = [];
    const stats = {
        authorize: 0,
        signin: 0,
        codesSent: 0,
        verify: 0,
        tokens: 0,
        refresh: 0,
        tierInfo: 0,
        homescreen: 0,
        homescreenRequests: 0,
        armNew: 0,
        armOld: 0,
        commandStatus: 0,
        snapshot: 0,
        image: 0,
        liveStart: 0,
        liveDone: 0,
    };

    const allDevices = () => [
        ...(config.homescreen.cameras ?? []),
        ...(config.homescreen.owls ?? []),
        ...(config.homescreen.doorbells ?? []),
    ];

    /** Accepts a snapshot and changes the image as configured */
    const acceptSnapshot = (res, deviceId) => {
        const device = allDevices().find(item => item.id === deviceId);
        if (!device) {
            return send(res, 404, { message: 'unknown device' });
        }
        if (config.snapshotBusyCount > 0) {
            config.snapshotBusyCount--;
            return send(res, 409, { message: 'System is busy' });
        }
        const id = ++nextCommandId;
        const failed = config.snapshotCommandFails;
        commands.set(id, { doneAt: Date.now() + config.snapshotDelayMs, failed });
        if (!failed && !config.snapshotIgnored) {
            const apply = () => {
                const next = Number(device.thumbnail.match(/thumb-(\d+)/)[1]) + 1;
                device.thumbnail = `/media/${deviceId}/thumb-${next}?ts=${Math.floor(Date.now() / 1000)}`;
            };
            if (config.snapshotDelayMs > 0) {
                setTimeout(apply, config.snapshotDelayMs).unref();
            } else {
                apply();
            }
        }
        return send(res, 200, { id, network_id: device.network_id, state: 'new' });
    };

    /** Accepts a command and changes "armed" as configured */
    const acceptArm = (res, networkId, action) => {
        const network = config.homescreen.networks?.find(item => item.id === networkId);
        if (!network) {
            return send(res, 404, { message: 'unknown network' });
        }
        if (config.armBusyCount > 0) {
            config.armBusyCount--;
            return send(res, 409, { message: 'System is busy' });
        }
        const id = ++nextCommandId;
        const failed = config.armCommandFails;
        commands.set(id, { doneAt: Date.now() + config.armDelayMs, failed });
        if (!failed && !config.armIgnored) {
            const apply = () => {
                network.armed = action === 'arm';
            };
            if (config.armDelayMs > 0) {
                setTimeout(apply, config.armDelayMs).unref();
            } else {
                apply();
            }
        }
        return send(res, 200, { id, network_id: networkId, state: 'new' });
    };
    const requests = [];

    const issueTokens = () => {
        const access = `fake-access-${randomBytes(8).toString('hex')}`;
        const refresh = `fake-refresh-${randomBytes(8).toString('hex')}`;
        accessTokens.add(access);
        refreshTokens.add(refresh);
        allIssued.push(access, refresh);
        return { access_token: access, refresh_token: refresh, expires_in: config.expiresIn, token_type: 'Bearer' };
    };

    const readBody = req =>
        new Promise(resolve => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });

    const sidOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];

    const send = (res, status, body, headers = {}) => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers });
        res.end(text);
    };

    const codeRedirect = (res, session) => {
        const code = `fake-code-${randomBytes(6).toString('hex')}`;
        codes.set(code, session.challenge);
        send(res, 302, '', { Location: `immedia-blink://applinks.blink.com/signin/callback?code=${code}&state=x` });
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        requests.push({ method: req.method, path: url.pathname, body });

        if (req.method === 'GET' && url.pathname === '/oauth/v2/authorize') {
            stats.authorize++;
            const sid = sidOf(req);
            const known = sid && sessions.get(sid);
            if (known?.authenticated) {
                return codeRedirect(res, known);
            }
            if (!url.searchParams.get('code_challenge')) {
                return send(res, 400, { error: 'invalid_request' });
            }
            const newSid = randomBytes(8).toString('hex');
            sessions.set(newSid, { challenge: url.searchParams.get('code_challenge'), csrf: `csrf-${newSid}` });
            return send(res, 302, '', { Location: '/oauth/v2/signin', 'Set-Cookie': `sid=${newSid}; Path=/; HttpOnly` });
        }

        if (req.method === 'GET' && url.pathname === '/oauth/v2/signin') {
            const session = sessions.get(sidOf(req));
            if (!session) {
                return send(res, 400, 'no session');
            }
            return send(
                res,
                200,
                `<html><script id="oauth-args" type="application/json">{"csrf-token":"${session.csrf}"}</script></html>`,
            );
        }

        if (req.method === 'POST' && url.pathname === '/oauth/v2/signin') {
            stats.signin++;
            const session = sessions.get(sidOf(req));
            if (!session || form.get('csrf-token') !== session.csrf) {
                return send(res, 400, { error: 'invalid_csrf' });
            }
            if (form.get('username') !== EMAIL || form.get('password') !== PASSWORD) {
                return send(res, 401, { error: 'invalid_user_credentials' });
            }
            if (config.twoFactor === 'none') {
                session.authenticated = true;
                return send(res, 302, '', { Location: '/oauth/v2/authorize' });
            }
            session.awaiting2fa = true;
            stats.codesSent++;
            if (config.twoFactor === '412') {
                return send(res, 412, { message: '2fa required' });
            }
            return send(res, 202, {
                tsv_state: 'sms',
                tsv_methods: ['sms', 'email'],
                phone: '+490000000099',
                next_time_in_secs: 60,
            });
        }

        if (req.method === 'POST' && url.pathname === '/oauth/v2/2fa/verify') {
            stats.verify++;
            if (config.rateLimit2fa) {
                return send(res, 429, { error_cause: '2fa_rate_limit_exceeded', next_time_in_secs: 120 });
            }
            const session = sessions.get(sidOf(req));
            if (!session?.awaiting2fa || form.get('csrf-token') !== session.csrf) {
                return send(res, 400, { error: 'invalid_session' });
            }
            if (form.get('2fa_code') !== PIN) {
                return send(res, 400, { error: 'invalid_2fa_code' });
            }
            session.authenticated = true;
            return send(res, 201, { status: 'auth-completed' });
        }

        if (req.method === 'POST' && url.pathname === '/oauth/token') {
            if (form.get('grant_type') === 'authorization_code') {
                stats.tokens++;
                const challenge = codes.get(form.get('code'));
                codes.delete(form.get('code'));
                const expected = challenge && createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
                if (!challenge || expected !== challenge || !form.get('hardware_id')) {
                    return send(res, 400, { error: 'invalid_grant' });
                }
                return send(res, 200, issueTokens());
            }
            if (form.get('grant_type') === 'refresh_token') {
                stats.refresh++;
                const token = form.get('refresh_token');
                if (!refreshTokens.delete(token)) {
                    return send(res, 401, { error: 'invalid_grant' });
                }
                return send(res, 200, issueTokens());
            }
            return send(res, 400, { error: 'unsupported_grant_type' });
        }

        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (url.pathname === '/api/v1/users/tier_info') {
            stats.tierInfo++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            return send(res, 200, { tier: TIER, account_id: ACCOUNT_ID });
        }

        if (req.method === 'GET' && url.pathname === `/api/v3/accounts/${ACCOUNT_ID}/homescreen`) {
            stats.homescreenRequests++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            if (config.homescreenStatus === 429) {
                return send(res, 429, { message: 'Too many requests' }, { 'Retry-After': '120' });
            }
            if (config.homescreenStatus !== 200) {
                return send(res, config.homescreenStatus, { message: 'error' });
            }
            stats.homescreen++;
            return send(res, 200, config.homescreen);
        }

        const armNew = url.pathname.match(
            new RegExp(`^/api/v1/accounts/${ACCOUNT_ID}/networks/(\\d+)/state/(arm|disarm)$`),
        );
        const armOld = url.pathname.match(/^\/network\/(\d+)\/(arm|disarm)$/);
        if (req.method === 'POST' && (armNew || armOld)) {
            stats[armNew ? 'armNew' : 'armOld']++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            if (armNew && config.armNewPathStatus !== 200) {
                return send(res, config.armNewPathStatus, { message: 'error' });
            }
            const match = armNew ?? armOld;
            return acceptArm(res, Number(match[1]), match[2]);
        }

        const snapshotPath = url.pathname.match(
            new RegExp(
                `^(?:/network/\\d+/camera/|/api/v1/accounts/${ACCOUNT_ID}/networks/\\d+/owls/|` +
                    `/api/v1/accounts/${ACCOUNT_ID}/networks/\\d+/doorbells/)(\\d+)/thumbnail$`,
            ),
        );
        if (req.method === 'POST' && snapshotPath) {
            stats.snapshot++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            return acceptSnapshot(res, Number(snapshotPath[1]));
        }

        const imagePath = url.pathname.match(/^\/media\/(\d+)\/thumb-(\d+)\.jpg$/);
        if (req.method === 'GET' && imagePath) {
            stats.image++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            if (config.imageStatus !== 200) {
                return send(res, config.imageStatus, { message: 'error' });
            }
            if (config.imageBody) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end(config.imageBody);
            }
            // invented bytes with the start of a JPEG, no real image
            const version = config.snapshotSameContent ? '1' : imagePath[2];
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            return res.end(
                Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fake-${imagePath[1]}-${version}`)]),
            );
        }

        if (req.method === 'POST' && /\/liveview$/.test(url.pathname)) {
            stats.liveStart++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            return send(res, 200, config.liveAnswer);
        }

        if (req.method === 'POST' && /^\/network\/\d+\/command\/\d+\/done\/$/.test(url.pathname)) {
            stats.liveDone++;
            return send(res, 200, { message: 'done' });
        }

        const commandPath = url.pathname.match(/^\/network\/\d+\/command\/(\d+)$/);
        if (req.method === 'GET' && commandPath) {
            stats.commandStatus++;
            if (!accessTokens.has(bearer)) {
                return send(res, 401, { message: 'Unauthorized Access', code: 101 });
            }
            if (config.commandAnswer) {
                return send(res, 200, config.commandAnswer);
            }
            const command = commands.get(Number(commandPath[1]));
            if (!command) {
                return send(res, 404, { message: 'unknown command' });
            }
            if (command.failed) {
                return send(res, 200, { complete: false, status: 2102, status_msg: 'failed' });
            }
            return send(res, 200, { complete: Date.now() >= command.doneAt, status: 0, status_msg: 'ok' });
        }

        send(res, 404, { message: 'not found' });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        origin: `http://127.0.0.1:${port}`,
        email: EMAIL,
        password: PASSWORD,
        pin: PIN,
        accountId: ACCOUNT_ID,
        stats,
        requests,
        config,
        /** Invalidates all tokens, as if Blink had ended the session */
        revokeAll() {
            accessTokens.clear();
            refreshTokens.clear();
        },
        /** Invalidates the access tokens only: the refresh token still works */
        revokeAccessTokens() {
            accessTokens.clear();
        },
        /** All tokens issued so far (to check that none of them leaks) */
        issuedTokens() {
            return [...allIssued];
        },
        close() {
            return new Promise(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
        },
    };
}

module.exports = { startFakeBlink };
