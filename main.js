'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Blink API base URLs per region
const BLINK_BASE_URLS = {
    'prod': 'https://rest-prod.immedia-semi.com',
    'e001': 'https://rest-e001.immedia-semi.com',
    'e002': 'https://rest-e002.immedia-semi.com',
    'u011': 'https://rest-u011.immedia-semi.com',
};

const DEFAULT_BASE_URL = 'https://rest-prod.immedia-semi.com';

class BlinkAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'blink' });

        this.authData = null;           // { token, accountId, clientId, baseUrl }
        this.pollingTimer = null;
        this.weeklyTimer = null;
        this.pinPending = false;
        this.thumbnailUrlCache = {};    // "netId.camId" → last downloaded URL
        this.lastVideoCache = {};       // "netId.camId" → created_at of last known video
        this.snapshotRunning = false;   // prevent overlapping snapshot cycles

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.setState('info.connection', false, true);

        if (!this.config.email || !this.config.password) {
            this.log.error('Email and password must be configured in adapter settings.');
            return;
        }

        // Try to restore saved auth token
        const savedAuth = await this.getStateAsync('auth.token');
        const savedAccountId = await this.getStateAsync('auth.accountId');
        const savedClientId = await this.getStateAsync('auth.clientId');
        const savedBaseUrl = await this.getStateAsync('auth.baseUrl');

        if (savedAuth && savedAuth.val && savedAccountId && savedAccountId.val) {
            this.authData = {
                token: savedAuth.val,
                accountId: savedAccountId.val,
                clientId: savedClientId ? savedClientId.val : null,
                baseUrl: savedBaseUrl ? savedBaseUrl.val : DEFAULT_BASE_URL,
            };
            this.log.info('Restored saved Blink session token.');
            const ok = await this.verifyToken();
            if (!ok) {
                this.authData = null;
                await this.login();
            }
        } else {
            await this.login();
        }
    }

    onUnload(callback) {
        try {
            if (this.pollingTimer) clearInterval(this.pollingTimer);
            if (this.weeklyTimer)  clearTimeout(this.weeklyTimer);
        } catch (e) { /* ignore */ }
        callback();
    }

    // ─── Authentication ───────────────────────────────────────────────────────

    async login() {
    this.log.info('Logging in to Blink...');
    try {
        const resp = await axios.post(`${DEFAULT_BASE_URL}/api/v5/account/login`, {
            email: this.config.email,
            password: this.config.password,
            unique_id: this.getUniqueId(),
            device_identifier: 'ioBroker-blink-adapter',
            client_name: 'ioBroker',
            reauth: true,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'app-build': '9.53.0 (1)',
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
                'locale': 'de_DE',
                'x-blink-time-zone': 'Europe/Berlin',
            },
            timeout: 15000,
        });

            const data = resp.data;
            const region = data.account && data.account.tier;
            const baseUrl = (region && BLINK_BASE_URLS[region]) || DEFAULT_BASE_URL;

            this.authData = {
                token: data.auth.token,
                accountId: data.account.id,
                clientId: data.client ? data.client.id : null,
                baseUrl,
            };

            // Save token for later restores
            await this.saveAuthData();

            if (data.client && data.client.verification_required) {
                this.pinPending = true;
                this.log.warn('Blink requires 2-factor authentication. Send PIN via adapter message or configure in settings.');

                // Auto-use pin from config if provided
                if (this.config.pin && this.config.pin.length > 0) {
                    await this.verifyPin(this.config.pin);
                } else {
                    this.log.warn('Set your 2FA PIN in the adapter config and restart, or send it via message.');
                }
                return;
            }

            this.log.info('Blink login successful.');
            this.setState('info.connection', true, true);
            this.startPolling();

        } catch (err) {
            this.log.error(`Blink login failed: ${err.message}`);
            this.setState('info.connection', false, true);
        }
    }

    async verifyPin(pin) {
        if (!this.authData) return false;
        try {
            await this.blinkRequest('post',
                `/api/v4/account/${this.authData.accountId}/client/${this.authData.clientId}/pin/verify`,
                { pin: String(pin) }
            );
            this.pinPending = false;
            this.log.info('2FA PIN verified successfully.');
            this.setState('info.connection', true, true);
            this.startPolling();
            return true;
        } catch (err) {
            this.log.error(`PIN verification failed: ${err.message}`);
            return false;
        }
    }

    async verifyToken() {
        try {
            await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            return true;
        } catch (err) {
            this.log.debug('Saved token invalid, re-login required.');
            return false;
        }
    }

    async saveAuthData() {
        await this.setObjectNotExistsAsync('auth', { type: 'channel', common: { name: 'Auth (internal)' }, native: {} });
        await this.setObjectNotExistsAsync('auth.token', { type: 'state', common: { name: 'Auth token', type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync('auth.accountId', { type: 'state', common: { name: 'Account ID', type: 'number', role: 'value', read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync('auth.clientId', { type: 'state', common: { name: 'Client ID', type: 'number', role: 'value', read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync('auth.baseUrl', { type: 'state', common: { name: 'Base URL', type: 'string', role: 'text', read: true, write: false }, native: {} });

        await this.setStateAsync('auth.token', { val: this.authData.token, ack: true });
        await this.setStateAsync('auth.accountId', { val: this.authData.accountId, ack: true });
        await this.setStateAsync('auth.clientId', { val: this.authData.clientId, ack: true });
        await this.setStateAsync('auth.baseUrl', { val: this.authData.baseUrl, ack: true });
    }

    // ─── Polling ──────────────────────────────────────────────────────────────

    startPolling() {
        const pollInterval = (this.config.pollingInterval || 30) * 1000;

        // Initial fetch (metadata only — no images yet)
        this.fetchAllData();

        // Regular metadata poll (status, battery, motion events, armed state)
        this.pollingTimer = setInterval(() => this.fetchAllData(), pollInterval);

        // Weekly snapshot: every Saturday at 12:00
        this.scheduleWeeklySnapshot();

        this.log.info('Polling started. Snapshots trigger on: motion+armed, manual button, or Saturday 12:00.');
    }

    scheduleWeeklySnapshot() {
        const msUntilNextSaturday = this.msUntilNextSaturday12();
        const days = Math.round(msUntilNextSaturday / 1000 / 60 / 60 / 24 * 10) / 10;
        this.log.info(`Next weekly snapshot scheduled in ${days} day(s) (Saturday 12:00).`);

        this.weeklyTimer = setTimeout(async () => {
            this.log.info('Weekly Saturday 12:00 snapshot: fetching all camera images...');
            await this.fetchAllSnapshots('weekly');
            // Re-schedule for next week
            this.scheduleWeeklySnapshot();
        }, msUntilNextSaturday);
    }

    msUntilNextSaturday12() {
        const now = new Date();
        const target = new Date(now);
        // Saturday = 6
        const dayOfWeek = now.getDay();  // 0=Sun … 6=Sat
        let daysUntilSat = (6 - dayOfWeek + 7) % 7;

        // If today IS Saturday: check if 12:00 is still in the future
        if (daysUntilSat === 0 && now.getHours() >= 12) {
            daysUntilSat = 7;  // already past 12:00 today → next Saturday
        }

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
                this.log.info('Token expired, re-logging in...');
                this.authData = null;
                this.setState('info.connection', false, true);
                if (this.pollingTimer) clearInterval(this.pollingTimer);
                if (this.snapshotTimer) clearInterval(this.snapshotTimer);
                await this.login();
            }
        }
    }

    // reason: 'motion' | 'weekly' | 'manual'
    async fetchAllSnapshots(reason = 'manual') {
        if (!this.authData) return;
        if (this.snapshotRunning) {
            this.log.debug('Snapshot cycle already running, skipping.');
            return;
        }
        this.snapshotRunning = true;
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/homescreen`);
            const cameras = [
                ...(data.cameras   || []),
                ...(data.owls      || []),
                ...(data.doorbells || []),
            ];

            this.log.info(`Fetching snapshots for all ${cameras.length} cameras (reason: ${reason}, staggered 3s apart)...`);

            for (const cam of cameras) {
                await this.triggerCameraSnapshot(cam.network_id, cam.id, cam.name);
                await this.sleep(3000);
            }

            // Single refresh to pick up new thumbnail URLs
            await this.fetchAllData();

        } catch (err) {
            this.log.warn(`Error during snapshot cycle (${reason}): ${err.message}`);
        } finally {
            this.snapshotRunning = false;
        }
    }

    // ─── Data Processing ──────────────────────────────────────────────────────

    async processHomescreenData(data) {
        // Networks/Systems
        if (data.networks) {
            for (const network of data.networks) {
                await this.createNetworkObjects(network);
                await this.updateNetworkStates(network);
            }
        }

        // Cameras from homescreen
        if (data.cameras) {
            for (const cam of data.cameras) {
                await this.createCameraObjects(cam.network_id, cam);
                await this.updateCameraStates(cam.network_id, cam);
            }
        }

        // Owls (Blink Mini cameras)
        if (data.owls) {
            for (const owl of data.owls) {
                await this.createCameraObjects(owl.network_id, owl, true);
                await this.updateCameraStates(owl.network_id, owl, true);
            }
        }

        // Doorbells
        if (data.doorbells) {
            for (const db of data.doorbells) {
                await this.createCameraObjects(db.network_id, db, false, true);
                await this.updateCameraStates(db.network_id, db, false, true);
            }
        }

        // Video events (last clips) — also triggers motion snapshot if armed
        if (data.videos) {
            for (const vid of data.videos) {
                await this.processVideoEvent(vid);
            }
            // Check for new motion events on armed networks
            await this.checkMotionAndSnapshot(data);
        }
    }

    async checkMotionAndSnapshot(data) {
        if (!data.videos || data.videos.length === 0) return;

        // Build a set of armed network IDs
        const armedNetworks = new Set(
            (data.networks || [])
                .filter(n => n.armed)
                .map(n => String(n.id))
        );

        // Find cameras that have a NEW video event since last check
        const camerasNeedingSnapshot = [];

        for (const vid of data.videos) {
            const netId = String(vid.network_id);
            const camId = String(vid.device_id || vid.camera_id);
            if (!netId || !camId) continue;

            // Only react if the network is armed
            if (!armedNetworks.has(netId)) continue;

            const cacheKey = `${netId}.${camId}`;
            const lastKnown = this.lastVideoCache[cacheKey];
            const vidTime = vid.created_at;

            if (vidTime && vidTime !== lastKnown) {
                this.lastVideoCache[cacheKey] = vidTime;
                // Avoid duplicates if multiple events for same camera
                if (!camerasNeedingSnapshot.find(c => c.netId === netId && c.camId === camId)) {
                    camerasNeedingSnapshot.push({ netId, camId, name: vid.camera_name });
                    this.log.info(`Motion detected on armed camera "${vid.camera_name}" (net ${netId}) — triggering snapshot.`);
                }
            }
        }

        if (camerasNeedingSnapshot.length === 0) return;
        if (this.snapshotRunning) return;

        this.snapshotRunning = true;
        try {
            for (const cam of camerasNeedingSnapshot) {
                await this.triggerCameraSnapshot(cam.netId, cam.camId, cam.name);
                if (camerasNeedingSnapshot.length > 1) await this.sleep(3000);
            }
            // Fetch fresh data to get new thumbnail URLs
            await this.sleep(4000);
            await this.fetchAllData();
        } finally {
            this.snapshotRunning = false;
        }
    }

    // ─── ioBroker Object Creation ─────────────────────────────────────────────

    async createNetworkObjects(network) {
        const netId = `networks.${network.id}`;
        await this.setObjectNotExistsAsync(netId, {
            type: 'channel',
            common: { name: network.name || `Network ${network.id}` },
            native: { networkId: network.id },
        });

        const states = [
            { id: 'name', name: 'Network Name', type: 'string', role: 'text', write: false },
            { id: 'armed', name: 'Armed', type: 'boolean', role: 'switch.lock', write: true },
            { id: 'enabled', name: 'Enabled', type: 'boolean', role: 'indicator', write: false },
            { id: 'networkId', name: 'Network ID', type: 'number', role: 'value', write: false },
            { id: 'arm', name: 'Arm network', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'disarm', name: 'Disarm network', type: 'boolean', role: 'button', write: true, def: false },
        ];

        for (const s of states) {
            await this.setObjectNotExistsAsync(`${netId}.${s.id}`, {
                type: 'state',
                common: {
                    name: s.name,
                    type: s.type,
                    role: s.role,
                    read: true,
                    write: s.write,
                    ...(s.def !== undefined ? { def: s.def } : {}),
                },
                native: {},
            });
        }
    }

    async createCameraObjects(networkId, cam, isMini = false, isDoorbell = false) {
        const camId = `networks.${networkId}.cameras.${cam.id}`;
        const typeLabel = isDoorbell ? 'Doorbell' : (isMini ? 'Blink Mini' : 'Camera');

        await this.setObjectNotExistsAsync(`networks.${networkId}.cameras`, {
            type: 'channel',
            common: { name: 'Cameras' },
            native: {},
        });

        await this.setObjectNotExistsAsync(camId, {
            type: 'channel',
            common: { name: `${typeLabel}: ${cam.name || cam.id}` },
            native: { cameraId: cam.id, networkId },
        });

        const states = [
            { id: 'name', name: 'Camera Name', type: 'string', role: 'text', write: false },
            { id: 'enabled', name: 'Enabled', type: 'boolean', role: 'indicator', write: false },
            { id: 'battery', name: 'Battery (%)', type: 'number', role: 'value.battery', unit: '%', write: false },
            { id: 'batteryVoltage', name: 'Battery Voltage (mV)', type: 'number', role: 'value.voltage', unit: 'mV', write: false },
            { id: 'temperature', name: 'Temperature (°F)', type: 'number', role: 'value.temperature', unit: '°F', write: false },
            { id: 'temperatureC', name: 'Temperature (°C)', type: 'number', role: 'value.temperature', unit: '°C', write: false },
            { id: 'serial', name: 'Serial Number', type: 'string', role: 'text', write: false },
            { id: 'firmware', name: 'Firmware Version', type: 'string', role: 'text', write: false },
            { id: 'type', name: 'Camera Type', type: 'string', role: 'text', write: false },
            { id: 'networkId', name: 'Network ID', type: 'number', role: 'value', write: false },
            { id: 'cameraId', name: 'Camera ID', type: 'number', role: 'value', write: false },
            { id: 'status', name: 'Status', type: 'string', role: 'text', write: false },
            { id: 'online', name: 'Online', type: 'boolean', role: 'indicator.connected', write: false },
            { id: 'motionAlert', name: 'Motion Alert active', type: 'boolean', role: 'indicator.motion', write: false },
            { id: 'lastMotion', name: 'Last Motion detected', type: 'string', role: 'value.datetime', write: false },
            { id: 'thumbnail', name: 'Thumbnail URL', type: 'string', role: 'url', write: false },
            { id: 'thumbnailData', name: 'Thumbnail (Base64 JPEG)', type: 'string', role: 'url', write: false },
            { id: 'snapshot', name: 'Trigger new snapshot', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'enableCamera', name: 'Enable camera', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'disableCamera', name: 'Disable camera', type: 'boolean', role: 'button', write: true, def: false },
            { id: 'lastUpdated', name: 'Last Updated', type: 'string', role: 'value.datetime', write: false },
            { id: 'wifiStrength', name: 'WiFi Strength (dBm)', type: 'number', role: 'value', unit: 'dBm', write: false },
        ];

        for (const s of states) {
            await this.setObjectNotExistsAsync(`${camId}.${s.id}`, {
                type: 'state',
                common: {
                    name: s.name,
                    type: s.type,
                    role: s.role,
                    read: true,
                    write: s.write,
                    ...(s.unit ? { unit: s.unit } : {}),
                    ...(s.def !== undefined ? { def: s.def } : {}),
                },
                native: {},
            });
        }
    }

    // ─── State Updates ────────────────────────────────────────────────────────

    async updateNetworkStates(network) {
        const netId = `networks.${network.id}`;
        await this.setStateAsync(`${netId}.name`, { val: network.name || '', ack: true });
        await this.setStateAsync(`${netId}.armed`, { val: !!network.armed, ack: true });
        await this.setStateAsync(`${netId}.enabled`, { val: !!network.enabled, ack: true });
        await this.setStateAsync(`${netId}.networkId`, { val: network.id, ack: true });
    }

    async updateCameraStates(networkId, cam) {
        const camId = `networks.${networkId}.cameras.${cam.id}`;
        const toC = (f) => f != null ? Math.round((f - 32) * 5 / 9 * 10) / 10 : null;

        await this.setStateAsync(`${camId}.name`, { val: cam.name || '', ack: true });
        await this.setStateAsync(`${camId}.enabled`, { val: cam.enabled != null ? !!cam.enabled : true, ack: true });
        await this.setStateAsync(`${camId}.networkId`, { val: networkId, ack: true });
        await this.setStateAsync(`${camId}.cameraId`, { val: cam.id, ack: true });
        await this.setStateAsync(`${camId}.serial`, { val: cam.serial || '', ack: true });
        await this.setStateAsync(`${camId}.firmware`, { val: cam.fw_version || cam.firmware || '', ack: true });
        await this.setStateAsync(`${camId}.type`, { val: cam.type || cam.camera_type || 'unknown', ack: true });
        await this.setStateAsync(`${camId}.status`, { val: cam.status || '', ack: true });
        await this.setStateAsync(`${camId}.online`, { val: cam.status === 'online' || cam.active === 'armed', ack: true });
        await this.setStateAsync(`${camId}.motionAlert`, { val: !!cam.motion_alert, ack: true });
        await this.setStateAsync(`${camId}.lastUpdated`, { val: new Date().toISOString(), ack: true });

        if (cam.battery != null) {
            const batPct = typeof cam.battery === 'string'
                ? (cam.battery === 'ok' ? 100 : cam.battery === 'low' ? 20 : null)
                : cam.battery;
            await this.setStateAsync(`${camId}.battery`, { val: batPct, ack: true });
        }
        if (cam.battery_voltage != null) {
            await this.setStateAsync(`${camId}.batteryVoltage`, { val: cam.battery_voltage, ack: true });
        }
        if (cam.temperature != null) {
            await this.setStateAsync(`${camId}.temperature`, { val: cam.temperature, ack: true });
            await this.setStateAsync(`${camId}.temperatureC`, { val: toC(cam.temperature), ack: true });
        }
        if (cam.signals && cam.signals.wifi != null) {
            await this.setStateAsync(`${camId}.wifiStrength`, { val: cam.signals.wifi, ack: true });
        }

        // Thumbnail URL (can come as partial path)
        if (cam.thumbnail) {
            const thumbUrl = cam.thumbnail.startsWith('http')
                ? cam.thumbnail
                : `${this.authData.baseUrl}${cam.thumbnail}`;
            await this.setStateAsync(`${camId}.thumbnail`, { val: thumbUrl, ack: true });

            // Only re-download the image if the URL changed (avoids 30× download per poll)
            const cacheKey = `${networkId}.${cam.id}`;
            if (this.thumbnailUrlCache[cacheKey] !== thumbUrl) {
                try {
                    const imgData = await this.downloadImageAsBase64(thumbUrl);
                    if (imgData) {
                        await this.setStateAsync(`${camId}.thumbnailData`, { val: imgData, ack: true });
                        this.thumbnailUrlCache[cacheKey] = thumbUrl;
                    }
                } catch (e) {
                    this.log.debug(`Could not fetch thumbnail image: ${e.message}`);
                }
            }
        }
    }

    async processVideoEvent(vid) {
        // Videos are stored under the camera they belong to
        if (!vid.camera_name && !vid.device_id) return;
        const netId = vid.network_id;
        const camId = vid.device_id || vid.camera_id;
        if (!netId || !camId) return;

        const prefix = `networks.${netId}.cameras.${camId}`;
        await this.setObjectNotExistsAsync(`${prefix}.lastVideo`, {
            type: 'state',
            common: { name: 'Last Video URL', type: 'string', role: 'url', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${prefix}.lastVideoTime`, {
            type: 'state',
            common: { name: 'Last Video Time', type: 'string', role: 'value.datetime', read: true, write: false },
            native: {},
        });

        const videoUrl = vid.address
            ? (vid.address.startsWith('http') ? vid.address : `${this.authData.baseUrl}${vid.address}`)
            : '';
        await this.setStateAsync(`${prefix}.lastVideo`, { val: videoUrl, ack: true });
        await this.setStateAsync(`${prefix}.lastVideoTime`, { val: vid.created_at || '', ack: true });
    }

    // ─── Camera Actions ───────────────────────────────────────────────────────

    async triggerCameraSnapshot(networkId, cameraId, cameraName) {
        this.log.debug(`Triggering snapshot for camera ${cameraName || cameraId}...`);
        try {
            await this.blinkRequest(
                'post',
                `/api/v5/accounts/${this.authData.accountId}/networks/${networkId}/cameras/${cameraId}/thumbnail`
            );
            // NOTE: No fetchAllData() here — caller is responsible for the final refresh.
            // This prevents N×fetchAllData when cycling through 30 cameras.
            this.log.debug(`Snapshot requested for camera ${cameraName || cameraId}`);
        } catch (err) {
            this.log.warn(`Failed to trigger snapshot for camera ${cameraName || cameraId}: ${err.message}`);
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

    async enableCamera(networkId, cameraId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/cameras/${cameraId}/enable`);
        this.log.info(`Camera ${cameraId} enabled.`);
    }

    async disableCamera(networkId, cameraId) {
        await this.blinkRequest('post', `/api/v1/networks/${networkId}/cameras/${cameraId}/disable`);
        this.log.info(`Camera ${cameraId} disabled.`);
    }

    async fetchNetworkCameras(networkId) {
        try {
            const data = await this.blinkRequest('get', `/api/v3/accounts/${this.authData.accountId}/networks/${networkId}/cameras`);
            if (data && data.cameras) {
                for (const cam of data.cameras) {
                    await this.createCameraObjects(networkId, cam);
                    await this.updateCameraStates(networkId, cam);
                }
            }
        } catch (err) {
            this.log.debug(`Could not fetch cameras for network ${networkId}: ${err.message}`);
        }
    }

    // ─── State Change Handler ─────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        // Parse id: blink.0.networks.{netId}.cameras.{camId}.{action}
        //       or: blink.0.networks.{netId}.{action}
        const parts = id.replace(`${this.namespace}.`, '').split('.');

        if (parts[0] !== 'networks') return;
        const networkId = parseInt(parts[1]);

        if (parts[2] === 'cameras') {
            const cameraId = parseInt(parts[3]);
            const action = parts[4];

            if (action === 'snapshot' && state.val) {
                await this.triggerCameraSnapshot(networkId, cameraId);
                await this.sleep(4000);  // give Blink time to process
                await this.fetchAllData();
            } else if (action === 'enableCamera' && state.val) {
                await this.enableCamera(networkId, cameraId);
                await this.fetchAllData();
            } else if (action === 'disableCamera' && state.val) {
                await this.disableCamera(networkId, cameraId);
                await this.fetchAllData();
            }
        } else {
            const action = parts[2];
            if (action === 'arm' && state.val) {
                await this.armNetwork(networkId);
                await this.fetchAllData();
            } else if (action === 'disarm' && state.val) {
                await this.disarmNetwork(networkId);
                await this.fetchAllData();
            } else if (action === 'armed') {
                if (state.val) {
                    await this.armNetwork(networkId);
                } else {
                    await this.disarmNetwork(networkId);
                }
                await this.fetchAllData();
            }
        }
    }

    // ─── Message Handler (for PIN entry via sendTo) ───────────────────────────

    async onMessage(obj) {
        if (!obj || !obj.command) return;

        if (obj.command === 'verifyPin') {
            const pin = obj.message && obj.message.pin;
            if (!pin) {
                this.sendTo(obj.from, obj.command, { error: 'No PIN provided' }, obj.callback);
                return;
            }
            const ok = await this.verifyPin(pin);
            this.sendTo(obj.from, obj.command, { success: ok }, obj.callback);

        } else if (obj.command === 'getStatus') {
            this.sendTo(obj.from, obj.command, {
                connected: this.authData !== null,
                pinPending: this.pinPending,
            }, obj.callback);

        } else if (obj.command === 'refreshAllSnapshots') {
            this.fetchAllSnapshots('manual').catch(e => this.log.warn(e.message));
            this.sendTo(obj.from, obj.command, { queued: true }, obj.callback);
        }
    }

    // ─── HTTP Helper ──────────────────────────────────────────────────────────

async blinkRequest(method, endpoint, body = null) {
    if (!this.authData) throw new Error('Not authenticated');

    const url = `${this.authData.baseUrl}${endpoint}`;
    const headers = {
        'TOKEN_AUTH': this.authData.token,
        'Content-Type': 'application/json',
        'app-build': '9.53.0 (1)',
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'locale': 'de_DE',
        'x-blink-time-zone': 'Europe/Berlin',
    };

    const config = { headers, timeout: 15000 };
    let resp;

    if (method === 'get') {
        resp = await axios.get(url, config);
    } else if (method === 'post') {
        resp = await axios.post(url, body || {}, config);
    } else if (method === 'delete') {
        resp = await axios.delete(url, config);
    }

    return resp.data;
}

    async downloadImageAsBase64(url) {
        try {
            // Add .jpg extension if missing
            const fetchUrl = url.endsWith('.jpg') || url.endsWith('.jpeg') || url.endsWith('.png')
                ? url
                : url + '.jpg';

            const resp = await axios.get(fetchUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'TOKEN_AUTH': this.authData.token,
                    'User-Agent': 'Mozilla/5.0',
                },
                timeout: 15000,
            });
            const base64 = Buffer.from(resp.data, 'binary').toString('base64');
            const mimeType = resp.headers['content-type'] || 'image/jpeg';
            return `data:${mimeType};base64,${base64}`;
        } catch (err) {
            this.log.debug(`Image download failed: ${err.message}`);
            return null;
        }
    }

    // ─── Utilities ────────────────────────────────────────────────────────────

    getUniqueId() {
        return `iobroker-${this.namespace}-${Date.now()}`;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ─── Adapter Start ────────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = (options) => new BlinkAdapter(options);
} else {
    new BlinkAdapter();
}
