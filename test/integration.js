const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');
const { startFakeBlink } = require('./lib/fake-blink');

const NS = 'blink.0';
const ENV_KEY = 'BLINK_TEST_ORIGIN';

/**
 * Waits until check() returns a truthy value.
 *
 * @param {() => Promise<unknown> | unknown} check
 * @param {string} what - Shown when the timeout is reached
 * @param {number} [timeoutMs]
 */
async function waitFor(check, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const result = await check();
        if (result) {
            return result;
        }
        if (Date.now() > end) {
            throw new Error(`Timeout waiting for ${what}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

/**
 * sendTo as a promise.
 *
 * @param {any} harness
 * @param {string} command
 * @param {unknown} message
 */
function sendTo(harness, command, message) {
    return new Promise(resolve => harness.sendTo(NS, command, message, resolve));
}

/**
 * Lets the harness start the adapter again: js-controller refuses a start while alive is still true.
 *
 * @param {any} harness
 */
async function markStopped(harness) {
    harness._adapterExit = undefined;
    await harness.states.setState(`system.adapter.${NS}.alive`, { val: false, ack: true });
}

/**
 * Restarts the adapter in the same harness, so states survive like on a real host.
 * The harness allows only one start; _adapterExit is reset after a clean stop (test-only workaround).
 *
 * @param {any} harness
 * @param {Record<string, string>} env
 */
async function restart(harness, env) {
    await harness.stopAdapter();
    await markStopped(harness);
    await harness.startAdapterAndWait(false, env);
}

/**
 * Checks that no secret appears in objects, states or log of the instance.
 *
 * @param {any} harness
 * @param {string[]} secrets
 */
async function expectNoSecrets(harness, secrets) {
    const ids = await harness.dbConnection.getStateIDs(`${NS}.*`);
    const states = await Promise.all(ids.map(id => harness.states.getState(id)));
    const dump = JSON.stringify([ids, states]);
    const log = harness
        .getLogs()
        .map(entry => entry.message)
        .join('\n');
    // counter-checks: the dump and the log really contain the session and the login messages
    expect(dump).to.include('auth.session');
    expect(log).to.include('Logged in to Blink');
    for (const secret of secrets.filter(Boolean)) {
        expect(dump, 'states').not.to.include(secret);
        expect(log, 'log').not.to.include(secret);
    }
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        const stateVal = async (harness, id) => (await harness.states.getState(`${NS}.${id}`))?.val;

        suite('Missing account data', getHarness => {
            let harness;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                await harness.changeAdapterConfig('blink', { native: { email: '', password: '' } });
                await harness.startAdapterAndWait(false);
            });

            it('reports the missing settings and stays disconnected', async function () {
                this.timeout(15_000);
                await waitFor(() => harness.hasLog(/e-mail address and password/, 'error'), 'config error in the log');
                expect(await stateVal(harness, 'info.connection')).to.equal(false);
                expect(await stateVal(harness, 'info.loginState')).to.equal('noConfig');
            });
        });

        suite('Login without 2FA', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '' },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
            });

            after(async () => {
                await cloud?.close();
            });

            it('logs in and stores the session encrypted', async function () {
                this.timeout(20_000);
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'info.connection');
                expect(await stateVal(harness, 'info.loginState')).to.equal('ok');
                const stored = await stateVal(harness, 'auth.session');
                expect(stored).to.be.a('string').and.not.to.equal('');
                // encrypted: neither the token nor the JSON structure is readable
                expect(stored).not.to.include('fake-access').and.not.to.include('accountId');
                expect(cloud.stats.signin).to.equal(1);
            });

            it('restores the session after a restart without a new login', async function () {
                this.timeout(30_000);
                await harness.states.setState(`${NS}.info.connection`, { val: false, ack: true });
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'reconnect');
                expect(cloud.stats.signin).to.equal(1);
            });

            it('logs in again when Blink ended the session', async function () {
                this.timeout(30_000);
                cloud.revokeAll();
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(() => cloud.stats.signin === 2, 'second login');
                await waitFor(async () => (await stateVal(harness, 'info.loginState')) === 'ok', 'ok after login');
            });

            it('keeps password, e-mail address and tokens out of states and log', async () => {
                await expectNoSecrets(harness, [cloud.email, cloud.password, ...cloud.issuedTokens()]);
            });
        });

        suite('Login with 2FA', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink({ twoFactor: 'tsv' });
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '' },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
            });

            after(async () => {
                await cloud?.close();
            });

            it('waits for the code and stores the pending login', async function () {
                this.timeout(20_000);
                await waitFor(
                    async () => (await stateVal(harness, 'info.loginState')) === 'twoFactorRequired',
                    '2FA state',
                );
                expect(harness.hasLog(/sms to \+49\*{6}99/, 'warn')).to.equal(true);
                expect(await stateVal(harness, 'auth.pending')).to.be.a('string').and.not.to.equal('');
                expect(cloud.stats.codesSent).to.equal(1);
            });

            it('does not request a second code after a restart', async function () {
                this.timeout(30_000);
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(() => harness.hasLog(/waiting for the 2FA code/, 'warn'), 'waiting message');
                expect(cloud.stats.signin).to.equal(1);
                expect(cloud.stats.codesSent).to.equal(1);
            });

            it('rejects a wrong code via sendTo and keeps waiting', async function () {
                this.timeout(15_000);
                await harness.enableSendTo();
                const result = await sendTo(harness, 'verifyPin', { pin: '000000' });
                expect(result).to.deep.include({ success: false });
                expect(await stateVal(harness, 'info.loginState')).to.equal('twoFactorRejected');
                expect(await stateVal(harness, 'auth.pending')).to.not.equal('');
            });

            it('accepts the right code via sendTo', async function () {
                this.timeout(15_000);
                const result = await sendTo(harness, 'verifyPin', { pin: cloud.pin });
                expect(result).to.deep.equal({ success: true });
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
                expect(await stateVal(harness, 'auth.pending')).to.equal('');
                expect(cloud.stats.codesSent).to.equal(1);
            });

            it('keeps password, e-mail address and tokens out of states and log', async () => {
                await expectNoSecrets(harness, [cloud.email, cloud.password, cloud.pin, ...cloud.issuedTokens()]);
            });
        });

        suite('2FA code from the settings', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink({ twoFactor: '412' });
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '' },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(
                    async () => (await stateVal(harness, 'info.loginState')) === 'twoFactorRequired',
                    '2FA state',
                );
                await harness.stopAdapter();
            });

            after(async () => {
                await cloud?.close();
            });

            it('uses the code once and removes it from the settings', async function () {
                this.timeout(30_000);
                await harness.changeAdapterConfig('blink', { native: { pin: cloud.pin } });
                await markStopped(harness);
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await harness.getAdapterConfig()).native.pin === '', 'pin removed');
                expect(await stateVal(harness, 'auth.session')).to.not.equal('');
                expect(cloud.stats.codesSent).to.equal(1);
                expect(cloud.stats.verify).to.equal(1);
            });
        });

        suite('Polling', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '', pollInterval: 30 },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
            });

            after(async () => {
                await cloud?.close();
            });

            it('builds the object tree with the values from Blink', async function () {
                this.timeout(20_000);
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
                expect(await stateVal(harness, 'networks.1001.armed')).to.equal(true);
                expect(await stateVal(harness, 'syncModules.2001.status')).to.equal('online');
                expect(await stateVal(harness, 'cameras.3001.kind')).to.equal('camera');
                expect(await stateVal(harness, 'cameras.3001.temperature')).to.equal(20);
                expect(await stateVal(harness, 'cameras.3002.kind')).to.equal('mini');
                expect(await stateVal(harness, 'cameras.3003.kind')).to.equal('doorbell');
                expect(await stateVal(harness, 'cameras.3003.batteryLow')).to.equal(true);
                expect(await stateVal(harness, 'cameras.3003.batteryVoltage')).to.equal(1.48);
                expect(await stateVal(harness, 'info.lastPoll')).to.be.greaterThan(0);

                const object = await harness.objects.getObjectAsync(`${NS}.cameras.3001`);
                expect(object.type).to.equal('device');
                expect(object.common.name).to.equal('Test Camera');
                // a Mini has no battery, so there is no empty state for it
                expect(await harness.objects.getObjectAsync(`${NS}.cameras.3002.batteryLevel`)).to.equal(null);
                const armed = await harness.objects.getObjectAsync(`${NS}.networks.1001.armed`);
                expect(armed.common.write).to.equal(true);
            });

            it('polls again and renews a rejected token without a new login', async function () {
                this.timeout(50_000);
                const before = { ...cloud.stats };
                cloud.config.homescreen.networks[0].armed = false;
                cloud.revokeAccessTokens();
                await waitFor(
                    async () => (await stateVal(harness, 'networks.1001.armed')) === false,
                    'next poll',
                    45_000,
                );
                expect(cloud.stats.refresh).to.equal(before.refresh + 1);
                expect(cloud.stats.signin).to.equal(before.signin);
                expect(cloud.stats.homescreen, 'exactly one poll per cycle').to.equal(before.homescreen + 1);
            });

            it('marks a device Blink no longer reports, without deleting it', async function () {
                this.timeout(30_000);
                cloud.config.homescreen.owls = [];
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(
                    async () => (await stateVal(harness, 'cameras.3002.available')) === false,
                    'device marked',
                );
                expect(await harness.objects.getObjectAsync(`${NS}.cameras.3002`)).to.not.equal(null);
                expect(await stateVal(harness, 'cameras.3001.available')).to.equal(true);
            });

            it('keeps the session and backs off when the API fails', async function () {
                this.timeout(30_000);
                const before = { ...cloud.stats };
                cloud.config.homescreenStatus = 500;
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.loginState')) === 'error', 'error state');
                expect(await stateVal(harness, 'info.connection')).to.equal(false);
                expect(await stateVal(harness, 'auth.session')).to.not.equal('');
                expect(harness.hasLog(/HTTP 500.*Next attempt in 60 s/, 'warn')).to.equal(true);
                expect(cloud.stats.signin).to.equal(before.signin);
            });

            it('waits for the rate limit, also across a restart', async function () {
                this.timeout(40_000);
                cloud.config.homescreenStatus = 429;
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(
                    async () => (await stateVal(harness, 'info.loginState')) === 'rateLimited',
                    'rate limit state',
                );
                expect(await stateVal(harness, 'auth.retryAt')).to.be.greaterThan(Date.now());

                const requests = cloud.stats.homescreenRequests;
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.loginState')) === 'rateLimited', 'still waiting');
                await new Promise(resolve => setTimeout(resolve, 3_000));
                expect(cloud.stats.homescreenRequests).to.equal(requests);
            });

            it('keeps password, e-mail address and tokens out of states and log', async () => {
                await expectNoSecrets(harness, [cloud.email, cloud.password, ...cloud.issuedTokens()]);
            });
        });

        suite('Arm and disarm', getHarness => {
            let harness;
            let cloud;
            const ARMED = `${NS}.networks.1001.armed`;

            const command = val => harness.states.setState(ARMED, { val, ack: false });
            const armedState = () => harness.states.getState(ARMED);
            const waitForResult = (result, timeoutMs) =>
                waitFor(
                    async () =>
                        (await stateVal(harness, 'networks.1001.armPending')) === false &&
                        (await stateVal(harness, 'networks.1001.armResult')) === result,
                    `result ${result}`,
                    timeoutMs,
                );
            const clearResult = () =>
                harness.states.setState(`${NS}.networks.1001.armResult`, { val: '', ack: true });

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '', pollInterval: 3600 },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
            });

            after(async () => {
                await cloud?.close();
            });

            it('starts without a running command', async () => {
                expect(await stateVal(harness, 'networks.1001.armPending')).to.equal(false);
                expect((await armedState()).val).to.equal(true);
                expect((await armedState()).ack).to.equal(true);
            });

            it('disarms: pending at once, ack only with the state read back', async function () {
                this.timeout(20_000);
                cloud.config.armDelayMs = 2_500;
                await command(false);
                await waitFor(
                    async () => (await stateVal(harness, 'networks.1001.armPending')) === true,
                    'pending',
                    1_000,
                );
                expect((await armedState()).ack, 'no ack while Blink has not confirmed').to.equal(false);

                await waitForResult('confirmed', 15_000);
                expect((await armedState()).val).to.equal(false);
                expect((await armedState()).ack).to.equal(true);
                expect(cloud.stats.armNew).to.equal(1);
                expect(cloud.stats.commandStatus).to.be.greaterThan(0);
                cloud.config.armDelayMs = 0;
            });

            it('arms again over the older path if the current one is unknown', async function () {
                this.timeout(20_000);
                await clearResult();
                cloud.config.armNewPathStatus = 404;
                const before = cloud.stats.armOld;
                await command(true);
                await waitForResult('confirmed', 15_000);
                expect(cloud.stats.armOld).to.equal(before + 1);
                expect((await armedState()).val).to.equal(true);
                cloud.config.armNewPathStatus = 200;
            });

            it('jumps back to the real state when Blink refuses', async function () {
                this.timeout(20_000);
                await clearResult();
                cloud.config.armNewPathStatus = 500;
                await command(false);
                await waitForResult('rejected', 15_000);
                const state = await armedState();
                expect(state.val, 'still armed at Blink').to.equal(true);
                expect(state.ack).to.equal(true);
                cloud.config.armNewPathStatus = 200;
            });

            it('jumps back when Blink accepts the command but nothing happens', async function () {
                this.timeout(40_000);
                await clearResult();
                cloud.config.armIgnored = true;
                await command(false);
                await waitForResult('unconfirmed', 35_000);
                const state = await armedState();
                expect(state.val).to.equal(true);
                expect(state.ack).to.equal(true);
                expect(harness.hasLog(/has not confirmed/, 'warn')).to.equal(true);
                cloud.config.armIgnored = false;
            });

            it('sends a command after the token was rejected, without a new login', async function () {
                this.timeout(20_000);
                await clearResult();
                const signin = cloud.stats.signin;
                const refresh = cloud.stats.refresh;
                cloud.revokeAccessTokens();
                await command(false);
                await waitForResult('confirmed', 15_000);
                expect(cloud.stats.signin).to.equal(signin);
                expect(cloud.stats.refresh).to.equal(refresh + 1);
                expect((await armedState()).val).to.equal(false);
            });

            it('ignores values with ack: true', async function () {
                this.timeout(10_000);
                const before = cloud.stats.armNew;
                await harness.states.setState(ARMED, { val: true, ack: true });
                await new Promise(resolve => setTimeout(resolve, 1_500));
                expect(cloud.stats.armNew).to.equal(before);
            });

            it('keeps password, e-mail address and tokens out of states and log', async () => {
                await expectNoSecrets(harness, [cloud.email, cloud.password, ...cloud.issuedTokens()]);
            });
        });

        suite('Arm selected networks', getHarness => {
            let harness;
            let cloud;
            const press = id => harness.states.setState(`${NS}.control.${id}`, { val: true, ack: false });
            const done = async (net, armed) =>
                (await stateVal(harness, `networks.${net}.armPending`)) === false &&
                (await stateVal(harness, `networks.${net}.armed`)) === armed;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                cloud.config.homescreen.networks.push({ id: 1002, name: 'Test Garden', armed: false });
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '', pollInterval: 3600 },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
            });

            after(async () => {
                await cloud?.close();
            });

            it('selects every new network and offers the two buttons', async function () {
                this.timeout(10_000);
                await waitFor(
                    async () => (await stateVal(harness, 'networks.1002.armWithAll')) === true,
                    'default choice',
                );
                expect((await harness.states.getState(`${NS}.networks.1001.armWithAll`)).ack).to.equal(true);
                const button = await harness.objects.getObjectAsync(`${NS}.control.armSelected`);
                expect(button.common.role).to.equal('button');
                expect(button.common.write).to.equal(true);
            });

            it('keeps a changed choice', async function () {
                this.timeout(10_000);
                await harness.states.setState(`${NS}.networks.1002.armWithAll`, { val: false, ack: false });
                await waitFor(async () => {
                    const state = await harness.states.getState(`${NS}.networks.1002.armWithAll`);
                    return state?.val === false && state.ack === true;
                }, 'choice confirmed');
            });

            it('disarms every armed network', async function () {
                this.timeout(20_000);
                const before = cloud.stats.armNew;
                await press('disarmAll');
                await waitFor(() => done(1001, false), 'network 1001 disarmed', 15_000);
                // 1002 was disarmed already: no command for it
                expect(cloud.stats.armNew).to.equal(before + 1);
            });

            it('arms only the selected networks', async function () {
                this.timeout(20_000);
                const before = cloud.stats.armNew;
                await press('armSelected');
                await waitFor(() => done(1001, true), 'network 1001 armed', 15_000);
                expect(await stateVal(harness, 'networks.1002.armed')).to.equal(false);
                expect(cloud.stats.armNew).to.equal(before + 1);
            });

            it('switches the motion detection of a camera, ack only with the state read back', async function () {
                this.timeout(20_000);
                const ENABLED = `${NS}.cameras.3001.enabled`;
                expect(await stateVal(harness, 'cameras.3001.enabled')).to.equal(true);
                const object = await harness.objects.getObjectAsync(ENABLED);
                expect(object.common.write).to.equal(true);
                await harness.states.setState(ENABLED, { val: false, ack: false });
                await waitFor(
                    async () =>
                        (await stateVal(harness, 'cameras.3001.motionPending')) === false &&
                        (await stateVal(harness, 'cameras.3001.motionResult')) === 'confirmed',
                    'motion detection confirmed',
                    15_000,
                );
                const state = await harness.states.getState(ENABLED);
                expect(state.val).to.equal(false);
                expect(state.ack).to.equal(true);
                expect(cloud.stats.motion).to.equal(1);
            });

            it('still has the choice after a restart', async function () {
                this.timeout(60_000);
                await harness.states.setState(`${NS}.info.lastPoll`, { val: 0, ack: true });
                await restart(harness, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.lastPoll')) > 0, 'polled after restart');
                expect(await stateVal(harness, 'networks.1002.armWithAll')).to.equal(false);
                expect(await stateVal(harness, 'networks.1001.armWithAll')).to.equal(true);
            });
        });

        suite('Snapshots', getHarness => {
            let harness;
            let cloud;
            const CAM = 'cameras.3001';
            const FILE = 'cameras/3001.jpg';

            const press = id => harness.states.setState(`${NS}.${id}.snapshot`, { val: true, ack: false });
            const waitForResult = (id, result, timeoutMs = 15_000) =>
                waitFor(
                    async () =>
                        (await stateVal(harness, `${id}.snapshotPending`)) === false &&
                        (await stateVal(harness, `${id}.snapshotResult`)) === result,
                    `snapshot result ${result}`,
                    timeoutMs,
                );
            const readImage = async () => Buffer.from((await harness.objects.readFile(NS, FILE)).file);

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: cloud.password, pin: '', pollInterval: 3600 },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, `${CAM}.image`))?.length > 0, 'first image');
            });

            after(async () => {
                await cloud?.close();
            });

            it('creates the file storage itself, also for an instance that already exists', async () => {
                const meta = await harness.objects.getObjectAsync(NS);
                expect(meta.type).to.equal('meta');
                expect(meta.common.type).to.equal('meta.user');
            });

            it('fetches the last images without waking a camera', async function () {
                this.timeout(20_000);
                await waitFor(async () => (await stateVal(harness, 'cameras.3002.image'))?.length > 0, 'image of the Mini');
                expect(await stateVal(harness, `${CAM}.image`)).to.match(/^\/blink\.0\/cameras\/3001\.jpg\?t=\d+$/);
                expect(await stateVal(harness, `${CAM}.imageTime`)).to.equal(1_700_000_000_000);
                expect(await stateVal(harness, 'cameras.3002.imageTime'), 'no time in the address').to.equal(0);
                expect((await readImage()).toString('latin1')).to.include('fake-3001-1');
                expect(cloud.stats.snapshot).to.equal(0);
            });

            it('takes a new image: pending at once, new address and file', async function () {
                this.timeout(20_000);
                const before = await stateVal(harness, `${CAM}.image`);
                cloud.config.snapshotDelayMs = 1_500;
                await press(CAM);
                await waitFor(async () => (await stateVal(harness, `${CAM}.snapshotPending`)) === true, 'pending', 1_000);

                await waitForResult(CAM, 'confirmed');
                expect(await stateVal(harness, `${CAM}.image`)).to.not.equal(before);
                expect((await readImage()).toString('latin1')).to.include('fake-3001-2');
                expect(await stateVal(harness, `${CAM}.imageTime`)).to.be.greaterThan(Date.now() - 60_000);
                expect(cloud.stats.snapshot).to.equal(1);
                cloud.config.snapshotDelayMs = 0;
            });

            it('confirms the button with ack: true', async () => {
                expect((await harness.states.getState(`${NS}.${CAM}.snapshot`)).ack).to.equal(true);
            });

            it('spares the battery right after a new image', async function () {
                this.timeout(10_000);
                await press(CAM);
                await waitForResult(CAM, 'throttled', 5_000);
                expect(cloud.stats.snapshot).to.equal(1);
            });

            it('keeps the old image when only the address changes', async function () {
                this.timeout(40_000);
                cloud.config.snapshotSameContent = true;
                const id = 'cameras.3003';
                await waitFor(async () => (await stateVal(harness, `${id}.image`))?.length > 0, 'first image');
                const time = await stateVal(harness, `${id}.imageTime`);
                await press(id);
                await waitForResult(id, 'unconfirmed', 35_000);
                expect(await stateVal(harness, `${id}.imageTime`)).to.equal(time);
                cloud.config.snapshotSameContent = false;
            });

            it('does not wake an offline camera', async function () {
                this.timeout(15_000);
                const device = cloud.config.homescreen.owls[0];
                device.status = 'offline';
                const before = cloud.stats.snapshot;
                await press('cameras.3002');
                await waitForResult('cameras.3002', 'offline');
                expect(cloud.stats.snapshot).to.equal(before);
                device.status = 'online';
            });

            it('reports a failed command', async function () {
                this.timeout(15_000);
                cloud.config.snapshotCommandFails = true;
                await press('cameras.3002');
                await waitForResult('cameras.3002', 'rejected');
                cloud.config.snapshotCommandFails = false;
            });

            it('asks a Mini over its own path', async function () {
                this.timeout(15_000);
                const paths = () =>
                    cloud.requests.filter(item => item.method === 'POST' && /thumbnail$/.test(item.path)).map(item => item.path);
                await press('cameras.3002');
                await waitForResult('cameras.3002', 'confirmed');
                expect(paths().pop()).to.match(/\/networks\/1001\/owls\/3002\/thumbnail$/);
            });

            it('keeps the address at Blink, password, e-mail address and tokens out of states and log', async () => {
                await expectNoSecrets(harness, [cloud.email, cloud.password, '/media/', ...cloud.issuedTokens()]);
            });
        });

        suite('Live image', getHarness => {
            let harness;
            let cloud;

            const start = cameraId => sendTo(harness, 'liveStart', { cameraId });

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: {
                        email: cloud.email,
                        password: cloud.password,
                        pin: '',
                        pollInterval: 3600,
                        liveEnabled: false,
                        ffmpegPath: 'not-allowed-program',
                    },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await harness.enableSendTo();
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
            });

            after(async () => {
                await cloud?.close();
            });

            it('is switched off by default and does not wake a camera', async function () {
                this.timeout(15_000);
                const answer = await start(3001);
                expect(answer).to.deep.equal({ success: false, result: 'disabled' });
                expect(await stateVal(harness, 'cameras.3001.liveResult')).to.equal('disabled');
                expect(await stateVal(harness, 'cameras.3001.liveActive')).to.equal(false);
                expect(cloud.stats.liveStart).to.equal(0);
            });

            it('does not wake a camera if ffmpeg is not available', async function () {
                this.timeout(30_000);
                await harness.stopAdapter();
                await harness.changeAdapterConfig('blink', { native: { liveEnabled: true } });
                // otherwise the wait below would see the value of the last run
                await harness.states.setState(`${NS}.info.connection`, { val: false, ack: true });
                await markStopped(harness);
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
                await waitFor(async () => (await stateVal(harness, 'info.connection')) === true, 'connected');
                const answer = await start(3001);
                expect(answer).to.deep.equal({ success: false, result: 'noFfmpeg' });
                expect(cloud.stats.liveStart).to.equal(0);
                expect(harness.hasLog(/ffmpeg not found/, 'warn')).to.equal(true);
            });

            it('refuses a message without a valid camera', async function () {
                this.timeout(10_000);
                expect(await start('x')).to.deep.equal({ success: false, result: 'rejected' });
                expect(await start(99_999)).to.deep.equal({ success: false, result: 'rejected' });
            });

            it('ignores a stop for a camera without a live image', async function () {
                this.timeout(10_000);
                expect(await sendTo(harness, 'liveStop', { cameraId: 3001 })).to.deep.equal({ success: true });
            });
        });

        suite('Wrong password', getHarness => {
            let harness;
            let cloud;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                cloud = await startFakeBlink();
                await harness.changeAdapterConfig('blink', {
                    native: { email: cloud.email, password: 'wrong', pin: '' },
                });
                await harness.startAdapterAndWait(false, { [ENV_KEY]: cloud.origin });
            });

            after(async () => {
                await cloud?.close();
            });

            it('stops after the first rejected login', async function () {
                this.timeout(20_000);
                await waitFor(
                    async () => (await stateVal(harness, 'info.loginState')) === 'credentialsRejected',
                    'rejected state',
                );
                await new Promise(resolve => setTimeout(resolve, 3_000));
                expect(cloud.stats.signin).to.equal(1);
                expect(await stateVal(harness, 'info.connection')).to.equal(false);
            });
        });
    },
});
