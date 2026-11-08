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
                // armed only becomes writable with the readback of phase 4
                const armed = await harness.objects.getObjectAsync(`${NS}.networks.1001.armed`);
                expect(armed.common.write).to.equal(false);
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
