'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

const DEFAULT_BASE_URL = 'https://rest-prod.immedia-semi.com';
const BLINK_BASE_URLS = {
    'prod': 'https://rest-prod.immedia-semi.com',
    'e001': 'https://rest-e001.immedia-semi.com',
    'e002': 'https://rest-e002.immedia-semi.com',
    'u011': 'https://rest-u011.immedia-semi.com',
    'u021': 'https://rest-u021.immedia-semi.com',
    'e006': 'https://rest-e006.immedia-semi.com',
};

// OAuth2 PKCE constants (from iOS app reverse engineering, Nov 2025)
const OAUTH_CLIENT_ID     = 'blink_android';
const OAUTH_REDIRECT_URI  = 'blink://oauth_callback';
const OAUTH_AUTH_URL      = 'https://rest-prod.immedia-semi.com/api/v6/account/oauth/authorize';
const OAUTH_TOKEN_URL     = 'https://rest-prod.immedia-semi.com/api/v6/account/oauth/token';
const LOCAL_CALLBACK_PORT = 7654;

class BlinkAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'blink' });

        this.authData          = null;
        this.pollingTimer      = null;
        this.weeklyTimer       = null;
        this.snapshotRunning   = false;
        this.thumbnailUrlCache = {};
        this.lastVideoCache    = {};
        this._oauthServer      = null;
        this._oauthResolve     = null;

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.setState('info.connection', false, true);

        if (!this.config.email || !this.config.password) {
            this.log.error('Email and password must be configured in adapter settings.');
            return;
        }

        // Try restored token first
        const savedToken = await this.getStateAsync('auth.accessToken');
        const savedRefresh = await this.getStateAsync('auth.refreshToken');
        const savedAccountId = await this.getStateAsync('auth.accountId');
        const savedBaseUrl = await this.getStateAsync('auth.baseUrl');

        if (savedToken && savedToken.val && savedAccountId && savedAccountId.val) {
            this.authData = {
                accessToken:  savedToken.val,
                refreshToken: savedRefresh ? savedRefresh.val : null,
                accountId:    savedAccountId.val,
                baseUrl:      savedBaseUrl ? savedBaseUrl.val : DEFAULT_BASE_URL,
            };
            this.log.info('Restored saved Blink OAuth token.');
            const ok = await this.verifyToken();
            if (!ok) {
                // Try refresh first
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    this.authData = null;
                    await this.loginOAuth();
                }
            }
        } else {
            await this.loginOAuth();
        }
    }

    onUnload(callback) {
        try {
            if (this.pollingTimer) clearInterval(this.pollingTimer);
            if (this.weeklyTimer)  clearTimeout(this.weeklyTimer);
            if (this._oauthServer) this._oauthServer.close();
        } catch (e) { /* ignore */ }
        callback();
    }

    // ─── OAuth2 PKCE Login ────────────────────────────────────────────────────

    generatePKCE() {
        const verifier  = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    }

    async loginOAuth() {
        this.log.info('Starting Blink OAuth2 PKCE login...');

        const { verifier, challenge } = this.generatePKCE();
        const state = crypto.randomBytes(16).toString('hex');

        // Build authorization URL
        const authUrl = `${OAUTH_AUTH_URL}?` + new URLSearchParams({
            response_type:         'code',
            client_id:             OAUTH_CLIENT_ID,
            redirect_uri:          `http://localhost:${LOCAL_CALLBACK_PORT}/callback`,
            scope:                 'openid email offline_access',
            state:                 state,
            code_challenge:        challenge,
            code_challenge_method: 'S256',
            login_hint:            this.config.email,
        }).toString();

        this.log.warn('=== BLINK OAUTH LOGIN REQUIRED ===');
        this.log.warn(`Please open this URL in your browser to log in:`);
        this.log.warn(authUrl);
        this.log.warn(`Waiting for OAuth callback on port ${LOCAL_CALLBACK_PORT}...`);

        // Also store the URL as a state so it can be retrieved via Admin
        await this.setObjectNotExistsAsync('auth.loginUrl', {
            type: 'state',
            common: { name: 'OAuth Login URL', type: 'string', role: 'url', read: true, write: false },
            native: {},
        });
        await this.setStateAsync('auth.loginUrl', { val: authUrl, ack: true });

        try {
            const code = await this.waitForOAuthCallback(state);
            await this.exchangeCodeForToken(code, verifier);
        } catch (err) {
            this.log.error(`OAuth login failed: ${err.message}`);
            this.setState('info.connection', false, true);
        }
    }

    waitForOAuthCallback(expectedState) {
        return new Promise((resolve, reject) => {
            this._oauthResolve = resolve;
            const timeout = setTimeout(() => {
                if (this._oauthServer) this._oauthServer.close();
                reject(new Error('OAuth callback timeout after 5 minutes'));
            }, 5 * 60 * 1000);

            this._oauthServer = http.createServer((req, res) => {
                const parsed = url.parse(req.url, true);
                if (parsed.pathname !== '/callback') {
                    res.end('Not found');
                    return;
                }

                const { code, state, error } = parsed.query;

                if (error) {
                    res.end(`<html><body><h2>Login failed: ${error}</h2></body></html>`);
                    clearTimeout(timeout);
                    this._oauthServer.close();
                    reject(new Error(`OAuth error: ${error}`));
                    return;
                }

                if (state !== expectedState) {
                    res.end(`<html><body><h2>Invalid state parameter</h2></body></html>`);
                    clearTimeout(timeout);
                    this._oauthServer.close();
                    reject(new Error('OAuth state mismatch'));
                    return;
                }

                res.end(`<html><body><h2>Login successful!</h2><p>You can close this window.</p></body></html>`);
                clearTimeout(timeout);
                this._oauthServer.close();
                resolve(code);
            });

            this._oauthServer.listen(LOCAL_CALLBACK_PORT, () => {
                this.log.info(`OAuth callback server listening on port ${LOCAL_CALLBACK_PORT}`);
            });

            this._oauthServer.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`OAuth server error: ${err.message}`));
            });
        });
    }

    async exchangeCodeForToken(code, verifier) {
        this.log.info('Exchanging OAuth code for token...');
        try {
            const resp = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
                grant_type:    'authorization_code',
                client_id:     OAUTH_CLIENT_ID,
                code:          code,
                redirect_uri:  `http://localhost:${LOCAL_CALLBACK_PORT}/callback`,
                code_verifier: verifier,
            }).toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent':   'Blink/10.12.0 (iPhone; iOS 17.0)',
                },
                timeout: 15000,
            });

            const data = resp.data;
            await this.processTokenResponse(data);

        } catch (err) {
            this.log.error(`Token exchange failed: ${err.message}`);
            throw err;
        }
    }

    async refreshAccessToken() {
        if (!this.authData || !this.authData.refreshToken) return false;
        this.log.info('Refreshing Blink access token...');
        try {
            const resp = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
                grant_type:    'refresh_token',
                client_id:     OAUTH_CLIENT_ID,
                refresh_token: this.authData.refreshToken,
            }).toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent':   'Blink/10.12.0 (iPhone; iOS 17.0)',
                },
                timeout: 15000,
            });

            await this.processTokenResponse(resp.data);
            this.log.info('Token refreshed successfully.');
            return true;
        } catch (err) {
            this.log.warn(`Token refresh failed: ${err.message}`);
            return false;
        }
    }

    async processTokenResponse(data) {
        // After token exchange, get account info
        const tempToken = data.access_token;
        let accountId = null;
        let baseUrl = DEFAULT_BASE_URL;

        try {
            const accountResp = await axios.get(`${DEFAULT_BASE_URL}/api/v3/account/info`, {
                headers: {
                    'Authorization': `Bearer ${tempToken}`,
                    'User-Agent':    'Blink/10.12.0 (iPhone; iOS 17.0)',
                },
                timeout: 15000,
            });
            accountId = accountResp.data.account && accountResp.data.account.id;
            const tier = accountResp.data.account && accountResp.data.account.tier;
            if (tier && BLINK_BASE_URLS[tier]) baseUrl = BLINK_BASE_URLS[tier];
        } catch (e) {
            this.log.debug(`Could not fetch account info: ${e.message}`);
            // Try to get accountId from token payload (JWT)
            try {
                const payload = JSON.parse(Buffer.from(tempToken.split('.')[1], 'base64').toString());
                accountId = payload.account_id || payload.sub;
            } catch (_) { /* ignore */ }
        }

        this.authData = {
            accessToken:  tempToken,
            refreshToken: data.refresh_token || null,
            accountId:    accountId,
            baseUrl:      baseUrl,
        };

        await this.saveAuthData();
        this.setState('info.connection', true, true);
        this.log.info('Blink OAuth login successful.');
        this.startPolling();
    }

    async verifyToken() {
        try {
            await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            return true;
        } catch (err) {
            this.log.debug('Token invalid or expired.');
            return false;
        }
    }

    async saveAuthData() {
        await this.setObjectNotExistsAsync('auth', {
            type: 'channel', common: { name: 'Auth (internal)' }, native: {},
        });
        const states = [
            { id: 'auth.accessToken',  name: 'Access Token',   val: this.authData.accessToken  },
            { id: 'auth.refreshToken', name: 'Refresh Token',  val: this.authData.refreshToken || '' },
            { id: 'auth.accountId',    name: 'Account ID',     val: this.authData.accountId    },
            { id: 'auth.baseUrl',      name: 'Base URL',       val: this.authData.baseUrl       },
        ];
        for (const s of states) {
            await this.setObjectNotExistsAsync(s.id, {
                type: 'state',
                common: { name: s.name, type: 'string', role: 'text', read: true, write: false },
                native: {},
            });
            await this.setStateAsync(s.id, { val: s.val, ack: true });
        }
    }

    // ─── Polling ──────────────────────────────────────────────────────────────

    startPolling() {
        const pollInterval = (this.config.pollingInterval || 30) * 1000;
        this.fetchAllData();
        this.pollingTimer = setInterval(() => this.fetchAllData(), pollInterval);
        this.scheduleWeeklySnapshot();
        this.log.info('Polling started.');
    }

    scheduleWeeklySnapshot() {
        const ms = this.msUntilNextSaturday12();
        this.weeklyTimer = setTimeout(async () => {
            this.log.info('Weekly Saturday snapshot...');
            await this.fetchAllSnapshots('weekly');
            this.scheduleWeeklySnapshot();
        }, ms);
    }

    msUntilNextSaturday12() {
        const now = new Date();
        const target = new Date(now);
        let daysUntilSat = (6 - now.getDay() + 7) % 7;
        if (daysUntilSat === 0 && now.getHours() >= 12) daysUntilSat = 7;
        target.setDate(now.getDate() + daysUntilSat);
        target.setHours(12, 0, 0, 0);
        return target.getTime() - now.getTime();
    }

    async fetchAllData() {
        if (!this.authData) return;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            this.setState('info.connection', true, true);
            await this.processHomescreenData(data);
        } catch (err) {
            this.log.warn(`Error fetching Blink data: ${err.message}`);
            if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                this.log.info('Token expired, attempting refresh...');
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    this.authData = null;
                    this.setState('info.connection', false, true);
                    if (this.pollingTimer) clearInterval(this.pollingTimer);
                    await this.loginOAuth();
                }
            }
        }
    }

    async fetchAllSnapshots(reason = 'manual') {
        if (!this.authData || this.snapshotRunning) return;
        this.snapshotRunning = true;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            const cameras = [
                ...(data.cameras   || []),
                ...(data.owls      || []),
                ...(data.doorbells || []),
            ];
            for (const cam of cameras) {
                await this.triggerCameraSnapshot(cam.network_id, cam.id, cam.name);
                await this.sleep(3000);
            }
            await this.fetchAllData();
        } catch (err) {
            this.log.warn(`Snapshot cycle error (${reason}): ${err.message}`);
        } finally {
            this.snapshotRunning = false;
        }
    }

    // ─── Data Processing ──────────────────────────────────────────────────────

    async processHomescreenData(data) {
        if (data.networks) {
            for (const net of data.networks) {
                await this.createNetworkObjects(net);
                await this.updateNetworkStates(net);
            }
        }
        if (data.cameras) {
            for (const cam of data.cameras) {
                await this.createCameraObjects(cam.network_id, cam);
                await this.updateCameraStates(cam.network_id, cam);
            }
        }
        if (data.owls) {
            for (const owl of data.owls) {
                await this.createCameraObjects(owl.network_id, owl, true);
                await this.updateCameraStates(owl.network_id, owl, true);
            }
        }
        if (data.doorbells) {
            for (const db of data.doorbells) {
                await this.createCameraObjects(db.network_id, db, false, true);
                await this.updateCameraStates(db.network_id, db, false, true);
            }
        }
        if (data.videos) {
            for (const vid of data.videos) await this.processVideoEvent(vid);
            await this.checkMotionAndSnapshot(data);
        }
    }

    async checkMotionAndSnapshot(data) {
        if (!data.videos || data.videos.length === 0) return;
        const armedNetworks = new Set(
            (data.networks || []).filter(n => n.armed).map(n => String(n.id))
        );
        const needSnapshot = [];
        for (const vid of data.videos) {
            const netId = String(vid.network_id);
            const camId = String(vid.device_id || vid.camera_id);
            if (!netId || !camId || !armedNetworks.has(netId)) continue;
            const key = `${netId}.${camId}`;
            if (vid.created_at && vid.created_at !== this.lastVideoCache[key]) {
                this.lastVideoCache[key] = vid.created_at;
                if (!needSnapshot.find(c => c.netId === netId && c.camId === camId)) {
                    needSnapshot.push({ netId, camId, name: vid.camera_name });
                }
            }
        }
        if (needSnapshot.length === 0 || this.snapshotRunning) return;
        this.snapshotRunning = true;
        try {
            for (const cam of needSnapshot) {
                await this.triggerCameraSnapshot(cam.netId, cam.camId, cam.name);
                if (needSnapshot.length > 1) await this.sleep(3000);
            }
            await this.sleep(4000);
            await this.fetchAllData();
        } finally {
            this.snapshotRunning = false;
        }
    }

    // ─── ioBroker Objects ─────────────────────────────────────────────────────

    async createNetworkObjects(network) {
        const netId = `networks.${network.id}`;
        await this.setObjectNotExistsAsync(netId, {
            type: 'channel', common: { name: network.name || `Network ${network.id}` }, native: {},
        });
        const states = [
            { id: 'name',      name: 'Network Name', type: 'string',  role: 'text',        write: false },
            { id: 'armed',     name: 'Armed',        type: 'boolean', role: 'switch.lock', write: true  },
            { id: 'enabled',   name: 'Enabled',      type: 'boolean', role: 'indicator',   write: false },
            { id: 'networkId', name: 'Network ID',   type: 'number',  role: 'value',       write: false },
            { id: 'arm',       name: 'Arm network',  type: 'boolean', role: 'button',      write: true, def: false },
            { id: 'disarm',    name: 'Disarm',       type: 'boolean', role: 'button',      write: true, def: false },
        ];
        for (const s of states) {
            await this.setObjectNotExistsAsync(`${netId}.${s.id}`, {
                type: 'state',
                common: { name: s.name, type: s.type, role: s.role, read: true, write: s.write, ...(s.def !== undefined ? { def: s.def } : {}) },
                native: {},
            });
        }
    }

    async createCameraObjects(networkId, cam, isMini = false, isDoorbell = false) {
        const camId = `networks.${networkId}.cameras.${cam.id}`;
        await this.setObjectNotExistsAsync(`networks.${networkId}.cameras`, {
            type: 'channel', common: { name: 'Cameras' }, native: {},
        });
        await this.setObjectNotExistsAsync(camId, {
            type: 'channel',
            common: { name: `${isDoorbell ? 'Doorbell' : isMini ? 'Blink Mini' : 'Camera'}: ${cam.name || cam.id}` },
            native: { cameraId: cam.id, networkId },
        });
        const states = [
            { id: 'name',          name: 'Camera Name',          type: 'string',  role: 'text',                write: false },
            { id: 'enabled',       name: 'Enabled',              type: 'boolean', role: 'indicator',           write: false },
            { id: 'battery',       name: 'Battery (%)',           type: 'number',  role: 'value.battery',       write: false, unit: '%'   },
            { id: 'temperature',   name: 'Temperature (°F)',      type: 'number',  role: 'value.temperature',   write: false, unit: '°F'  },
            { id: 'temperatureC',  name: 'Temperature (°C)',      type: 'number',  role: 'value.temperature',   write: false, unit: '°C'  },
            { id: 'serial',        name: 'Serial Number',         type: 'string',  role: 'text',                write: false },
            { id: 'firmware',      name: 'Firmware',              type: 'string',  role: 'text',                write: false },
            { id: 'online',        name: 'Online',                type: 'boolean', role: 'indicator.connected', write: false },
            { id: 'motionAlert',   name: 'Motion Alert',          type: 'boolean', role: 'indicator.motion',    write: false },
            { id: 'thumbnail',     name: 'Thumbnail URL',         type: 'string',  role: 'url',                 write: false },
            { id: 'thumbnailData', name: 'Thumbnail (Base64)',    type: 'string',  role: 'url',                 write: false },
            { id: 'snapshot',      name: 'Trigger snapshot',      type: 'boolean', role: 'button',              write: true, def: false },
            { id: 'lastUpdated',   name: 'Last Updated',          type: 'string',  role: 'value.datetime',      write: false },
            { id: 'wifiStrength',  name: 'WiFi Strength (dBm)',   type: 'number',  role: 'value',               write: false, unit: 'dBm' },
        ];
        for (const s of states) {
            await this.setObjectNotExistsAsync(`${camId}.${s.id}`, {
                type: 'state',
                common: { name: s.name, type: s.type, role: s.role, read: true, write: s.write, ...(s.unit ? { unit: s.unit } : {}), ...(s.def !== undefined ? { def: s.def } : {}) },
                native: {},
            });
        }
    }

    // ─── State Updates ────────────────────────────────────────────────────────

    async updateNetworkStates(network) {
        const id = `networks.${network.id}`;
        await this.setStateAsync(`${id}.name`,      { val: network.name || '',   ack: true });
        await this.setStateAsync(`${id}.armed`,     { val: !!network.armed,      ack: true });
        await this.setStateAsync(`${id}.enabled`,   { val: !!network.enabled,    ack: true });
        await this.setStateAsync(`${id}.networkId`, { val: network.id,           ack: true });
    }

    async updateCameraStates(networkId, cam) {
        const id = `networks.${networkId}.cameras.${cam.id}`;
        const toC = f => f != null ? Math.round((f - 32) * 5 / 9 * 10) / 10 : null;

        await this.setStateAsync(`${id}.name`,        { val: cam.name || '', ack: true });
        await this.setStateAsync(`${id}.enabled`,     { val: cam.enabled != null ? !!cam.enabled : true, ack: true });
        await this.setStateAsync(`${id}.serial`,      { val: cam.serial || '', ack: true });
        await this.setStateAsync(`${id}.firmware`,    { val: cam.fw_version || cam.firmware || '', ack: true });
        await this.setStateAsync(`${id}.online`,      { val: cam.status === 'online', ack: true });
        await this.setStateAsync(`${id}.motionAlert`, { val: !!cam.motion_alert, ack: true });
        await this.setStateAsync(`${id}.lastUpdated`, { val: new Date().toISOString(), ack: true });

        if (cam.battery != null) {
            const pct = typeof cam.battery === 'string'
                ? (cam.battery === 'ok' ? 100 : cam.battery === 'low' ? 20 : null)
                : cam.battery;
            await this.setStateAsync(`${id}.battery`, { val: pct, ack: true });
        }
        if (cam.temperature != null) {
            await this.setStateAsync(`${id}.temperature`,  { val: cam.temperature, ack: true });
            await this.setStateAsync(`${id}.temperatureC`, { val: toC(cam.temperature), ack: true });
        }
        if (cam.signals && cam.signals.wifi != null) {
            await this.setStateAsync(`${id}.wifiStrength`, { val: cam.signals.wifi, ack: true });
        }
        if (cam.thumbnail) {
            const thumbUrl = cam.thumbnail.startsWith('http')
                ? cam.thumbnail
                : `${this.authData.baseUrl}${cam.thumbnail}`;
            await this.setStateAsync(`${id}.thumbnail`, { val: thumbUrl, ack: true });
            const cacheKey = `${networkId}.${cam.id}`;
            if (this.thumbnailUrlCache[cacheKey] !== thumbUrl) {
                try {
                    const imgData = await this.downloadImageAsBase64(thumbUrl);
                    if (imgData) {
                        await this.setStateAsync(`${id}.thumbnailData`, { val: imgData, ack: true });
                        this.thumbnailUrlCache[cacheKey] = thumbUrl;
                    }
                } catch (e) { this.log.debug(`Thumbnail download failed: ${e.message}`); }
            }
        }
    }

    async processVideoEvent(vid) {
        const netId = vid.network_id;
        const camId = vid.device_id || vid.camera_id;
        if (!netId || !camId) return;
        const prefix = `networks.${netId}.cameras.${camId}`;
        await this.setObjectNotExistsAsync(`${prefix}.lastVideo`, {
            type: 'state', common: { name: 'Last Video URL', type: 'string', role: 'url', read: true, write: false }, native: {},
        });
        await this.setObjectNotExistsAsync(`${prefix}.lastVideoTime`, {
            type: 'state', common: { name: 'Last Video Time', type: 'string', role: 'value.datetime', read: true, write: false }, native: {},
        });
        const videoUrl = vid.address
            ? (vid.address.startsWith('http') ? vid.address : `${this.authData.baseUrl}${vid.address}`)
            : '';
        await this.setStateAsync(`${prefix}.lastVideo`,     { val: videoUrl,          ack: true });
        await this.setStateAsync(`${prefix}.lastVideoTime`, { val: vid.created_at || '', ack: true });
    }

    // ─── Camera Actions ───────────────────────────────────────────────────────

    async triggerCameraSnapshot(networkId, cameraId, name) {
        try {
            await this.blinkRequest('post',
                `/api/v5/accounts/${this.authData.accountId}/networks/${networkId}/cameras/${cameraId}/thumbnail`
            );
        } catch (err) {
            this.log.warn(`Snapshot failed for ${name || cameraId}: ${err.message}`);
        }
    }

    async armNetwork(networkId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/arm`);
    }

    async disarmNetwork(networkId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/disarm`);
    }

    // ─── State Change Handler ─────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const parts = id.replace(`${this.namespace}.`, '').split('.');
        if (parts[0] !== 'networks') return;
        const networkId = parseInt(parts[1]);

        if (parts[2] === 'cameras') {
            const cameraId = parseInt(parts[3]);
            const action   = parts[4];
            if (action === 'snapshot' && state.val) {
                await this.triggerCameraSnapshot(networkId, cameraId);
                await this.sleep(4000);
                await this.fetchAllData();
            }
        } else {
            const action = parts[2];
            if ((action === 'arm' && state.val) || (action === 'armed' && state.val)) {
                await this.armNetwork(networkId);
                await this.fetchAllData();
            } else if ((action === 'disarm' && state.val) || (action === 'armed' && !state.val)) {
                await this.disarmNetwork(networkId);
                await this.fetchAllData();
            }
        }
    }

    // ─── Message Handler ──────────────────────────────────────────────────────

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        if (obj.command === 'getLoginUrl') {
            const s = await this.getStateAsync('auth.loginUrl');
            this.sendTo(obj.from, obj.command, { url: s ? s.val : null }, obj.callback);
        } else if (obj.command === 'refreshSnapshots') {
            this.fetchAllSnapshots('manual').catch(e => this.log.warn(e.message));
            this.sendTo(obj.from, obj.command, { queued: true }, obj.callback);
        } else if (obj.command === 'getStatus') {
            this.sendTo(obj.from, obj.command, { connected: this.authData !== null }, obj.callback);
        }
    }

    // ─── HTTP Helper ──────────────────────────────────────────────────────────

    async blinkRequest(method, endpoint, body = null) {
        if (!this.authData) throw new Error('Not authenticated');
        const url = `${this.authData.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${this.authData.accessToken}`,
            'Content-Type':  'application/json',
            'User-Agent':    'Blink/10.12.0 (iPhone; iOS 17.0)',
        };
        const config = { headers, timeout: 15000 };
        let resp;
        if (method === 'get')    resp = await axios.get(url, config);
        else if (method === 'post') resp = await axios.post(url, body || {}, config);
        else if (method === 'delete') resp = await axios.delete(url, config);
        return resp.data;
    }

    async downloadImageAsBase64(url) {
        try {
            const fetchUrl = (url.endsWith('.jpg') || url.endsWith('.jpeg') || url.endsWith('.png')) ? url : url + '.jpg';
            const resp = await axios.get(fetchUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'Authorization': `Bearer ${this.authData.accessToken}`,
                    'User-Agent':    'Blink/10.12.0 (iPhone; iOS 17.0)',
                },
                timeout: 15000,
            });
            const base64   = Buffer.from(resp.data, 'binary').toString('base64');
            const mimeType = resp.headers['content-type'] || 'image/jpeg';
            return `data:${mimeType};base64,${base64}`;
        } catch (err) {
            this.log.debug(`Image download failed: ${err.message}`);
            return null;
        }
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

if (require.main !== module) {
    module.exports = (options) => new BlinkAdapter(options);
} else {
    new BlinkAdapter();
}
