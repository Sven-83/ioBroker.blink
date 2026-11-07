/*
 * ioBroker.blink
 * Adapter lifecycle only - Blink API in lib/api, object tree in lib/model, helpers in lib/util.
 *
 * Phase 1 (scaffold): validates the config and stays disconnected. Login follows in phase 2.
 */

import * as utils from '@iobroker/adapter-core';
import { normalizeEmail, pollIntervalSeconds } from './lib/util/config';

class Blink extends utils.Adapter {
    private pollSeconds = 0;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'blink',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const email = normalizeEmail(this.config.email);
        if (!email || !this.config.password) {
            this.log.error(
                'Please enter the e-mail address and password of your Blink account in the instance settings.',
            );
            return;
        }
        this.pollSeconds = pollIntervalSeconds(this.config.pollInterval);
        this.log.info(
            `Configuration is valid (polling every ${this.pollSeconds} s). The cloud connection is not implemented yet.`,
        );
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Blink(options);
} else {
    // otherwise start the instance directly
    (() => new Blink())();
}
