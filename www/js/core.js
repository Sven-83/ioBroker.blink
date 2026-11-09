/*
 * Blink camera page - logic without DOM or socket access (unit tested).
 *
 * Works as a browser script (window.BlinkPageCore) and as a CommonJS module (tests).
 * Nothing here knows real cameras: networks and cameras come from the adapter's states.
 */
(function (/** @type {Record<string, unknown>} */ root, factory) {
    const core = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = core;
    } else {
        root.BlinkPageCore = core;
    }
})(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis)), function () {
    'use strict';

    /** @type {Record<string, Record<string, string>>} */
    const TEXTS = {
        de: {
            title: 'Kameras',
            cameras: 'Kameras',
            camera: 'Kamera',
            armed: 'Scharf',
            disarmed: 'Unscharf',
            arm: 'Scharf',
            disarm: 'Unscharf',
            armPending: 'wird geschaltet …',
            snapshot: 'Bild',
            snapshotAll: 'Alle Bilder',
            snapshotAllHint: 'Neues Bild von allen Kameras dieses Netzwerks (weckt jede Kamera, kostet Akku)',
            live: 'Live',
            close: 'Schließen',
            offline: 'offline',
            batteryLow: 'Akku schwach',
            motionOff: 'Bewegung aus',
            noImage: 'kein Bild',
            justNow: 'gerade eben',
            minutesAgo: 'vor {n} Min',
            hoursAgo: 'vor {n} Std',
            daysAgo: 'vor {n} Tagen',
            liveStarting: 'Livebild wird gestartet …',
            liveWaiting: 'Warte auf das erste Bild …',
            liveEndedTitle: 'Livebild beendet',
            noCameras: 'Keine Kameras gefunden. Läuft die Blink-Instanz?',
            disconnected: 'Keine Verbindung zu ioBroker',
            noSocket: 'Socket-Schnittstelle des web-Adapters nicht verfügbar',
            cloudOffline: 'Keine Verbindung zu Blink',
            httpsLive: 'Livebild geht nur, wenn diese Seite über http geöffnet ist',
            viewAll: 'Übersicht',
            viewTabs: 'Reiter',
            withAll: 'Startseite schaltet mit scharf',
            withAllHint: 'Bleibt gespeichert, bis du es wieder änderst',
            pinTitle: '{name} unscharf schalten',
            pinHint: 'PIN eingeben',
            pinDelete: 'Löschen',
            // results of commands (states snapshotResult, armResult, liveResult)
            'snapshot.confirmed': 'neues Bild',
            'snapshot.unconfirmed': 'kein neues Bild',
            'snapshot.rejected': 'fehlgeschlagen',
            'snapshot.busy': 'Blink ist beschäftigt',
            'snapshot.offline': 'Kamera offline',
            'snapshot.throttled': 'Bild ist noch aktuell',
            motionOnHint: 'Bewegungserkennung an – antippen zum Ausschalten',
            motionOffHint: 'Bewegungserkennung aus – antippen zum Einschalten',
            'motion.confirmed': 'Bewegung umgeschaltet',
            'motion.rejected': 'Bewegung: abgelehnt',
            'motion.unconfirmed': 'Bewegung: nicht bestätigt',
            'arm.confirmed': 'bestätigt',
            'arm.rejected': 'abgelehnt',
            'arm.unconfirmed': 'nicht bestätigt',
            'live.running': 'läuft',
            'live.ended': 'beendet',
            'live.idle': 'beendet, niemand hat zugeschaut',
            'live.failed': 'fehlgeschlagen',
            'live.certificate': 'Zertifikat des Stream-Servers nicht akzeptiert',
            'live.noFfmpeg': 'ffmpeg nicht gefunden',
            'live.offline': 'Kamera offline',
            'live.unsupported': 'bietet Blink für diese Kamera nicht an',
            'live.disabled': 'in den Einstellungen der Instanz ausgeschaltet',
            'live.busy': 'ein anderes Livebild läuft gerade',
            'live.rejected': 'gerade nicht möglich',
        },
        en: {
            title: 'Cameras',
            cameras: 'cameras',
            camera: 'camera',
            armed: 'Armed',
            disarmed: 'Disarmed',
            arm: 'Arm',
            disarm: 'Disarm',
            armPending: 'switching …',
            snapshot: 'Image',
            snapshotAll: 'All images',
            snapshotAllHint: 'New image from every camera of this network (wakes each camera, uses battery)',
            live: 'Live',
            close: 'Close',
            offline: 'offline',
            batteryLow: 'Battery low',
            motionOff: 'Motion off',
            noImage: 'no image',
            justNow: 'just now',
            minutesAgo: '{n} min ago',
            hoursAgo: '{n} h ago',
            daysAgo: '{n} days ago',
            liveStarting: 'Starting live image …',
            liveWaiting: 'Waiting for the first image …',
            liveEndedTitle: 'Live image ended',
            noCameras: 'No cameras found. Is the Blink instance running?',
            disconnected: 'No connection to ioBroker',
            noSocket: 'Socket interface of the web adapter not available',
            cloudOffline: 'No connection to Blink',
            httpsLive: 'The live image only works when this page is opened via http',
            viewAll: 'Overview',
            viewTabs: 'Tabs',
            withAll: 'Armed from the start page',
            withAllHint: 'Stays as it is until you change it',
            pinTitle: 'Disarm {name}',
            pinHint: 'Enter PIN',
            pinDelete: 'Delete',
            'snapshot.confirmed': 'new image',
            'snapshot.unconfirmed': 'no new image',
            'snapshot.rejected': 'failed',
            'snapshot.busy': 'Blink is busy',
            'snapshot.offline': 'camera offline',
            'snapshot.throttled': 'image is still recent',
            motionOnHint: 'Motion detection on – tap to switch off',
            motionOffHint: 'Motion detection off – tap to switch on',
            'motion.confirmed': 'motion switched',
            'motion.rejected': 'motion: rejected',
            'motion.unconfirmed': 'motion: not confirmed',
            'arm.confirmed': 'confirmed',
            'arm.rejected': 'rejected',
            'arm.unconfirmed': 'not confirmed',
            'live.running': 'running',
            'live.ended': 'ended',
            'live.idle': 'ended, nobody watched',
            'live.failed': 'failed',
            'live.certificate': 'certificate of the stream server not accepted',
            'live.noFfmpeg': 'ffmpeg not found',
            'live.offline': 'camera offline',
            'live.unsupported': 'not offered by Blink for this camera',
            'live.disabled': 'switched off in the instance settings',
            'live.busy': 'another live image is running',
            'live.rejected': 'not possible at the moment',
        },
    };

    /**
     * Page language from the ioBroker system language.
     *
     * @param {unknown} language - system.config common.language
     * @returns {'de'|'en'}
     */
    function pickLanguage(language) {
        return language === 'de' ? 'de' : 'en';
    }

    /**
     * Translated text, {n} replaced.
     *
     * @param {'de'|'en'} lang - Language
     * @param {string} key - Text key
     * @param {number|string} [n] - Value for {n} or {name}
     * @returns {string}
     */
    function t(lang, key, n) {
        const texts = TEXTS[lang] || TEXTS.en;
        const text = texts[key] !== undefined ? texts[key] : TEXTS.en[key] !== undefined ? TEXTS.en[key] : key;
        return n === undefined ? text : text.replace(/\{n(?:ame)?\}/, String(n));
    }

    /**
     * Where a PIN script checks the PIN for disarming (?pin=<base>&pinDigits=4). The page writes the target to
     * <base>.pinZiel, the entry to <base>.pinEingabe and shows <base>.meldung. Without it, disarming needs no PIN.
     * Only user data and script states are accepted, nothing of an adapter.
     *
     * @param {string} search - location.search
     * @returns {{base: string, digits: number} | null}
     */
    function pinFromSearch(search) {
        const params = new URLSearchParams(search || '');
        const base = params.get('pin') || '';
        if (!/^(0_userdata|javascript)\.\d{1,3}(\.[A-Za-z0-9_-]{1,64}){1,8}$/.test(base)) {
            return null;
        }
        const digits = Number(params.get('pinDigits') || 4);
        return { base, digits: Number.isInteger(digits) && digits >= 4 && digits <= 8 ? digits : 4 };
    }

    /**
     * Next PIN entry after a key of the pad.
     *
     * @param {string} entry - Entry so far
     * @param {string} key - Digit or "del"
     * @param {number} digits - Length of the PIN
     * @returns {{entry: string, complete: boolean}}
     */
    function pinKey(entry, key, digits) {
        if (key === 'del') {
            return { entry: entry.slice(0, -1), complete: false };
        }
        if (!/^\d$/.test(key) || entry.length >= digits) {
            return { entry, complete: entry.length >= digits };
        }
        const next = entry + key;
        return { entry: next, complete: next.length >= digits };
    }

    /**
     * Text of a command result, empty for an unknown or empty value.
     *
     * @param {'de'|'en'} lang - Language
     * @param {'snapshot'|'arm'|'live'|'motion'} kind - Command
     * @param {unknown} result - Value of the result state
     * @returns {string}
     */
    function resultText(lang, kind, result) {
        if (typeof result !== 'string' || !result) {
            return '';
        }
        const key = `${kind}.${result}`;
        return TEXTS.en[key] !== undefined ? t(lang, key) : '';
    }

    /**
     * Instance number from the page URL (?instance=1), default 0.
     *
     * @param {string} search - location.search
     * @returns {number}
     */
    function instanceFromSearch(search) {
        const match = /[?&]instance=(\d{1,3})(?:&|$)/.exec(search || '');
        return match ? Number(match[1]) : 0;
    }

    /**
     * Number IDs of the devices of one folder (networks, cameras) from state IDs.
     *
     * @param {string[]} ids - Full state IDs
     * @param {string} namespace - e.g. blink.0
     * @param {string} folder - networks or cameras
     * @returns {number[]} sorted, unique
     */
    function deviceIds(ids, namespace, folder) {
        const prefix = `${namespace}.${folder}.`;
        const found = new Set();
        for (const id of ids) {
            if (typeof id !== 'string' || !id.startsWith(prefix)) {
                continue;
            }
            const part = id.slice(prefix.length).split('.')[0];
            if (/^\d{1,15}$/.test(part)) {
                found.add(Number(part));
            }
        }
        return [...found].sort((a, b) => a - b);
    }

    /**
     * @typedef {{id: number, name: string, available: unknown}} NetworkInfo
     * @typedef {{id: number, name: string, networkId: unknown, available: unknown}} CameraInfo
     * @typedef {{id: number, name: string, cameras: CameraInfo[]}} Group
     */

    /**
     * Cameras grouped by network: networks in the order Blink created them (ascending ID), cameras by name.
     * Devices Blink no longer reports (available = false) are left out, a network without cameras too.
     *
     * @param {NetworkInfo[]} networks - Networks
     * @param {CameraInfo[]} cameras - Cameras
     * @param {'de'|'en'} lang - Language for sorting
     * @returns {Group[]}
     */
    function groupCameras(networks, cameras, lang) {
        const byName = (/** @type {{name: string, id: number}} */ a, /** @type {{name: string, id: number}} */ b) =>
            a.name.localeCompare(b.name, lang, { numeric: true, sensitivity: 'base' }) || a.id - b.id;
        return networks
            .filter(network => network.available !== false)
            .map(network => ({
                id: network.id,
                name: network.name,
                cameras: cameras
                    .filter(camera => camera.available !== false && camera.networkId === network.id)
                    .sort(byName),
            }))
            .filter(group => group.cameras.length > 0)
            .sort((a, b) => a.id - b.id);
    }

    /**
     * Age of an image, e.g. "vor 5 Min". Empty for an unknown time.
     *
     * @param {'de'|'en'} lang - Language
     * @param {unknown} time - imageTime (ms)
     * @param {number} now - Current time (ms)
     * @returns {string}
     */
    function formatAge(lang, time, now) {
        if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) {
            return '';
        }
        const minutes = Math.floor(Math.max(0, now - time) / 60_000);
        if (minutes < 1) {
            return t(lang, 'justNow');
        }
        if (minutes < 60) {
            return t(lang, 'minutesAgo', minutes);
        }
        const hours = Math.floor(minutes / 60);
        if (hours < 48) {
            return t(lang, 'hoursAgo', hours);
        }
        return t(lang, 'daysAgo', Math.floor(hours / 24));
    }

    /**
     * Address of the stored image for an <img>. Only files of this instance are accepted, nothing else the
     * state might contain. The time makes the browser load a new image with the same name.
     *
     * @param {string} namespace - e.g. blink.0
     * @param {unknown} url - Value of the image state
     * @param {unknown} time - imageTime
     * @returns {string} empty if not usable
     */
    function imageSrc(namespace, url, time) {
        if (typeof url !== 'string') {
            return '';
        }
        const prefix = `/${namespace}/`;
        const name = url.slice(prefix.length);
        // file names of the image store: cameras/<id>.jpg - at most one folder, no "..", no hidden files
        if (!url.startsWith(prefix) || !/^(?:[A-Za-z0-9_-]{1,40}\/)?[A-Za-z0-9_-][A-Za-z0-9._-]{0,80}$/.test(name)) {
            return '';
        }
        const stamp = typeof time === 'number' && Number.isFinite(time) ? `?t=${Math.round(time)}` : '';
        return `..${prefix}${name}${stamp}`;
    }

    /**
     * Address of the live image from the answer of liveStart. The live server of the adapter runs on the same
     * host as the web adapter, on its own port, and only speaks http.
     *
     * @param {{protocol: string, hostname: string}} location - window.location
     * @param {unknown} access - Answer of liveStart
     * @returns {string} empty if not usable
     */
    function liveUrl(location, access) {
        if (!access || typeof access !== 'object') {
            return '';
        }
        const { port, path } = /** @type {{port?: unknown, path?: unknown}} */ (access);
        if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
            return '';
        }
        if (typeof path !== 'string' || !/^\/live\/\d{1,15}\.mjpeg\?token=[0-9a-f]{16,128}$/.test(path)) {
            return '';
        }
        if (location.protocol !== 'http:' || !location.hostname) {
            return '';
        }
        const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
        return `http://${host}:${port}${path}`;
    }

    /**
     * View from the page address: ?view=all (all networks on one page) or ?view=tabs. Null if not given.
     *
     * @param {string} search - location.search
     * @returns {'all'|'tabs'|null}
     */
    function viewFromSearch(search) {
        const view = new URLSearchParams(search || '').get('view');
        return view === 'all' || view === 'tabs' ? view : null;
    }

    /**
     * Columns of the overview: every network is a band with its controls on the left and its cameras on the
     * right. Gives the fewest columns (largest images) with which all bands fit the height; if none does, the most.
     *
     * @param {{width: number, height: number, counts: number[], headWidth: number, headMin: number, gap: number, strip: number, minCols?: number, maxCols?: number}} box - Space and sizes in px
     * @returns {number}
     */
    function fitColumns(box) {
        const minCols = box.minCols || 3;
        const maxCols = box.maxCols || 10;
        const most = Math.max(minCols, Math.min(maxCols, Math.max(1, ...box.counts)));
        for (let cols = minCols; cols <= most; cols++) {
            if (overviewHeight(box, cols) <= box.height) {
                return cols;
            }
        }
        return most;
    }

    /**
     * Height of the overview with a number of columns.
     *
     * @param {{width: number, counts: number[], headWidth: number, headMin: number, gap: number, strip: number}} box - Space and sizes in px
     * @param {number} cols - Columns
     * @returns {number}
     */
    function overviewHeight(box, cols) {
        const cardWidth = (box.width - box.headWidth - box.gap - (cols - 1) * box.gap) / cols;
        const cardHeight = (cardWidth * 9) / 16 + box.strip;
        const bands = box.counts.map(count => {
            const rows = Math.max(1, Math.ceil(count / cols));
            return Math.max(box.headMin, rows * cardHeight + (rows - 1) * box.gap);
        });
        return bands.reduce((sum, band) => sum + band, 0) + Math.max(0, bands.length - 1) * box.gap;
    }

    /**
     * Small markers of a camera, in display order.
     *
     * @param {{status: unknown, batteryLow: unknown, enabled: unknown}} values - Camera values
     * @returns {Array<'offline'|'batteryLow'|'motionOff'>}
     */
    function cameraBadges(values) {
        /** @type {Array<'offline'|'batteryLow'|'motionOff'>} */
        const badges = [];
        if (
            typeof values.status === 'string' &&
            values.status &&
            values.status !== 'done' &&
            values.status !== 'online'
        ) {
            badges.push('offline');
        }
        if (values.batteryLow === true) {
            badges.push('batteryLow');
        }
        if (values.enabled === false) {
            badges.push('motionOff');
        }
        return badges;
    }

    return {
        TEXTS,
        pickLanguage,
        t,
        resultText,
        instanceFromSearch,
        pinFromSearch,
        pinKey,
        deviceIds,
        groupCameras,
        formatAge,
        imageSrc,
        liveUrl,
        viewFromSearch,
        fitColumns,
        overviewHeight,
        cameraBadges,
    };
});
