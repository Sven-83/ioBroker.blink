'use strict';

const utils   = require('@iobroker/adapter-core');
const axios   = require('axios');
const crypto  = require('crypto');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// ─── Blink OAuth2 Constants (from blinkpy 0.25) ──────────────────────────────
const OAUTH_BASE_URL      = 'https://api.oauth.blink.com';
const OAUTH_AUTHORIZE_URL = `${OAUTH_BASE_URL}/oauth/v2/authorize`;
const OAUTH_SIGNIN_URL    = `${OAUTH_BASE_URL}/oauth/v2/signin`;
const OAUTH_2FA_URL       = `${OAUTH_BASE_URL}/oauth/v2/2fa/verify`;
const OAUTH_TOKEN_URL     = `${OAUTH_BASE_URL}/oauth/token`;
const OAUTH_V2_CLIENT_ID  = 'ios';
const OAUTH_REDIRECT_URI  = 'immedia-blink://applinks.blink.com/signin/callback';
const TIER_ENDPOINT       = 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';

// Note: Blink API rejects generic User-Agents. Update version annually if needed.
const BLINK_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const BLINK_TOKEN_UA   = 'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';

const DEFAULT_BASE_URL = 'https://rest-prod.immedia-semi.com';
const BLINK_BASE_URLS  = {
    prod: 'https://rest-prod.immedia-semi.com',
    e001: 'https://rest-e001.immedia-semi.com',
    e002: 'https://rest-e002.immedia-semi.com',
    e006: 'https://rest-e006.immedia-semi.com',
    u011: 'https://rest-u011.immedia-semi.com',
    u021: 'https://rest-u021.immedia-semi.com',
};

