'use strict';
// Unit tests of arm/disarm: path fallback, error handling, delayed readback (no Blink account needed)
const { expect } = require('chai');
// main.js needs @iobroker/adapter-core, which looks for a js-controller: a minimal stand-in is enough here
require.cache[require.resolve('@iobroker/adapter-core')] = {
    id: 'adapter-core-stub',
    loaded: true,
    exports: { Adapter: class {} },
};
const blink = require('../main.js');

const { BlinkAdapter, armPaths, ARM_READBACK_MS } = blink;

/** stand-in for the adapter: only what setNetworkArmed / scheduleArmReadback use */
function fake(responses) {
    const calls = [];
    const logs = [];
    const log = level => msg => logs.push(`${level}: ${msg}`);
    return {
        calls,
        logs,
        fetches: 0,
        authData: { accountId: 42 },
        armReadbackTimers: [],
        log: { info: log('info'), warn: log('warn'), debug: log('debug') },
        async blinkRequest(method, path) {
            calls.push(`${method} ${path}`);
            const r = responses.shift();
            if (r instanceof Error) throw r;
            return r || {};
        },
        async fetchAllData() {
            this.fetches++;
        },
    };
}
const httpError = status => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const setNetworkArmed = (self, id, arm) => BlinkAdapter.prototype.setNetworkArmed.call(self, id, arm);

describe('arm/disarm', () => {
    it('paths: known path first, newer app path second', () => {
        expect(armPaths(42, 1001, 'arm')).to.deep.equal([
            '/network/1001/arm',
            '/api/v1/accounts/42/networks/1001/state/arm',
        ]);
        expect(armPaths(42, 1, 'disarm')[1]).to.equal('/api/v1/accounts/42/networks/1/state/disarm');
    });

    it('success on the known path: one request, true', async () => {
        const self = fake([{}]);
        expect(await setNetworkArmed(self, 1001, true)).to.equal(true);
        expect(self.calls).to.deep.equal(['post /network/1001/arm']);
        expect(self.logs).to.include('info: Netzwerk 1001 scharf.');
    });

    it('unknown path (404) tries the newer path', async () => {
        const self = fake([httpError(404), {}]);
        expect(await setNetworkArmed(self, 1002, false)).to.equal(true);
        expect(self.calls).to.deep.equal([
            'post /network/1002/disarm',
            'post /api/v1/accounts/42/networks/1002/state/disarm',
        ]);
    });

    it('other errors (e.g. 500, offline) do not try a second path and return false', async () => {
        const self = fake([httpError(500)]);
        expect(await setNetworkArmed(self, 1003, true)).to.equal(false);
        expect(self.calls).to.have.length(1);
        expect(self.logs.some(l => l.startsWith('warn: Arm Fehler 1003'))).to.equal(true);
    });

    it('both paths unknown: false with a warning', async () => {
        const self = fake([httpError(404), httpError(410)]);
        expect(await setNetworkArmed(self, 1, false)).to.equal(false);
        expect(self.calls).to.have.length(2);
        expect(self.logs.some(l => l.startsWith('warn: Disarm Fehler 1'))).to.equal(true);
    });

    it('readback: several commands share one set of timers', async () => {
        const self = fake([]);
        const original = ARM_READBACK_MS.slice();
        ARM_READBACK_MS.splice(0, ARM_READBACK_MS.length, 20, 60);
        try {
            BlinkAdapter.prototype.scheduleArmReadback.call(self);
            BlinkAdapter.prototype.scheduleArmReadback.call(self);
            BlinkAdapter.prototype.scheduleArmReadback.call(self);
            expect(self.armReadbackTimers).to.have.length(2);
            await new Promise(r => setTimeout(r, 120));
            expect(self.fetches).to.equal(2);
        } finally {
            ARM_READBACK_MS.splice(0, ARM_READBACK_MS.length, ...original);
        }
    });
});
