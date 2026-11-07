const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

const NS = 'blink.0';

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

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
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
                expect((await harness.states.getState(`${NS}.info.connection`))?.val).to.equal(false);
            });
        });
    },
});