const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS  = 30 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generatePKCE() {
    const verifier  = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function generateHardwareId() {
    return crypto.randomUUID().toUpperCase();
}

function createOAuthSession() {
    const jar = new CookieJar();
    return wrapper(axios.create({ timeout: 15000, jar, withCredentials: true }));
}

// Sanitize object IDs to [A-Za-z0-9-_] only
function safeId(str) {
    return String(str).replace(/[^A-Za-z0-9\-_]/g, '_');
}

// ─── Adapter ──────────────────────────────────────────────────────────────────
class BlinkAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'blink' });
        this.authData          = null;
        this.pollingTimer      = null;
        this.weeklyTimer       = null;
        this.snapshotRunning   = false;
        this.fetchRunning      = false;
        this.thumbnailUrlCache = {};
        this.lastVideoCache    = {};
        this.backoffMs         = BACKOFF_BASE_MS;
        this.apiSession        = axios.create({ timeout: 15000 });
        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    async onReady() {
        // K3: subscribeStates must be in onReady, not constructor
        // H3: only subscribe to relevant states
        this.subscribeStates('networks.*');

        await this.setState('info.connection', false, true);

        if (!this.config.email || !this.config.password) {
            this.log.error('Email and password must be configured in adapter settings.');
            this.terminate?.('No credentials configured', 11);
            return;
        }

        // K1: Tokens are stored in native (encryptedNative) not in states
        // Migrate old token states if they exist
        await this._migrateTokensFromStates();

        const accessToken  = this.config.accessToken;
        const refreshToken = this.config.refreshToken;
        const hardwareId   = this.config.hardwareId || generateHardwareId();
        const accountId    = this.config.accountId;
        const host         = this.config.host || DEFAULT_BASE_URL;

        if (accessToken && accountId) {
            this.authData = { accessToken, refreshToken, hardwareId, accountId, host };
            this.log.info('Restored saved Blink session token.');
            const ok = await this.verifyToken();
            if (!ok) {
                const refreshed = refreshToken ? await this.refreshAccessToken() : false;
                if (!refreshed) {
                    this.authData = null;
                    await this.loginOAuth();
                }
            } else {
                await this.setState('info.connection', true, true);
                this.startPolling();
            }
        } else {
            await this.loginOAuth();
        }
    }

    onUnload(callback) {
        // K3: use this.clearTimeout/clearInterval (managed by js-controller)
        try {
            this.clearTimeout(this.pollingTimer);
            this.clearTimeout(this.weeklyTimer);
        } catch (err) {
            this.log.debug(`Unload cleanup error: ${err.message}`);
        }
        // H8: set info.connection to false on unload
        this.setState('info.connection', false, true);
        callback();
    }

    // ─── Token Migration (K1) ──────────────────────────────────────────────────

    async _migrateTokensFromStates() {
        try {
            const oldToken = await this.getStateAsync('auth.accessToken');
            if (oldToken && oldToken.val) {
                this.log.info('Migrating tokens from states to native config...');
                const oldRefresh   = await this.getStateAsync('auth.refreshToken');
                const oldHwId      = await this.getStateAsync('auth.hardwareId');
                const oldAccountId = await this.getStateAsync('auth.accountId');
                const oldHost      = await this.getStateAsync('auth.host');

                await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                    native: {
                        accessToken:  oldToken.val,
                        refreshToken: oldRefresh  ? oldRefresh.val  : '',
                        hardwareId:   oldHwId     ? oldHwId.val     : '',
                        accountId:    oldAccountId ? oldAccountId.val : '',
                        host:         oldHost     ? oldHost.val     : DEFAULT_BASE_URL,
                    }
                });

                // Delete old states
                for (const id of ['auth.accessToken','auth.refreshToken','auth.hardwareId','auth.accountId','auth.host','auth']) {
                    try { await this.delObjectAsync(id); } catch (_) {}
                }
                this.log.info('Token migration complete.');
            }
        } catch (err) {
            this.log.debug(`Token migration check: ${err.message}`);
        }
    }

    // ─── Save tokens to native config (K1) ─────────────────────────────────────

    async saveAuthData() {
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: {
                    accessToken:  this.authData.accessToken,
                    refreshToken: this.authData.refreshToken || '',
                    hardwareId:   this.authData.hardwareId,
                    accountId:    String(this.authData.accountId || ''),
                    host:         this.authData.host,
                }
            });
        } catch (err) {
            this.log.error(`Failed to save auth data: ${err.message}`);
        }
    }

    // ─── OAuth2 Login Flow ──────────────────────────────────────────────────────

    async loginOAuth() {
        this.log.info('Starting Blink OAuth2 PKCE login...');
        const oauthSession = createOAuthSession();
        const hardwareId   = (this.authData && this.authData.hardwareId) || generateHardwareId();
        const { verifier, challenge } = generatePKCE();

        try {
            await this.oauthAuthorizeRequest(oauthSession, hardwareId, challenge);
            const csrfToken = await this.oauthGetCsrfToken(oauthSession);
            if (!csrfToken) throw new Error('CSRF token not found on signin page');
            this.log.debug('CSRF token obtained.');

            const loginResult = await this.oauthSignin(oauthSession, csrfToken);
            this.log.debug(`Login result: ${loginResult}`);

            if (loginResult === '2FA_REQUIRED') {
                this._pendingSession  = oauthSession;
                this._pendingCsrf     = csrfToken;
                this._pendingVerifier = verifier;
                this._pendingHwId     = hardwareId;
                await this.setState('info.connection', false, true);
                this.log.warn('Blink 2FA required. Send PIN via: sendTo("blink.0", "verifyPin", {pin: "123456"})');
                return;
            }
            if (loginResult !== 'SUCCESS') throw new Error(`Login failed (result: ${loginResult})`);

            const code = await this.oauthGetCode(oauthSession);
            if (!code) throw new Error('Authorization code not received');
            this.log.debug('Authorization code obtained.');

            const tokenData = await this.oauthExchangeCode(code, verifier, hardwareId);
            if (!tokenData) throw new Error('Token exchange failed');

            await this.processTokenData(tokenData, hardwareId);
            this.log.info('Blink OAuth2 login successful.');

        } catch (err) {
            this.log.error(`OAuth login error: ${err.message}`);
            await this.setState('info.connection', false, true);
        }
    }

    async oauthAuthorizeRequest(session, hardwareId, codeChallenge) {
        const params = new URLSearchParams({
            app_brand: 'blink', app_version: '50.1',
            client_id: OAUTH_V2_CLIENT_ID,
            code_challenge: codeChallenge, code_challenge_method: 'S256',
            device_brand: 'Apple', device_model: 'iPhone16,1',
            device_os_version: '26.1',
            hardware_id: hardwareId,
            redirect_uri: OAUTH_REDIRECT_URI,
            response_type: 'code', scope: 'client',
        });
        try {
            await session.get(`${OAUTH_AUTHORIZE_URL}?${params}`, {
                headers: {
                    'User-Agent':      BLINK_USER_AGENT,
                    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                maxRedirects: 10,
            });
        } catch (err) {
            // H2: log redirects instead of silently ignoring
            this.log.debug(`Authorize redirect: ${err.message}`);
        }
    }

    async oauthGetCsrfToken(session) {
        const resp = await session.get(OAUTH_SIGNIN_URL, {
            headers: { 'User-Agent': BLINK_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        });
        // M5: use multiple extraction strategies, log fallback usage
        const m = resp.data.match(/"csrf-token":"([^"]+)"/);
        if (m) return m[1];
        this.log.debug('Primary CSRF extraction failed, trying fallback...');
        const m2 = resp.data.match(/name=["']csrf-token["'][^>]*value=["']([^"']+)["']/);
        return m2 ? m2[1] : null;
    }

    async oauthSignin(session, csrfToken) {
        const data = new URLSearchParams({
            username: this.config.email, password: this.config.password, 'csrf-token': csrfToken,
        });
        try {
            const resp = await session.post(OAUTH_SIGNIN_URL, data.toString(), {
                headers: {
                    'User-Agent':   BLINK_USER_AGENT,
                    'Accept':       '*/*',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin':       'https://api.oauth.blink.com',
                    'Referer':      OAUTH_SIGNIN_URL,
                },
                maxRedirects: 0,
                // M6: only whitelist 2xx/3xx/412, log others
                validateStatus: s => s < 500,
            });
            this.log.debug(`Signin status: ${resp.status}`);
            if (resp.status === 412) return '2FA_REQUIRED';
            if ([200,301,302,303,307,308].includes(resp.status)) return 'SUCCESS';
            this.log.error(`Signin unexpected status ${resp.status}: ${JSON.stringify(resp.data).substring(0, 200)}`);
            return null;
        } catch (err) {
            if (err.response && err.response.status === 412) return '2FA_REQUIRED';
            if (err.response && [301,302,303].includes(err.response.status)) return 'SUCCESS';
            throw err;
        }
    }

    async oauthVerify2fa(session, csrfToken, pin) {
        const data = new URLSearchParams({ '2fa_code': pin, 'csrf-token': csrfToken, remember_me: 'false' });
        const resp = await session.post(OAUTH_2FA_URL, data.toString(), {
            headers: {
                'User-Agent':   BLINK_USER_AGENT,
                'Accept':       '*/*',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin':       'https://api.oauth.blink.com',
                'Referer':      OAUTH_SIGNIN_URL,
            },
            validateStatus: s => s < 500,
        });
        if (resp.status === 201) {
            try { return resp.data.status === 'auth-completed'; } catch (_) {}
        }
        return false;
    }

    async oauthGetCode(session) {
        try {
            const resp = await session.get(OAUTH_AUTHORIZE_URL, {
                headers: { 'User-Agent': BLINK_USER_AGENT, 'Referer': OAUTH_SIGNIN_URL },
                maxRedirects: 0,
                validateStatus: s => s < 500,
            });
            const loc = resp.headers['location'];
            this.log.debug(`GetCode status: ${resp.status}, location: ${loc || 'none'}`);
            if (loc) { const m = loc.match(/[?&]code=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
            return null;
        } catch (err) {
            if (err.response && err.response.headers && err.response.headers['location']) {
                const m = err.response.headers['location'].match(/[?&]code=([^&]+)/);
                if (m) return decodeURIComponent(m[1]);
            }
            throw err;
        }
    }

    async oauthExchangeCode(code, verifier, hardwareId) {
        const data = new URLSearchParams({
            grant_type: 'authorization_code', client_id: OAUTH_V2_CLIENT_ID,
            code, code_verifier: verifier, redirect_uri: OAUTH_REDIRECT_URI, hardware_id: hardwareId,
        });
        const resp = await this.apiSession.post(OAUTH_TOKEN_URL, data.toString(), {
            headers: { 'User-Agent': BLINK_TOKEN_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': '*/*' },
        });
        return resp.data;
    }

    async refreshAccessToken() {
        if (!this.authData || !this.authData.refreshToken) return false;
        this.log.info('Refreshing Blink access token...');
        try {
            const data = new URLSearchParams({
                grant_type: 'refresh_token', client_id: OAUTH_V2_CLIENT_ID,
                refresh_token: this.authData.refreshToken, hardware_id: this.authData.hardwareId,
            });
            const resp = await this.apiSession.post(OAUTH_TOKEN_URL, data.toString(), {
                headers: { 'User-Agent': BLINK_TOKEN_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            await this.processTokenData(resp.data, this.authData.hardwareId);
            this.log.info('Token refreshed successfully.');
            this.backoffMs = BACKOFF_BASE_MS; // reset backoff on success
            return true;
        } catch (err) {
            this.log.warn(`Token refresh failed: ${err.message}`);
            return false;
        }
    }

    async processTokenData(tokenData, hardwareId) {
        const accessToken  = tokenData.access_token;
        const refreshToken = tokenData.refresh_token || null;
        let accountId = null, host = DEFAULT_BASE_URL;
        try {
            const r = await this.apiSession.get(TIER_ENDPOINT, {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            });
            const tier = r.data.tier;
            accountId  = r.data.account_id;
            if (tier && BLINK_BASE_URLS[tier]) host = BLINK_BASE_URLS[tier];
            this.log.info(`Blink region: ${tier}, account ID: ${accountId}`);
        } catch (err) {
            this.log.warn(`Could not fetch tier info: ${err.message}`);
        }
        this.authData = { accessToken, refreshToken, hardwareId, accountId, host };
        await this.saveAuthData();
        await this.setState('info.connection', true, true);
        this.startPolling();
    }

    async verifyToken() {
        try {
            if (!this.authData || !this.authData.accountId) return false;
            await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            return true;
        } catch (_) { return false; }
    }

    // ─── Polling (H4, H6, H7) ──────────────────────────────────────────────────

    startPolling() {
        // H7: initial jitter to avoid synchronized API calls across many users
        const jitter = Math.floor(Math.random() * 30000);
        this.log.info(`Polling started (initial jitter: ${Math.round(jitter/1000)}s).`);
        this.pollingTimer = this.setTimeout(() => this.pollLoop(), jitter);
        this.scheduleWeeklySnapshot();
    }

    // H6, H7: chained setTimeout instead of setInterval, prevents re-entrancy
    async pollLoop() {
        try {
            await this.fetchAllData();
        } catch (err) {
            this.log.warn(`Poll loop error: ${err.message}`);
        } finally {
            const interval = (this.config.pollingInterval || 30) * 1000;
            // K3: use this.setTimeout (managed by js-controller)
            this.pollingTimer = this.setTimeout(() => this.pollLoop(), interval);
        }
    }

    scheduleWeeklySnapshot() {
        const ms = this.msUntilNextSaturday12();
        const days = Math.round(ms / 1000 / 60 / 60 / 24 * 10) / 10;
        this.log.info(`Next weekly snapshot in ${days} day(s) (Saturday 12:00).`);
        // K3: use this.setTimeout
        this.weeklyTimer = this.setTimeout(async () => {
            this.log.info('Weekly Saturday snapshot triggered.');
            await this.fetchAllSnapshots('weekly');
            this.scheduleWeeklySnapshot();
        }, ms);
    }

    msUntilNextSaturday12() {
        const now = new Date(), t = new Date(now);
        let d = (6 - now.getDay() + 7) % 7;
        if (d === 0 && now.getHours() >= 12) d = 7;
        t.setDate(now.getDate() + d); t.setHours(12, 0, 0, 0);
        return t.getTime() - now.getTime();
    }

    async fetchAllData() {
        if (!this.authData || !this.authData.accountId) return;
        // H6: mutex to prevent parallel fetches
        if (this.fetchRunning) { this.log.debug('fetchAllData already running, skipping.'); return; }
        this.fetchRunning = true;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            await this.setState('info.connection', true, true);
            this.backoffMs = BACKOFF_BASE_MS; // reset backoff on success
            await this.processHomescreenData(data);
        } catch (err) {
            this.log.warn(`Data fetch error: ${err.message}`);
            // M7: handle 429 rate limiting
            if (err.response && err.response.status === 429) {
                const retryAfter = parseInt(err.response.headers['retry-after'] || '60') * 1000;
                this.log.warn(`Rate limited. Waiting ${retryAfter/1000}s before retry.`);
                await this.sleep(retryAfter);
            }
            // H4: exponential backoff on auth errors
            if (err.response && [401, 403].includes(err.response.status)) {
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    this.log.warn(`Auth failed. Backing off ${Math.round(this.backoffMs/1000)}s before re-login.`);
                    await this.setState('info.connection', false, true);
                    await this.sleep(this.backoffMs);
                    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
                    this.authData = null;
                    await this.loginOAuth();
                }
            }
        } finally {
            this.fetchRunning = false;
        }
    }

    async fetchAllSnapshots(reason = 'manual') {
        if (!this.authData || this.snapshotRunning) return;
        this.snapshotRunning = true;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            const cams = [...(data.cameras||[]), ...(data.owls||[]), ...(data.doorbells||[])];
            this.log.info(`Triggering snapshots for ${cams.length} cameras (reason: ${reason})...`);
            for (const c of cams) {
                await this.triggerSnapshot(c.network_id, c.id, c.name);
                await this.sleep(3000); // stagger to avoid rate limits
            }
            await this.fetchAllData();
        } catch (err) {
            this.log.warn(`Snapshot cycle error (${reason}): ${err.message}`);
        } finally {
            this.snapshotRunning = false;
        }
    }

    // ─── Data Processing ───────────────────────────────────────────────────────

    async processHomescreenData(data) {
        // H13: parallel state writes for DB operations (not API calls)
        const networkOps = (data.networks||[]).map(n => this.createNetworkObjects(n).then(() => this.updateNetworkStates(n)));
        await Promise.all(networkOps);

        const camOps = [
            ...(data.cameras||[]).map(c => this.createCameraObjects(c.network_id, c).then(() => this.updateCameraStates(c.network_id, c))),
            ...(data.owls||[]).map(o => this.createCameraObjects(o.network_id, o, true).then(() => this.updateCameraStates(o.network_id, o))),
            ...(data.doorbells||[]).map(d => this.createCameraObjects(d.network_id, d, false, true).then(() => this.updateCameraStates(d.network_id, d))),
        ];
        await Promise.all(camOps);

        for (const v of (data.videos||[])) await this.processVideoEvent(v);
        await this.checkMotionAndSnapshot(data);
    }

    async checkMotionAndSnapshot(data) {
        if (!data.videos || !data.videos.length) return;
        const armed = new Set((data.networks||[]).filter(n => n.armed).map(n => String(n.id)));
        const need  = [];
        for (const v of data.videos) {
            const nid = String(v.network_id), cid = String(v.device_id || v.camera_id);
            if (!nid || !cid || !armed.has(nid)) continue;
            const key = `${nid}.${cid}`;
            if (v.created_at && v.created_at !== this.lastVideoCache[key]) {
                this.lastVideoCache[key] = v.created_at;
                if (!need.find(c => c.nid === nid && c.cid === cid)) need.push({ nid, cid, name: v.camera_name });
            }
        }
        if (!need.length || this.snapshotRunning) return;
        this.snapshotRunning = true;
        try {
            for (const c of need) {
                this.log.info(`Motion detected on armed camera "${c.name}" - triggering snapshot.`);
                await this.triggerSnapshot(c.nid, c.cid, c.name);
                if (need.length > 1) await this.sleep(3000);
            }
            await this.sleep(4000);
            await this.fetchAllData();
        } finally { this.snapshotRunning = false; }
    }

    // ─── ioBroker Objects (H9: extendObjectAsync for schema updates) ────────────

    async createNetworkObjects(net) {
        const id = `networks.${net.id}`;
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name: net.name || `Network ${net.id}` }, native: {} });
        // M3: only armed as switch (read+write), no redundant arm/disarm buttons
        const states = [
            { id: 'name',      name: 'Network Name', type: 'string',  role: 'text',        read: true,  write: false },
            { id: 'armed',     name: 'Armed',         type: 'boolean', role: 'switch.lock', read: true,  write: true  },
            { id: 'enabled',   name: 'Enabled',       type: 'boolean', role: 'indicator',   read: true,  write: false },
            { id: 'networkId', name: 'Network ID',    type: 'number',  role: 'value',       read: true,  write: false },
        ];
        await Promise.all(states.map(s =>
            this.extendObjectAsync(`${id}.${s.id}`, {
                type: 'state',
                common: { name: s.name, type: s.type, role: s.role, read: s.read, write: s.write },
                native: {},
            })
        ));
    }

    async createCameraObjects(networkId, cam, isMini = false, isDoorbell = false) {
        const base = `networks.${networkId}.cameras`;
        const id   = `${base}.${cam.id}`;
        const type = isDoorbell ? 'Doorbell' : isMini ? 'Mini' : 'Camera';
        await this.setObjectNotExistsAsync(base, { type: 'channel', common: { name: 'Cameras' }, native: {} });
        await this.extendObjectAsync(id, { type: 'channel', common: { name: `${type}: ${cam.name || cam.id}` }, native: {} });

        // M1: only temperatureC (°C), remove °F state
        // M2: separate batteryOk + batteryPercent
        // M4: thumbnail URL only (no Base64 state - use file storage)
        const states = [
            { id: 'name',          name: 'Camera Name',          type: 'string',  role: 'text',                    read: true,  write: false },
            { id: 'enabled',       name: 'Enabled',              type: 'boolean', role: 'indicator',               read: true,  write: false },
            { id: 'batteryOk',     name: 'Battery OK',           type: 'boolean', role: 'indicator.maintenance.lowbat', read: true, write: false },
            { id: 'batteryPercent',name: 'Battery (%)',          type: 'number',  role: 'value.battery',           read: true,  write: false, unit: '%' },
            { id: 'temperatureC',  name: 'Temperature (°C)',     type: 'number',  role: 'value.temperature',       read: true,  write: false, unit: '°C' },
            { id: 'serial',        name: 'Serial Number',        type: 'string',  role: 'text',                    read: true,  write: false },
            { id: 'firmware',      name: 'Firmware Version',     type: 'string',  role: 'text',                    read: true,  write: false },
            { id: 'online',        name: 'Online',               type: 'boolean', role: 'indicator.connected',     read: true,  write: false },
            { id: 'motionAlert',   name: 'Motion Alert',         type: 'boolean', role: 'indicator.motion',        read: true,  write: false },
            { id: 'thumbnail',     name: 'Thumbnail URL',        type: 'string',  role: 'url',                     read: true,  write: false },
            { id: 'snapshot',      name: 'Trigger Snapshot',     type: 'boolean', role: 'button',                  read: false, write: true,  def: false },
            { id: 'lastUpdated',   name: 'Last Updated',         type: 'string',  role: 'value.datetime',          read: true,  write: false },
            { id: 'wifiStrength',  name: 'WiFi Strength (dBm)',  type: 'number',  role: 'value',                   read: true,  write: false, unit: 'dBm' },
        ];
        await Promise.all(states.map(s =>
            this.extendObjectAsync(`${id}.${s.id}`, {
                type: 'state',
                common: {
                    name: s.name, type: s.type, role: s.role, read: s.read, write: s.write,
                    ...(s.unit ? { unit: s.unit } : {}),
                    ...(s.def !== undefined ? { def: s.def } : {}),
                },
                native: {},
            })
        ));
    }

    // ─── State Updates ─────────────────────────────────────────────────────────

    async updateNetworkStates(net) {
        const id = `networks.${net.id}`;
        await Promise.all([
            this.setState(`${id}.name`,      { val: net.name || '', ack: true }),
            this.setState(`${id}.armed`,     { val: !!net.armed,    ack: true }),
            this.setState(`${id}.enabled`,   { val: !!net.enabled,  ack: true }),
            this.setState(`${id}.networkId`, { val: net.id,         ack: true }),
        ]);
    }

    async updateCameraStates(networkId, cam) {
        const id  = `networks.${networkId}.cameras.${cam.id}`;
        const toC = f => f != null ? Math.round((f - 32) * 5 / 9 * 10) / 10 : null;

        const updates = [
            this.setState(`${id}.name`,        { val: cam.name || '', ack: true }),
            this.setState(`${id}.enabled`,     { val: cam.enabled != null ? !!cam.enabled : true, ack: true }),
            this.setState(`${id}.serial`,      { val: cam.serial || '', ack: true }),
            this.setState(`${id}.firmware`,    { val: cam.fw_version || cam.firmware || '', ack: true }),
            this.setState(`${id}.online`,      { val: cam.status === 'online', ack: true }),
            this.setState(`${id}.motionAlert`, { val: !!cam.motion_alert, ack: true }),
            this.setState(`${id}.lastUpdated`, { val: new Date().toISOString(), ack: true }),
        ];

        // M2: separate batteryOk + batteryPercent
        if (cam.battery != null) {
            let pct = null, ok = true;
            if (typeof cam.battery === 'string') {
                ok  = cam.battery === 'ok';
                pct = ok ? 100 : 20;
            } else {
                pct = cam.battery;
                ok  = cam.battery > 20;
            }
            updates.push(this.setState(`${id}.batteryOk`,      { val: ok,  ack: true }));
            updates.push(this.setState(`${id}.batteryPercent`, { val: pct, ack: true }));
        }

        // M1: only °C
        if (cam.temperature != null) {
            updates.push(this.setState(`${id}.temperatureC`, { val: toC(cam.temperature), ack: true }));
        }

        if (cam.signals && cam.signals.wifi != null) {
            updates.push(this.setState(`${id}.wifiStrength`, { val: cam.signals.wifi, ack: true }));
        }

        if (cam.thumbnail) {
            const thumbUrl = cam.thumbnail.startsWith('http') ? cam.thumbnail : `${this.authData.host}${cam.thumbnail}`;
            updates.push(this.setState(`${id}.thumbnail`, { val: thumbUrl, ack: true }));

            // H5: store image as file, not in state
            const key = `${networkId}.${cam.id}`;
            if (this.thumbnailUrlCache[key] !== thumbUrl) {
                this._downloadAndStoreImage(thumbUrl, networkId, cam.id).catch(e =>
                    this.log.debug(`Thumbnail download failed: ${e.message}`)
                );
                this.thumbnailUrlCache[key] = thumbUrl;
            }
        }

        await Promise.all(updates);
    }

    // H5: store thumbnail as file (not in state)
    async _downloadAndStoreImage(url, networkId, cameraId) {
        try {
            const fetchUrl = /\.(jpg|jpeg|png)$/i.test(url) ? url : url + '.jpg';
            const resp = await this.apiSession.get(fetchUrl, {
                responseType: 'arraybuffer',
                headers: { 'Authorization': `Bearer ${this.authData.accessToken}` },
            });
            const filename = `thumbs/${networkId}_${cameraId}.jpg`;
            await this.writeFileAsync(this.namespace, filename, Buffer.from(resp.data));
            this.log.debug(`Thumbnail stored: ${filename}`);
        } catch (err) {
            this.log.debug(`Image download failed: ${err.message}`);
        }
    }

    async processVideoEvent(vid) {
        const netId = vid.network_id, camId = vid.device_id || vid.camera_id;
        if (!netId || !camId) return;
        const pfx = `networks.${netId}.cameras.${camId}`;
        await Promise.all([
            this.extendObjectAsync(`${pfx}.lastVideo`, {
                type: 'state', common: { name: 'Last Video URL', type: 'string', role: 'url', read: true, write: false }, native: {},
            }),
            this.extendObjectAsync(`${pfx}.lastVideoTime`, {
                type: 'state', common: { name: 'Last Video Time', type: 'string', role: 'value.datetime', read: true, write: false }, native: {},
            }),
        ]);
        const vidUrl = vid.address ? (vid.address.startsWith('http') ? vid.address : `${this.authData.host}${vid.address}`) : '';
        await Promise.all([
            this.setState(`${pfx}.lastVideo`,     { val: vidUrl,             ack: true }),
            this.setState(`${pfx}.lastVideoTime`, { val: vid.created_at||'', ack: true }),
        ]);
    }

    // ─── Camera Actions ────────────────────────────────────────────────────────

    async triggerSnapshot(networkId, cameraId, name) {
        try {
            await this.blinkRequest('post', `/network/${networkId}/camera/${cameraId}/thumbnail`);
            this.log.info(`Snapshot triggered for camera ${name || cameraId}`);
        } catch (err) {
            this.log.warn(`Snapshot failed for ${name || cameraId}: ${err.message}`);
        }
    }

    async armNetwork(networkId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/arm`);
        this.log.info(`Network ${networkId} armed.`);
    }

    async disarmNetwork(networkId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/disarm`);
        this.log.info(`Network ${networkId} disarmed.`);
    }

    // ─── State Change Handler ──────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        this.log.debug(`State changed: ${id}`);
        const parts = id.replace(`${this.namespace}.`, '').split('.');
        if (parts[0] !== 'networks') return;
        const networkId = parseInt(parts[1]);

        if (parts[2] === 'cameras') {
            const cameraId = parseInt(parts[3]);
            if (parts[4] === 'snapshot' && state.val) {
                this.log.info(`Manual snapshot triggered for camera ${cameraId}`);
                await this.triggerSnapshot(networkId, cameraId);
                await this.sleep(4000);
                await this.fetchAllData();
            }
        } else {
            // M3: only armed state (no arm/disarm buttons)
            if (parts[2] === 'armed') {
                if (state.val === true) { await this.armNetwork(networkId); }
                else { await this.disarmNetwork(networkId); }
                await this.fetchAllData();
            }
        }
    }

    // ─── Message Handler ───────────────────────────────────────────────────────

    async onMessage(obj) {
        if (!obj || !obj.command) return;

        if (obj.command === 'verifyPin') {
            const pin = obj.message && obj.message.pin;
            if (!pin || !this._pendingCsrf) {
                this.sendTo(obj.from, obj.command, { error: 'No PIN provided or no pending login' }, obj.callback);
                return;
            }
            const ok = await this.oauthVerify2fa(this._pendingSession, this._pendingCsrf, pin);
            if (ok) {
                const code = await this.oauthGetCode(this._pendingSession);
                if (code) {
                    const tokenData = await this.oauthExchangeCode(code, this._pendingVerifier, this._pendingHwId);
                    if (tokenData) {
                        await this.processTokenData(tokenData, this._pendingHwId);
                        this._pendingCsrf = null; this._pendingVerifier = null;
                        this._pendingHwId = null; this._pendingSession = null;
                        this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                        return;
                    }
                }
            }
            this.sendTo(obj.from, obj.command, { success: false }, obj.callback);

        } else if (obj.command === 'refreshSnapshots') {
            this.fetchAllSnapshots('manual').catch(e => this.log.warn(e.message));
            this.sendTo(obj.from, obj.command, { queued: true }, obj.callback);

        } else if (obj.command === 'getStatus') {
            this.sendTo(obj.from, obj.command, {
                connected:  !!this.authData,
                pinPending: !!this._pendingCsrf,
            }, obj.callback);
        }
    }

    // ─── HTTP Helper ───────────────────────────────────────────────────────────

    async blinkRequest(method, endpoint, body = null) {
        if (!this.authData) throw new Error('Not authenticated');
        const url     = `${this.authData.host}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${this.authData.accessToken}`,
            'Content-Type':  'application/json',
        };
        // M6: explicit status validation
        const validateStatus = s => s >= 200 && s < 300;
        const resp = method === 'get'
            ? await this.apiSession.get(url, { headers, validateStatus })
            : await this.apiSession.post(url, body || {}, { headers, validateStatus });
        return resp.data;
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

if (require.main !== module) { module.exports = (options) => new BlinkAdapter(options); }
else { new BlinkAdapter(); }
