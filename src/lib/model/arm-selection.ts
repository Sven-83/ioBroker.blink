/*
 * Which networks "arm selected" switches on. The choice is a setting of the user: it is kept in
 * networks.<id>.armWithAll across restarts and only changes when the user changes it. A network gets
 * true once, when it is first seen. Disarming is never limited by the choice: "disarm all" means all.
 */

/** Relative key of the choice below networks.<id> */
export const SELECTION_KEY = 'armWithAll';
/** Object IDs of the commands for several networks */
export const CONTROL_IDS = { armSelected: 'control.armSelected', disarmAll: 'control.disarmAll' } as const;

/** What the selection needs from the adapter */
export interface SelectionHost {
    /** Stored values of networks.*.armWithAll by network ID */
    readStored(): Promise<Map<number, ioBroker.StateValue>>;
    /** Writes networks.<id>.armWithAll with ack: true */
    write(networkId: number, value: boolean): Promise<unknown>;
    /** Arms or disarms one network (with readback) */
    request(networkId: number, armed: boolean): Promise<void>;
    /** Log message on level info */
    info(message: string): void;
}

/** A network as Blink reports it at the moment */
export interface NetworkState {
    /** Network ID */
    id: number;
    /** Last known state, undefined if unknown */
    armed: boolean | undefined;
}

/** Keeps the choice and runs the commands for several networks */
export class ArmSelection {
    private selected: Map<number, boolean> | undefined;
    private loading: Promise<Map<number, boolean>> | undefined;

    /**
     * @param host - Adapter functions
     */
    public constructor(private readonly host: SelectionHost) {}

    /**
     * Loads the stored choice once and gives networks without a choice the default true.
     *
     * @param networkIds - Networks Blink reports
     */
    public async ensure(networkIds: number[]): Promise<void> {
        const selected = await this.load();
        for (const id of networkIds) {
            if (!selected.has(id)) {
                await this.host.write(id, true);
                selected.set(id, true);
            }
        }
    }

    /**
     * The user changed the choice of a network. Anything but true or false puts the stored choice back.
     *
     * @param networkId - Network ID
     * @param value - Value written by the user
     */
    public async set(networkId: number, value: ioBroker.StateValue): Promise<void> {
        const selected = await this.load();
        const next = typeof value === 'boolean' ? value : (selected.get(networkId) ?? true);
        selected.set(networkId, next);
        await this.host.write(networkId, next);
    }

    /**
     * Network is part of "arm selected". Unknown networks are, like a new network.
     *
     * @param networkId - Network ID
     */
    public isSelected(networkId: number): boolean {
        return this.selected?.get(networkId) !== false;
    }

    /**
     * Networks a command switches. Arming skips networks already armed, disarming skips networks known as
     * disarmed; a network with unknown state gets the command.
     *
     * @param command - armSelected or disarmAll
     * @param networks - Networks Blink reports
     */
    public targets(command: keyof typeof CONTROL_IDS, networks: NetworkState[]): number[] {
        if (command === 'armSelected') {
            return networks
                .filter(network => this.isSelected(network.id) && network.armed !== true)
                .map(network => network.id);
        }
        return networks.filter(network => network.armed !== false).map(network => network.id);
    }

    /**
     * Runs a command for several networks. The networks are switched side by side, each with its own readback.
     *
     * @param command - armSelected or disarmAll
     * @param networks - Networks Blink reports
     */
    public async run(command: keyof typeof CONTROL_IDS, networks: NetworkState[]): Promise<void> {
        await this.load();
        const ids = this.targets(command, networks);
        const armed = command === 'armSelected';
        if (ids.length === 0) {
            this.host.info(armed ? 'Arm selected: no selected network is disarmed' : 'Disarm all: no network is armed');
            return;
        }
        this.host.info(`${armed ? 'Arm selected' : 'Disarm all'}: networks ${ids.join(', ')}`);
        const results = await Promise.allSettled(ids.map(id => this.host.request(id, armed)));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
            throw failed.reason;
        }
    }

    /** Reads the stored choice once; calls during the first read wait for the same read */
    private load(): Promise<Map<number, boolean>> {
        this.loading ??= this.host.readStored().then(stored => {
            const selected = new Map<number, boolean>();
            for (const [id, value] of stored) {
                if (typeof value === 'boolean') {
                    selected.set(id, value);
                }
            }
            this.selected = selected;
            return selected;
        });
        // a failed read is tried again next time
        this.loading.catch(() => (this.loading = undefined));
        return this.loading;
    }
}
