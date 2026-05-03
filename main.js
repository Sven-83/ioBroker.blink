'use strict';

const utils   = require('@iobroker/adapter-core');
const axios   = require('axios');
const crypto  = require('crypto');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const OAUTH_BASE_URL      = 'https://api.oauth.blink.com';
const OAUTH_AUTHORIZE_URL = `${OAUTH_BASE_URL}/oauth/v2/authorize`;
const OAUTH_SIGNIN_URL    = `${OAUTH_BASE_URL}/oauth/v2/signin`;
const OAUTH_2FA_URL       = `${OAUTH_BASE_URL}/oauth/v2/2fa/verify`;
const OAUTH_TOKEN_URL     = `${OAUTH_BASE_URL}/oauth/token`;
const OAUTH_V2_CLIENT_ID  = 'ios';
const OAUTH_REDIRECT_URI  = 'immedia-blink://applinks.blink.com/signin/callback';
const TIER_ENDPOINT       = 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';
const OAUTH_USER_AGENT    = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const OAUTH_TOKEN_UA      = 'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';
const DEFAULT_BASE_URL    = 'https://rest-prod.immedia-semi.com';
const BLINK_BASE_URLS     = {
    prod: 'https://rest-prod.immedia-semi.com',
    e001: 'https://rest-e001.immedia-semi.com',
    e002: 'https://rest-e002.immedia-semi.com',
    e006: 'https://rest-e006.immedia-semi.com',
    u011: 'https://rest-u011.immedia-semi.com',
    u021: 'https://rest-u021.immedia-semi.com',
};

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

class BlinkAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'blink' });
        this.authData          = null;
        this.pollingTimer      = null;
        this.weeklyTimer       = null;
        this.snapshotRunning   = false;
        this.thumbnailUrlCache = {};
        this.lastVideoCache    = {};
        this.apiSession        = axios.create({ timeout: 15000 });
        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    async onReady() {
        // Subscriptions registrieren - MUSS in onReady sein
        this.subscribeStates('*');

        this.setState('info.connection', false, true);
        if (!this.config.email || !this.config.password) {
            this.log.error('Email und Passwort muessen konfiguriert werden.');
            return;
        }

        const sToken   = await this.getStateAsync('auth.accessToken');
        const sRefresh = await this.getStateAsync('auth.refreshToken');
        const sHwId    = await this.getStateAsync('auth.hardwareId');
        const sAccount = await this.getStateAsync('auth.accountId');
        const sHost    = await this.getStateAsync('auth.host');

        if (sToken && sToken.val && sAccount && sAccount.val) {
            this.authData = {
                accessToken:  sToken.val,
                refreshToken: sRefresh ? sRefresh.val : null,
                hardwareId:   sHwId    ? sHwId.val    : generateHardwareId(),
                accountId:    sAccount.val,
                host:         sHost    ? sHost.val    : DEFAULT_BASE_URL,
            };
            this.log.info('Gespeichertes Blink-Token wiederhergestellt.');
            const ok = await this.verifyToken();
            if (!ok) {
                const refreshed = this.authData.refreshToken ? await this.refreshAccessToken() : false;
                if (!refreshed) { this.authData = null; await this.loginOAuth(); }
            } else {
                this.setState('info.connection', true, true);
                this.startPolling();
            }
        } else {
            await this.loginOAuth();
        }
    }

    onUnload(callback) {
        try {
            if (this.pollingTimer) clearInterval(this.pollingTimer);
            if (this.weeklyTimer)  clearTimeout(this.weeklyTimer);
        } catch (_) {}
        callback();
    }

    async loginOAuth() {
        this.log.info('Starte Blink OAuth2 Login...');
        const oauthSession = createOAuthSession();
        const hardwareId = (this.authData && this.authData.hardwareId) || generateHardwareId();
        const { verifier, challenge } = generatePKCE();
        try {
            await this.oauthAuthorizeRequest(oauthSession, hardwareId, challenge);
            const csrfToken = await this.oauthGetCsrfToken(oauthSession);
            if (!csrfToken) throw new Error('CSRF Token nicht gefunden');
            this.log.debug('CSRF Token erhalten.');

            const loginResult = await this.oauthSignin(oauthSession, csrfToken);
            this.log.debug(`Login Ergebnis: ${loginResult}`);

            if (loginResult === '2FA_REQUIRED') {
                this._pendingSession  = oauthSession;
                this._pendingCsrf     = csrfToken;
                this._pendingVerifier = verifier;
                this._pendingHwId     = hardwareId;
                this.log.warn('Blink 2FA erforderlich. Sende PIN per: sendTo("blink.0", "verifyPin", {pin: "123456"})');
                return;
            }
            if (loginResult !== 'SUCCESS') throw new Error(`Login fehlgeschlagen (Status: ${loginResult})`);

            const code = await this.oauthGetCode(oauthSession);
            if (!code) throw new Error('Authorization Code nicht erhalten');

            const tokenData = await this.oauthExchangeCode(code, verifier, hardwareId);
            if (!tokenData) throw new Error('Token-Austausch fehlgeschlagen');

            await this.processTokenData(tokenData, hardwareId);
            this.log.info('Blink OAuth2 Login erfolgreich.');
        } catch (err) {
            this.log.error(`OAuth Login Fehler: ${err.message}`);
            this.setState('info.connection', false, true);
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
                headers: { 'User-Agent': OAUTH_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
                maxRedirects: 10,
            });
        } catch (_) {}
    }

    async oauthGetCsrfToken(session) {
        const resp = await session.get(OAUTH_SIGNIN_URL, {
            headers: { 'User-Agent': OAUTH_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        });
        const m = resp.data.match(/"csrf-token":"([^"]+)"/);
        if (m) return m[1];
        const m2 = resp.data.match(/name=["']csrf-token["'][^>]*value=["']([^"']+)["']/);
        return m2 ? m2[1] : null;
    }

    async oauthSignin(session, csrfToken) {
        const data = new URLSearchParams({
            username: this.config.email, password: this.config.password, 'csrf-token': csrfToken,
        });
        try {
            const resp = await session.post(OAUTH_SIGNIN_URL, data.toString(), {
                headers: { 'User-Agent': OAUTH_USER_AGENT, 'Accept': '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://api.oauth.blink.com', 'Referer': OAUTH_SIGNIN_URL },
                maxRedirects: 0, validateStatus: s => s < 600,
            });
            this.log.debug(`Signin Status: ${resp.status}`);
            if (resp.status === 412) return '2FA_REQUIRED';
            if ([200,301,302,303,307,308].includes(resp.status)) return 'SUCCESS';
            this.log.error(`Login Status ${resp.status}: ${JSON.stringify(resp.data).substring(0, 200)}`);
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
            headers: { 'User-Agent': OAUTH_USER_AGENT, 'Accept': '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://api.oauth.blink.com', 'Referer': OAUTH_SIGNIN_URL },
            validateStatus: s => s < 600,
        });
        if (resp.status === 201) { try { return resp.data.status === 'auth-completed'; } catch (_) {} }
        return false;
    }

    async oauthGetCode(session) {
        try {
            const resp = await session.get(OAUTH_AUTHORIZE_URL, {
                headers: { 'User-Agent': OAUTH_USER_AGENT, 'Referer': OAUTH_SIGNIN_URL },
                maxRedirects: 0, validateStatus: s => s < 600,
            });
            const loc = resp.headers['location'];
            this.log.debug(`GetCode Status: ${resp.status}, Location: ${loc || 'keine'}`);
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
            headers: { 'User-Agent': OAUTH_TOKEN_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': '*/*' },
        });
        return resp.data;
    }

    async refreshAccessToken() {
        if (!this.authData || !this.authData.refreshToken) return false;
        this.log.info('Erneuere Blink Access Token...');
        try {
            const data = new URLSearchParams({
                grant_type: 'refresh_token', client_id: OAUTH_V2_CLIENT_ID,
                refresh_token: this.authData.refreshToken, hardware_id: this.authData.hardwareId,
            });
            const resp = await this.apiSession.post(OAUTH_TOKEN_URL, data.toString(), {
                headers: { 'User-Agent': OAUTH_TOKEN_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            await this.processTokenData(resp.data, this.authData.hardwareId);
            this.log.info('Token erfolgreich erneuert.');
            return true;
        } catch (err) { this.log.warn(`Token-Erneuerung fehlgeschlagen: ${err.message}`); return false; }
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
            this.log.info(`Blink Region: ${tier}, Account ID: ${accountId}`);
        } catch (err) { this.log.warn(`Tier-Info Fehler: ${err.message}`); }
        this.authData = { accessToken, refreshToken, hardwareId, accountId, host };
        await this.saveAuthData();
        this.setState('info.connection', true, true);
        this.startPolling();
    }

    async verifyToken() {
        try {
            if (!this.authData || !this.authData.accountId) return false;
            await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            return true;
        } catch (_) { return false; }
    }

    async saveAuthData() {
        await this.setObjectNotExistsAsync('auth', { type: 'channel', common: { name: 'Auth' }, native: {} });
        for (const [id, val] of [
            ['auth.accessToken',  this.authData.accessToken],
            ['auth.refreshToken', this.authData.refreshToken || ''],
            ['auth.hardwareId',   this.authData.hardwareId],
            ['auth.accountId',    String(this.authData.accountId || '')],
            ['auth.host',         this.authData.host],
        ]) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: id, type: 'string', role: 'text', read: true, write: false }, native: {} });
            await this.setStateAsync(id, { val, ack: true });
        }
    }

    startPolling() {
        const ms = (this.config.pollingInterval || 30) * 1000;
        this.fetchAllData();
        this.pollingTimer = setInterval(() => this.fetchAllData(), ms);
        this.scheduleWeeklySnapshot();
        this.log.info('Polling gestartet.');
    }

    scheduleWeeklySnapshot() {
        const ms = this.msUntilNextSaturday12();
        this.weeklyTimer = setTimeout(async () => { await this.fetchAllSnapshots('weekly'); this.scheduleWeeklySnapshot(); }, ms);
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
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            this.setState('info.connection', true, true);
            await this.processHomescreenData(data);
        } catch (err) {
            this.log.warn(`Datenabruf Fehler: ${err.message}`);
            if (err.response && [401, 403].includes(err.response.status)) {
                const r = await this.refreshAccessToken();
                if (!r) { this.authData = null; this.setState('info.connection', false, true); if (this.pollingTimer) clearInterval(this.pollingTimer); await this.loginOAuth(); }
            }
        }
    }

    async fetchAllSnapshots(reason = 'manual') {
        if (!this.authData || this.snapshotRunning) return;
        this.snapshotRunning = true;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            const cams = [...(data.cameras||[]), ...(data.owls||[]), ...(data.doorbells||[])];
            for (const c of cams) { await this.triggerSnapshot(c.network_id, c.id, c.name); await this.sleep(3000); }
            await this.fetchAllData();
        } catch (err) { this.log.warn(`Snapshot Fehler (${reason}): ${err.message}`); }
        finally { this.snapshotRunning = false; }
    }

    async processHomescreenData(data) {
        for (const n of (data.networks||[])) { await this.createNetworkObjects(n); await this.updateNetworkStates(n); }
        for (const c of (data.cameras||[])) { await this.createCameraObjects(c.network_id, c); await this.updateCameraStates(c.network_id, c); }
        for (const o of (data.owls||[])) { await this.createCameraObjects(o.network_id, o, true); await this.updateCameraStates(o.network_id, o); }
        for (const d of (data.doorbells||[])) { await this.createCameraObjects(d.network_id, d, false, true); await this.updateCameraStates(d.network_id, d); }
        for (const v of (data.videos||[])) await this.processVideoEvent(v);
        await this.checkMotionAndSnapshot(data);
    }

    async checkMotionAndSnapshot(data) {
        if (!data.videos || !data.videos.length) return;
        const armed = new Set((data.networks||[]).filter(n => n.armed).map(n => String(n.id)));
        const need = [];
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
            for (const c of need) { await this.triggerSnapshot(c.nid, c.cid, c.name); if (need.length > 1) await this.sleep(3000); }
            await this.sleep(4000); await this.fetchAllData();
        } finally { this.snapshotRunning = false; }
    }

    async createNetworkObjects(net) {
        const id = `networks.${net.id}`;
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name: net.name || `Netzwerk ${net.id}` }, native: {} });
        for (const s of [
            { id: 'name', type: 'string', role: 'text', write: false },
            { id: 'armed', type: 'boolean', role: 'switch.lock', write: true },
            { id: 'enabled', type: 'boolean', role: 'indicator', write: false },
            { id: 'networkId', type: 'number', role: 'value', write: false },
            { id: 'arm', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'disarm', type: 'boolean', role: 'button', write: true, def: false },
        ]) await this.setObjectNotExistsAsync(`${id}.${s.id}`, { type: 'state', common: { name: s.id, type: s.type, role: s.role, read: true, write: s.write, ...(s.def !== undefined ? { def: s.def } : {}) }, native: {} });
    }

    async createCameraObjects(networkId, cam, isMini = false, isDoorbell = false) {
        const base = `networks.${networkId}.cameras`, id = `${base}.${cam.id}`;
        await this.setObjectNotExistsAsync(base, { type: 'channel', common: { name: 'Kameras' }, native: {} });
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name: `${isDoorbell?'Tuer':isMini?'Mini':'Kamera'}: ${cam.name||cam.id}` }, native: {} });
        for (const s of [
            { id: 'name', type: 'string', role: 'text', write: false },
            { id: 'enabled', type: 'boolean', role: 'indicator', write: false },
            { id: 'battery', type: 'number', role: 'value.battery', write: false, unit: '%' },
            { id: 'temperature', type: 'number', role: 'value.temperature', write: false, unit: '°F' },
            { id: 'temperatureC', type: 'number', role: 'value.temperature', write: false, unit: '°C' },
            { id: 'serial', type: 'string', role: 'text', write: false },
            { id: 'firmware', type: 'string', role: 'text', write: false },
            { id: 'online', type: 'boolean', role: 'indicator.connected', write: false },
            { id: 'motionAlert', type: 'boolean', role: 'indicator.motion', write: false },
            { id: 'thumbnail', type: 'string', role: 'url', write: false },
            { id: 'thumbnailData', type: 'string', role: 'url', write: false },
            { id: 'snapshot', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'lastUpdated', type: 'string', role: 'value.datetime', write: false },
            { id: 'wifiStrength', type: 'number', role: 'value', write: false, unit: 'dBm' },
        ]) await this.setObjectNotExistsAsync(`${id}.${s.id}`, { type: 'state', common: { name: s.id, type: s.type, role: s.role, read: true, write: s.write, ...(s.unit?{unit:s.unit}:{}), ...(s.def!==undefined?{def:s.def}:{}) }, native: {} });
    }

    async updateNetworkStates(net) {
        const id = `networks.${net.id}`;
        await this.setStateAsync(`${id}.name`,      { val: net.name||'',  ack: true });
        await this.setStateAsync(`${id}.armed`,     { val: !!net.armed,   ack: true });
        await this.setStateAsync(`${id}.enabled`,   { val: !!net.enabled, ack: true });
        await this.setStateAsync(`${id}.networkId`, { val: net.id,        ack: true });
    }

    async updateCameraStates(networkId, cam) {
        const id = `networks.${networkId}.cameras.${cam.id}`;
        const toC = f => f != null ? Math.round((f-32)*5/9*10)/10 : null;
        await this.setStateAsync(`${id}.name`,        { val: cam.name||'', ack: true });
        await this.setStateAsync(`${id}.enabled`,     { val: cam.enabled!=null?!!cam.enabled:true, ack: true });
        await this.setStateAsync(`${id}.serial`,      { val: cam.serial||'', ack: true });
        await this.setStateAsync(`${id}.firmware`,    { val: cam.fw_version||cam.firmware||'', ack: true });
        await this.setStateAsync(`${id}.online`,      { val: cam.status==='online' || cam.status==='done', ack: true });
        await this.setStateAsync(`${id}.motionAlert`, { val: !!cam.motion_alert, ack: true });
        await this.setStateAsync(`${id}.lastUpdated`, { val: new Date().toISOString(), ack: true });
        if (cam.battery != null) await this.setStateAsync(`${id}.battery`, { val: typeof cam.battery==='string'?(cam.battery==='ok'?100:20):cam.battery, ack: true });
        if (cam.temperature != null) {
            await this.setStateAsync(`${id}.temperature`,  { val: cam.temperature,        ack: true });
            await this.setStateAsync(`${id}.temperatureC`, { val: toC(cam.temperature),   ack: true });
        }
        if (cam.signals && cam.signals.wifi != null) await this.setStateAsync(`${id}.wifiStrength`, { val: cam.signals.wifi, ack: true });
        if (cam.thumbnail) {
            const thumbUrl = cam.thumbnail.startsWith('http') ? cam.thumbnail : `${this.authData.host}${cam.thumbnail}`;
            await this.setStateAsync(`${id}.thumbnail`, { val: thumbUrl, ack: true });
            const key = `${networkId}.${cam.id}`;
            if (this.thumbnailUrlCache[key] !== thumbUrl) {
                const img = await this.downloadImage(thumbUrl);
                if (img) { await this.setStateAsync(`${id}.thumbnailData`, { val: img, ack: true }); this.thumbnailUrlCache[key] = thumbUrl; }
            }
        }
    }

    async processVideoEvent(vid) {
        const netId = vid.network_id, camId = vid.device_id || vid.camera_id;
        if (!netId || !camId) return;
        const pfx = `networks.${netId}.cameras.${camId}`;
        await this.setObjectNotExistsAsync(`${pfx}.lastVideo`, { type: 'state', common: { name: 'Letztes Video', type: 'string', role: 'url', read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync(`${pfx}.lastVideoTime`, { type: 'state', common: { name: 'Letztes Video Zeit', type: 'string', role: 'value.datetime', read: true, write: false }, native: {} });
        const vidUrl = vid.address ? (vid.address.startsWith('http') ? vid.address : `${this.authData.host}${vid.address}`) : '';
        await this.setStateAsync(`${pfx}.lastVideo`,     { val: vidUrl,             ack: true });
        await this.setStateAsync(`${pfx}.lastVideoTime`, { val: vid.created_at||'', ack: true });
    }

    async triggerSnapshot(networkId, cameraId, name, isOwl = false) {
        // Owl/Mini Kameras (kabelgebunden) brauchen einen anderen Endpoint
        const OWL_IDS = [683562, 784355, 687635, 687342];
        const owl = isOwl || OWL_IDS.includes(Number(cameraId));
        try {
            if (owl) {
                await this.blinkRequest('post', `/api/v1/accounts/${this.authData.accountId}/networks/${networkId}/owls/${cameraId}/thumbnail`);
            } else {
                await this.blinkRequest('post', `/network/${networkId}/camera/${cameraId}/thumbnail`);
            }
            this.log.info(`Snapshot ausgeloest fuer ${name || cameraId}${owl ? ' (Owl/Mini)' : ''}`);
        } catch (err) { this.log.warn(`Snapshot Fehler ${name||cameraId}: ${err.message}`); }
    }

    async armNetwork(networkId) {
        try {
            await this.blinkRequest('post', `/network/${networkId}/arm`);
            this.log.info(`Netzwerk ${networkId} scharf.`);
        } catch (err) { this.log.warn(`Arm Fehler ${networkId}: ${err.message}`); }
    }
    async disarmNetwork(networkId) {
        try {
            await this.blinkRequest('post', `/network/${networkId}/disarm`);
            this.log.info(`Netzwerk ${networkId} unscharf.`);
        } catch (err) { this.log.warn(`Disarm Fehler ${networkId}: ${err.message}`); }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        this.log.debug(`State geaendert: ${id}`);
        const parts = id.replace(`${this.namespace}.`, '').split('.');
        if (parts[0] !== 'networks') return;
        const networkId = parseInt(parts[1]);
        if (parts[2] === 'cameras') {
            const cameraId = parseInt(parts[3]);
            if (parts[4] === 'snapshot' && state.val) {
                this.log.info(`Snapshot wird ausgeloest fuer Kamera ${cameraId}`);
                await this.triggerSnapshot(networkId, cameraId);
                await this.sleep(4000);
                await this.fetchAllData();
            }
        } else {
            const action = parts[2];
            if ((action === 'arm' && state.val) || (action === 'armed' && state.val === true)) { await this.armNetwork(networkId); await this.fetchAllData(); }
            else if ((action === 'disarm' && state.val) || (action === 'armed' && state.val === false)) { await this.disarmNetwork(networkId); await this.fetchAllData(); }
        }
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        if (obj.command === 'verifyPin') {
            const pin = obj.message && obj.message.pin;
            if (!pin || !this._pendingCsrf) { this.sendTo(obj.from, obj.command, { error: 'Kein PIN oder kein ausstehender Login' }, obj.callback); return; }
            const ok = await this.oauthVerify2fa(this._pendingSession, this._pendingCsrf, pin);
            if (ok) {
                const code = await this.oauthGetCode(this._pendingSession);
                if (code) {
                    const tokenData = await this.oauthExchangeCode(code, this._pendingVerifier, this._pendingHwId);
                    if (tokenData) {
                        await this.processTokenData(tokenData, this._pendingHwId);
                        this._pendingCsrf = null; this._pendingVerifier = null; this._pendingHwId = null; this._pendingSession = null;
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
            this.sendTo(obj.from, obj.command, { connected: !!this.authData }, obj.callback);
        }
    }

    async blinkRequest(method, endpoint, body = null) {
        if (!this.authData) throw new Error('Nicht authentifiziert');
        const url = `${this.authData.host}${endpoint}`;
        const headers = { 'Authorization': `Bearer ${this.authData.accessToken}`, 'Content-Type': 'application/json' };
        const resp = method === 'get' ? await this.apiSession.get(url, { headers }) : await this.apiSession.post(url, body||{}, { headers });
        return resp.data;
    }

    async downloadImage(url) {
        try {
            const fetchUrl = /\.(jpg|jpeg|png)$/i.test(url) ? url : url + '.jpg';
            const resp = await this.apiSession.get(fetchUrl, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${this.authData.accessToken}` } });
            return `data:${resp.headers['content-type']||'image/jpeg'};base64,${Buffer.from(resp.data).toString('base64')}`;
        } catch (_) { return null; }
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

if (require.main !== module) { module.exports = (options) => new BlinkAdapter(options); }
else { new BlinkAdapter(); }
