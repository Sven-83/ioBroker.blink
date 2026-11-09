/*
 * Client of the IMMI protocol of the Blink stream servers (immis://). Blink has no documentation for it:
 * the packets are known from community clients (Pischleuder1/ioBroker.blink, MIT, lib/immi-live-hls.js).
 *
 * Differences to that source: the certificate of the server is checked by the caller's connect function, and
 * the stream token is only sent after a verified connection.
 */

/** Answers longer than this are not IMMI: the stream is out of step */
const MAX_PAYLOAD = 10 * 1024 * 1024;
/** Time between two keepalive messages */
export const IMMI_KEEPALIVE_MS = 10_000;
/** Header of a message: type, message ID, length of the payload */
const HEADER_BYTES = 9;
const AUTH_MAGIC = 0x28;

const TYPE_VIDEO = 0x00;
const TYPE_PING = 0x06;
const TYPE_ECHO = 0x08;
const TYPE_KEEPALIVE = 0x0a;
const TYPE_ROUNDTRIP = 0x10;
const TYPE_ROUNDTRIP_ACK = 0x11;

/** The token only goes to stream servers of the Blink cloud */
const BLINK_HOST = /(^|\.)immedia-semi\.com$/;

/** Parts of an immis:// address */
export interface ImmiServer {
    /** Host name */
    host: string;
    /** TCP port */
    port: number;
    /** Transaction of the stream */
    transaction: string;
    /** Client ID, not the same as the device ID */
    clientId: number;
}

/** The connection the client needs */
export interface ImmiSocket {
    /** Sends bytes */
    write(data: Buffer): unknown;
    /** Closes the connection */
    destroy(): unknown;
    /** Registers an event handler */
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    /** Registers an event handler */
    on(event: 'error', listener: (err: Error) => void): unknown;
    /** Registers an event handler */
    on(event: 'close', listener: () => void): unknown;
}

/**
 * Splits an immis:// address.
 *
 * @param uri - Value of the field "server" of the answer of Blink
 * @returns The parts, undefined if this is no address of a Blink stream server
 */
export function parseImmiServer(uri: unknown): ImmiServer | undefined {
    if (typeof uri !== 'string' || !/^immis:\/\//i.test(uri)) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return undefined;
    }
    const transaction = decodeURIComponent(url.pathname.replace(/^\/+/, '')).split('__')[0];
    const clientId = Number(url.searchParams.get('client_id'));
    if (!BLINK_HOST.test(url.hostname) || !transaction || !Number.isInteger(clientId) || clientId <= 0) {
        return undefined;
    }
    return { host: url.hostname, port: Number(url.port) || 443, transaction, clientId };
}

function u32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
}

/**
 * First packet of a connection.
 *
 * @param server - Address of the stream
 * @param token - Stream token
 * @param serial - Serial number of the device
 */
export function buildAuthPacket(server: ImmiServer, token: string, serial: string): Buffer {
    const tokenBytes = Buffer.from(token, 'utf8');
    const transaction = Buffer.from(server.transaction, 'utf8');
    const serialBytes = Buffer.from(serial, 'utf8');
    return Buffer.concat([
        u32(AUTH_MAGIC),
        u32(serialBytes.length),
        serialBytes,
        u32(server.clientId),
        Buffer.from([0x01, 0x08]),
        u32(tokenBytes.length),
        tokenBytes,
        Buffer.alloc(42),
        u32(transaction.length),
        transaction,
        u32(1),
    ]);
}

/**
 * Message of the protocol.
 *
 * @param type - Message type
 * @param id - Message ID
 * @param payload - Content
 */
export function buildMessage(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from([type & 0xff]), u32(id), u32(payload.length), payload]);
}

/** Options of the client */
export interface ImmiOptions {
    /** Address of the stream */
    server: ImmiServer;
    /** Stream token */
    token: string;
    /** Serial number of the device */
    serial: string;
    /** Opens the connection and calls ready once it is verified */
    connect: (host: string, port: number, ready: () => void) => ImmiSocket;
    /** Receives the MPEG-TS data */
    onVideo: (chunk: Buffer) => void;
    /** Connection ended, with the error if there was one. Called once */
    onClose: (err?: Error) => void;
    /** Starts a timer */
    setTimer: (run: () => void, ms: number) => unknown;
    /** Stops a timer */
    clearTimer: (timer: unknown) => void;
}

/** One connection to a stream server */
export class ImmiClient {
    private socket: ImmiSocket | undefined;
    private buffer: Buffer = Buffer.alloc(0);
    private keepalive: unknown;
    private keepaliveId = 0;
    private closed = false;
    private error: Error | undefined;

    /**
     * @param options - Client options
     */
    public constructor(private readonly options: ImmiOptions) {}

    /** Connects. The token is sent when the connection is verified, not before */
    public open(): void {
        const { server, token, serial, connect } = this.options;
        const socket = connect(server.host, server.port, () => {
            socket.write(buildAuthPacket(server, token, serial));
            this.sendKeepalive();
        });
        this.socket = socket;
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', err => {
            this.error ??= err;
        });
        socket.on('close', () => this.finish());
    }

    /** Ends the connection */
    public close(): void {
        this.socket?.destroy();
        this.finish();
    }

    private finish(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.options.clearTimer(this.keepalive);
        this.options.onClose(this.error);
    }

    private sendKeepalive(): void {
        if (this.closed) {
            return;
        }
        this.socket?.write(buildMessage(TYPE_KEEPALIVE, this.keepaliveId++));
        this.options.clearTimer(this.keepalive);
        this.keepalive = this.options.setTimer(() => this.sendKeepalive(), IMMI_KEEPALIVE_MS);
    }

    private receive(chunk: Buffer): void {
        this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length >= HEADER_BYTES) {
            const length = this.buffer.readUInt32BE(5);
            if (length > MAX_PAYLOAD) {
                this.error ??= new Error('Blink stream is out of step');
                this.close();
                return;
            }
            if (this.buffer.length < HEADER_BYTES + length) {
                return;
            }
            const type = this.buffer.readUInt8(0);
            const id = this.buffer.readUInt32BE(1);
            const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
            this.buffer = this.buffer.subarray(HEADER_BYTES + length);
            this.handle(type, id, payload);
        }
    }

    private handle(type: number, id: number, payload: Buffer): void {
        if (type === TYPE_VIDEO) {
            this.options.onVideo(payload);
        } else if (type === TYPE_PING) {
            this.sendKeepalive();
        } else if (type === TYPE_ECHO) {
            this.socket?.write(buildMessage(TYPE_ECHO, id));
        } else if (type === TYPE_ROUNDTRIP) {
            this.socket?.write(buildMessage(TYPE_ROUNDTRIP_ACK, id));
        }
    }
}

/**
 * The certificate of the server was not accepted.
 *
 * @param err - Error of the connection
 */
export function isCertificateError(err: Error | undefined): boolean {
    const code = err && 'code' in err ? err.code : undefined;
    return typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME/.test(code);
}
