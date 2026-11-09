/*
 * Blink camera page - DOM and socket part.
 *
 * Data comes from the socket interface of the web adapter (same origin): all states below
 * blink.<instance>.networks and .cameras are loaded once and then subscribed. Commands are setState calls
 * with ack=false; the live image is started with sendTo, its address only goes to this page.
 *
 * Two views with the same functions: "all" (default: every network as a band, sized so that all cameras fit the
 * page) and "tabs" (one network at a time). ?view=all|tabs in the address fixes the view, otherwise the last choice
 * is kept.
 *
 * Security: names from Blink only reach the page via textContent. innerHTML is used for constant markup only.
 * Disarming asks for a PIN when the page is opened with ?pin=<states of the PIN script>; the script checks it.
 */
(function () {
    'use strict';

    const C = window.BlinkPageCore;
    const instance = C.instanceFromSearch(window.location.search);
    const namespace = `blink.${instance}`;
    const pin = C.pinFromSearch(window.location.search);
    const fixedView = C.viewFromSearch(window.location.search);
    const TAB_KEY = `blink-page-tab-${instance}`;
    const VIEW_KEY = `blink-page-view-${instance}`;
    const RESULT_SHOW_MS = 6000;
    /** sizes of the overview, in line with page.css */
    const OVERVIEW = { headWidth: 178, headMin: 126, gap: 8, strip: 36 };

    let lang = C.pickLanguage((navigator.language || '').slice(0, 2));
    let socket = null;
    /** full state id -> value */
    const values = new Map();
    let groups = [];
    let structure = '';
    let activeNetwork = Number(remember(TAB_KEY)) || 0;
    let view = fixedView || (remember(VIEW_KEY) === 'tabs' ? 'tabs' : 'all');
    /** network id -> section context */
    const sections = new Map();
    /** camera id -> card context */
    const cards = new Map();
    /** state id -> time until a result text is shown */
    const resultUntil = new Map();
    let live = null;
    let pinEntry = '';
    let pinNetwork = 0;

    const $ = id => document.getElementById(id);

    // ------------------------------------------------------------ helpers

    function remember(key, value) {
        try {
            if (value === undefined) {
                return window.localStorage.getItem(key);
            }
            window.localStorage.setItem(key, value);
        } catch {
            // private mode: the choice is just not remembered
        }
        return null;
    }

    function val(relative) {
        return values.get(`${namespace}.${relative}`);
    }

    function setState(id, value) {
        socket.emit('setState', id, { val: value, ack: false }, error => {
            if (error) {
                console.warn(`Setting ${id} failed: ${error}`);
            }
        });
    }

    function sendTo(command, message) {
        return new Promise(resolve => {
            // the web adapter answers with the result as the only argument
            socket.emit('sendTo', namespace, command, message, (...args) => resolve(args[args.length - 1]));
        });
    }

    function call(command, ...args) {
        return new Promise((resolve, reject) => {
            socket.emit(command, ...args, (error, result) =>
                error ? reject(new Error(String(error))) : resolve(result),
            );
        });
    }

    function onActivate(element, handler) {
        element.addEventListener('click', handler);
        element.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handler(event);
            }
        });
    }

    function showBanner(key) {
        const banner = $('banner');
        banner.textContent = key ? C.t(lang, key) : '';
        banner.classList.toggle('show', !!key);
    }

    /**
     * A result text stays visible for a few seconds after it was written.
     *
     * @param {string} relative - Relative state ID of the result
     */
    function freshResult(relative) {
        const until = resultUntil.get(relative) || 0;
        return Date.now() < until ? val(relative) : '';
    }

    // ------------------------------------------------------------ loading

    async function load() {
        showBanner(null);
        try {
            const config = await call('getObject', 'system.config').catch(() => null);
            if (config && config.common && config.common.language) {
                lang = C.pickLanguage(config.common.language);
            }
            document.documentElement.lang = lang;
            document.title = `${C.t(lang, 'title')} – Blink`;
            const [networks, cameras, info] = await Promise.all([
                call('getStates', `${namespace}.networks.*`),
                call('getStates', `${namespace}.cameras.*`),
                call('getStates', `${namespace}.info.*`),
            ]);
            values.clear();
            for (const states of [networks, cameras, info]) {
                for (const [id, state] of Object.entries(states || {})) {
                    values.set(id, state ? state.val : null);
                }
            }
            socket.emit('subscribe', [`${namespace}.networks.*`, `${namespace}.cameras.*`, `${namespace}.info.*`]);
            if (pin) {
                socket.emit('subscribe', `${pin.base}.meldung`);
            }
            structure = '';
            render();
        } catch (error) {
            console.warn(`Loading failed: ${error.message}`);
            showBanner('disconnected');
        }
    }

    function onStateChange(id, state) {
        if (typeof id !== 'string') {
            return;
        }
        if (pin && id === `${pin.base}.meldung`) {
            showPinMessage(state ? state.val : '');
            return;
        }
        if (!id.startsWith(`${namespace}.`)) {
            return;
        }
        values.set(id, state ? state.val : null);
        const relative = id.slice(namespace.length + 1);
        if (/(snapshotResult|armResult|motionResult)$/.test(relative) && state && state.val) {
            resultUntil.set(relative, Date.now() + RESULT_SHOW_MS);
            setTimeout(scheduleRender, RESULT_SHOW_MS + 50);
        }
        if (live && relative === `cameras.${live.cameraId}.liveActive` && state && state.val === false && live.url) {
            endLive(C.resultText(lang, 'live', val(`cameras.${live.cameraId}.liveResult`)));
        }
        scheduleRender();
    }

    let renderQueued = false;
    function scheduleRender() {
        if (!renderQueued) {
            renderQueued = true;
            window.requestAnimationFrame(() => {
                renderQueued = false;
                render();
            });
        }
    }

    // ------------------------------------------------------------ model

    function readGroups() {
        const ids = [...values.keys()];
        const networks = C.deviceIds(ids, namespace, 'networks').map(id => ({
            id,
            name: String(val(`networks.${id}.name`) || id),
            available: val(`networks.${id}.available`),
        }));
        const cameras = C.deviceIds(ids, namespace, 'cameras').map(id => ({
            id,
            name: String(val(`cameras.${id}.name`) || id),
            networkId: val(`cameras.${id}.networkId`),
            available: val(`cameras.${id}.available`),
        }));
        return C.groupCameras(networks, cameras, lang);
    }

    // ------------------------------------------------------------ build

    function render() {
        groups = readGroups();
        const signature = JSON.stringify(groups.map(g => [g.id, g.name, g.cameras.map(c => [c.id, c.name])]));
        if (!groups.some(g => g.id === activeNetwork) && groups.length) {
            activeNetwork = groups[0].id;
        }
        if (signature !== structure) {
            structure = signature;
            build();
        }
        update();
    }

    function build() {
        const tabs = $('tabs');
        const container = $('sections');
        tabs.textContent = '';
        container.textContent = '';
        sections.clear();
        cards.clear();
        $('empty').textContent = C.t(lang, 'noCameras');
        $('empty').classList.toggle('show', groups.length === 0);
        for (const group of groups) {
            tabs.appendChild(createTab(group));
            const section = createSection(group);
            container.appendChild(section.element);
            sections.set(group.id, section);
            for (const camera of group.cameras) {
                const card = createCard(camera);
                section.q('.net-grid').appendChild(card.element);
                cards.set(camera.id, card);
            }
        }
        layout();
    }

    function createTab(group) {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.net = String(group.id);
        tab.setAttribute('role', 'tab');
        tab.tabIndex = 0;
        tab.innerHTML = '<span class="net-dot"></span><span class="tab-name"></span><span class="tab-count"></span>';
        tab.querySelector('.tab-name').textContent = group.name;
        tab.querySelector('.tab-count').textContent = String(group.cameras.length);
        onActivate(tab, () => {
            activeNetwork = group.id;
            remember(TAB_KEY, String(group.id));
            update();
        });
        return tab;
    }

    /**
     * Section of a network: controls and cameras - constant markup only.
     *
     * @param {{id: number, name: string, cameras: Array<{id: number, name: string}>}} group - Network with its cameras
     */
    function createSection(group) {
        const element = document.createElement('section');
        element.className = 'net';
        element.innerHTML = `
      <div class="net-head">
        <div class="head-title">
          <div class="net-title"><span class="net-dot"></span><span class="net-name"></span></div>
          <div class="net-sub"><span class="net-count"></span> · <span class="net-state"></span> <span class="net-result"></span></div>
        </div>
        <div class="head-actions">
          <div class="with-all" role="switch" tabindex="0"><span class="switch"><span class="knob"></span></span><span class="with-all-label"></span></div>
          <div class="head-buttons">
            <div class="btn btn-ghost btn-snap-all" role="button" tabindex="0"></div>
            <div class="btn btn-arm" role="button" tabindex="0"></div>
          </div>
        </div>
      </div>
      <div class="net-grid"></div>`;
        const q = s => element.querySelector(s);
        q('.net-name').textContent = group.name;
        q('.net-count').textContent =
            `${group.cameras.length} ${C.t(lang, group.cameras.length === 1 ? 'camera' : 'cameras')}`;
        q('.with-all-label').textContent = C.t(lang, 'withAll');
        q('.with-all').title = C.t(lang, 'withAllHint');
        q('.btn-snap-all').textContent = C.t(lang, 'snapshotAll');
        q('.btn-snap-all').title = C.t(lang, 'snapshotAllHint');
        onActivate(q('.btn-arm'), () => armPressed(group.id));
        onActivate(q('.with-all'), () =>
            setState(`${namespace}.networks.${group.id}.armWithAll`, val(`networks.${group.id}.armWithAll`) === false),
        );
        onActivate(q('.btn-snap-all'), () => {
            for (const camera of group.cameras) {
                setState(`${namespace}.cameras.${camera.id}.snapshot`, true);
            }
        });
        return { group, element, q };
    }

    /**
     * Card of a camera - constant markup only.
     *
     * @param {{id: number, name: string}} camera - Camera
     */
    function createCard(camera) {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = `
      <div class="cam-img">
        <img alt="" decoding="async">
        <svg class="cam-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h12v10H3z M15 10.5l6-3.5v10l-6-3.5z"/></svg>
        <div class="cam-badges"></div>
        <span class="cam-spinner"></span>
        <span class="cam-result"></span>
        <div class="cam-motion" role="switch" tabindex="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6 M15.8 8.2a5.4 5.4 0 0 1 0 7.6 M5.4 5.4a9.3 9.3 0 0 0 0 13.2 M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/><path class="slash" d="M4 4l16 16"/></svg></div>
      </div>
      <div class="cam-name"></div>
      <div class="cam-foot">
        <span class="cam-age"></span>
        <div class="cam-buttons">
          <div class="btn btn-snap" role="button" tabindex="0"></div>
          <div class="btn btn-live" role="button" tabindex="0"></div>
        </div>
      </div>`;
        const q = s => element.querySelector(s);
        q('.cam-name').textContent = camera.name;
        q('.btn-snap').textContent = C.t(lang, 'snapshot');
        q('.btn-live').textContent = C.t(lang, 'live');
        onActivate(q('.btn-snap'), () => setState(`${namespace}.cameras.${camera.id}.snapshot`, true));
        onActivate(q('.btn-live'), () => startLive(camera));
        onActivate(q('.cam-motion'), () => {
            const base = `cameras.${camera.id}`;
            if (typeof val(`${base}.enabled`) === 'boolean' && val(`${base}.motionPending`) !== true) {
                setState(`${namespace}.${base}.enabled`, val(`${base}.enabled`) === false);
            }
        });
        return { camera, element, q, src: '' };
    }

    // ------------------------------------------------------------ view

    function setView(next) {
        view = next;
        if (!fixedView) {
            remember(VIEW_KEY, next);
        }
        layout();
        update();
    }

    /** Overview: columns so that all bands fit the height of the page */
    function layout() {
        document.body.classList.toggle('view-all', view === 'all');
        const container = $('sections');
        if (view !== 'all') {
            container.style.removeProperty('--cols');
            return;
        }
        const cols = C.fitColumns({
            width: container.clientWidth,
            height: container.clientHeight,
            counts: groups.map(group => group.cameras.length),
            ...OVERVIEW,
        });
        container.style.setProperty('--cols', String(cols));
    }

    // ------------------------------------------------------------ update

    function update() {
        const now = Date.now();
        const toggle = $('view-toggle');
        toggle.classList.toggle('hidden', !!fixedView || groups.length < 2);
        toggle.textContent = C.t(lang, view === 'all' ? 'viewTabs' : 'viewAll');
        $('tabs').classList.toggle('hidden', view === 'all');
        for (const tab of $('tabs').children) {
            const id = Number(tab.dataset.net);
            tab.classList.toggle('active', id === activeNetwork);
            tab.setAttribute('aria-selected', String(id === activeNetwork));
            tab.querySelector('.net-dot').className = `net-dot${val(`networks.${id}.armed`) === true ? ' armed' : ''}`;
        }
        for (const section of sections.values()) {
            section.element.classList.toggle('hidden', view !== 'all' && section.group.id !== activeNetwork);
            updateSection(section);
        }
        for (const card of cards.values()) {
            updateCard(card, now);
        }
        $('cloud').classList.toggle('show', val('info.connection') === false);
        $('cloud').textContent = C.t(lang, 'cloudOffline');
        checkPinDone();
    }

    function updateSection(section) {
        const { q, group } = section;
        const base = `networks.${group.id}`;
        const armed = val(`${base}.armed`) === true;
        const pending = val(`${base}.armPending`) === true;
        section.element.classList.toggle('armed', armed);
        q('.net-dot').className = `net-dot${armed ? ' armed' : ''}`;
        const state = q('.net-state');
        state.textContent = pending ? C.t(lang, 'armPending') : C.t(lang, armed ? 'armed' : 'disarmed');
        state.className = `net-state${armed ? ' armed' : ''}${pending ? ' pending' : ''}`;
        q('.net-result').textContent = C.resultText(lang, 'arm', freshResult(`${base}.armResult`));
        const armButton = q('.btn-arm');
        armButton.textContent = C.t(lang, armed ? 'disarm' : 'arm');
        armButton.className = `btn btn-arm${armed ? ' btn-disarm' : ''}${pending ? ' disabled' : ''}`;
        const selected = val(`${base}.armWithAll`) !== false;
        q('.with-all').classList.toggle('on', selected);
        q('.with-all').setAttribute('aria-checked', String(selected));
    }

    function updateCard(card, now) {
        const base = `cameras.${card.camera.id}`;
        const { q } = card;
        const src = C.imageSrc(namespace, val(`${base}.image`), val(`${base}.imageTime`));
        const img = q('img');
        if (src !== card.src) {
            card.src = src;
            img.classList.remove('loaded');
            if (src) {
                img.onload = () => img.classList.add('loaded');
                img.src = src;
            } else {
                img.removeAttribute('src');
            }
        }
        q('.cam-age').textContent = C.formatAge(lang, val(`${base}.imageTime`), now) || C.t(lang, 'noImage');
        const pending = val(`${base}.snapshotPending`) === true;
        card.element.classList.toggle('pending', pending);
        q('.btn-snap').classList.toggle('disabled', pending);
        const result =
            C.resultText(lang, 'snapshot', freshResult(`${base}.snapshotResult`)) ||
            C.resultText(lang, 'motion', freshResult(`${base}.motionResult`));
        q('.cam-result').textContent = result;
        q('.cam-result').classList.toggle('show', !!result && !pending);
        const enabled = val(`${base}.enabled`);
        const motion = q('.cam-motion');
        motion.classList.toggle('hidden', typeof enabled !== 'boolean');
        motion.classList.toggle('off', enabled === false);
        motion.classList.toggle('pending', val(`${base}.motionPending`) === true);
        motion.setAttribute('aria-checked', String(enabled === true));
        motion.title = C.t(lang, enabled === false ? 'motionOffHint' : 'motionOnHint');
        // the switch shows the motion detection, no extra marker needed
        const badges = C.cameraBadges({
            status: val(`${base}.status`),
            batteryLow: val(`${base}.batteryLow`),
            enabled: undefined,
        });
        card.element.classList.toggle('offline', badges.includes('offline'));
        const box = q('.cam-badges');
        const key = badges.join(',');
        if (box.dataset.key !== key) {
            box.dataset.key = key;
            box.textContent = '';
            for (const badge of badges) {
                const span = document.createElement('span');
                span.className = `badge badge-${badge}`;
                span.textContent = C.t(lang, badge);
                box.appendChild(span);
            }
        }
    }

    // ------------------------------------------------------------ arm / disarm

    function armPressed(networkId) {
        if (val(`networks.${networkId}.armPending`) === true) {
            return;
        }
        if (val(`networks.${networkId}.armed`) !== true) {
            setState(`${namespace}.networks.${networkId}.armed`, true);
        } else if (pin) {
            openPin(networkId);
        } else {
            setState(`${namespace}.networks.${networkId}.armed`, false);
        }
    }

    // ------------------------------------------------------------ PIN

    function openPin(networkId) {
        const group = groups.find(g => g.id === networkId);
        pinNetwork = networkId;
        pinEntry = '';
        $('pin-title').textContent = C.t(lang, 'pinTitle', group ? group.name : String(networkId));
        $('pin-hint').textContent = C.t(lang, 'pinHint');
        $('pin-message').textContent = '';
        renderPin();
        $('pin').classList.add('show');
        // the script learns what the next entry is for
        setState(`${pin.base}.pinZiel`, `kameras:${networkId}`);
    }

    function closePin() {
        pinEntry = '';
        pinNetwork = 0;
        $('pin').classList.remove('show');
    }

    function renderPin() {
        const dots = $('pin-dots');
        dots.textContent = '';
        for (let i = 0; i < pin.digits; i++) {
            const dot = document.createElement('span');
            dot.className = i < pinEntry.length ? 'filled' : '';
            dots.appendChild(dot);
        }
    }

    function pinPress(key) {
        const next = C.pinKey(pinEntry, key, pin.digits);
        pinEntry = next.entry;
        renderPin();
        if (next.complete) {
            const entry = pinEntry;
            pinEntry = '';
            setState(`${pin.base}.pinEingabe`, entry);
            setTimeout(renderPin, 250);
        }
    }

    function showPinMessage(text) {
        if ($('pin').classList.contains('show') && typeof text === 'string' && text) {
            $('pin-message').textContent = text;
        }
    }

    /** accepted: the script has started disarming, the pad can go */
    function checkPinDone() {
        if (pinNetwork && $('pin').classList.contains('show') && val(`networks.${pinNetwork}.armPending`) === true) {
            pinNetwork = 0;
            setTimeout(closePin, 1200);
        }
    }

    function setupPin() {
        if (!pin) {
            return;
        }
        const pad = $('pin-pad');
        for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'close', '0', 'del']) {
            const button = document.createElement('div');
            button.className = `pin-key key-${key}`;
            button.setAttribute('role', 'button');
            button.tabIndex = 0;
            button.textContent = key === 'del' ? '⌫' : key === 'close' ? '✕' : key;
            button.title = key === 'del' ? C.t(lang, 'pinDelete') : key === 'close' ? C.t(lang, 'close') : '';
            onActivate(button, () => (key === 'close' ? closePin() : pinPress(key)));
            pad.appendChild(button);
        }
    }

    // ------------------------------------------------------------ live image

    async function startLive(camera) {
        if (live) {
            return;
        }
        live = { cameraId: camera.id, url: '' };
        $('live-name').textContent = camera.name;
        $('live-status').textContent = C.t(lang, 'liveStarting');
        $('live-img').removeAttribute('src');
        $('live').classList.add('show');
        const access = await sendTo('liveStart', { cameraId: camera.id });
        if (!live || live.cameraId !== camera.id) {
            // closed while starting
            if (access && access.success) {
                sendTo('liveStop', { cameraId: camera.id });
            }
            return;
        }
        if (!access || !access.success) {
            endLive(C.resultText(lang, 'live', access && access.result) || C.t(lang, 'live.failed'));
            return;
        }
        const url = C.liveUrl(window.location, access);
        if (!url) {
            sendTo('liveStop', { cameraId: camera.id });
            endLive(C.t(lang, 'httpsLive'));
            return;
        }
        live.url = url;
        $('live-status').textContent = C.t(lang, 'liveWaiting');
        $('live-img').onload = () => ($('live-status').textContent = '');
        $('live-img').src = url;
    }

    function endLive(text) {
        $('live-img').removeAttribute('src');
        if (live) {
            live.url = '';
        }
        $('live-status').textContent = text ? `${C.t(lang, 'liveEndedTitle')}: ${text}` : C.t(lang, 'liveEndedTitle');
    }

    function closeLive() {
        if (!live) {
            return;
        }
        const { cameraId, url } = live;
        live = null;
        $('live-img').removeAttribute('src');
        $('live').classList.remove('show');
        if (url) {
            sendTo('liveStop', { cameraId });
        }
    }

    // ------------------------------------------------------------ start

    function start() {
        $('live-close').title = C.t(lang, 'close');
        onActivate($('live-close'), closeLive);
        onActivate($('view-toggle'), () => setView(view === 'all' ? 'tabs' : 'all'));
        setupPin();
        layout();
        window.addEventListener('resize', () => {
            layout();
        });
        window.addEventListener('pagehide', closeLive);
        if (!window.io || typeof window.io.connect !== 'function') {
            showBanner('noSocket');
            return;
        }
        socket = window.io.connect('/', { name: 'blink-page' });
        socket.on('connect', load);
        socket.on('reconnect', load);
        socket.on('disconnect', () => showBanner('disconnected'));
        socket.on('stateChange', onStateChange);
        // ages of the images ("vor 5 Min") move on
        setInterval(update, 30_000);
    }

    start();
})();
