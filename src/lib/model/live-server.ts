/*
 * HTTP server of the live image (audit B.10.20): only runs during a live session, only serves the image of this
 * session, only with the random token of this session, and sends no CORS header. It is not a proxy: there is no
 * address a viewer could choose.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const BOUNDARY = 'blinklive';
/** Most viewers of a session */
export const LIVE_MAX_CLIENTS = 4;

/** Where the server listens */
export interface ListenOptions {
    /** Address */
    host: string;
    /** TCP port, 0 for any */
    port: number;
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest();
}

/** The image of one session for its viewers */
export class LiveServer {
    private server: Server | undefined;
    private readonly clients = new Set<ServerResponse>();
    private readonly sockets = new Set<Socket>();
    private lastFrame: Buffer | undefined;
    private cameraId = 0;
    private token = '';

    /**
     * @param onClients - Number of viewers has changed
     */
    public constructor(private readonly onClients: (count: number) => void) {}

    /**
     * Starts the server for a session.
     *
     * @param options - Where to listen
     * @param cameraId - Camera of the session
     * @param token - Token of the session
     * @returns The TCP port
     */
    public async start(options: ListenOptions, cameraId: number, token: string): Promise<number> {
        this.cameraId = cameraId;
        this.token = token;
        this.lastFrame = undefined;
        const server = createServer((request, response) => this.handle(request, response));
        server.on('connection', socket => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(options.port, options.host, () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        this.server = server;
        return (server.address() as { port: number }).port;
    }

    /** Ends the session: all viewers are disconnected and the token is gone */
    public async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.token = '';
        this.lastFrame = undefined;
        for (const client of this.clients) {
            client.end();
        }
        this.clients.clear();
        for (const socket of this.sockets) {
            socket.destroy();
        }
        this.sockets.clear();
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }

    /**
     * Sends an image. A viewer that cannot keep up misses images instead of falling behind.
     *
     * @param frame - JPEG file
     */
    public broadcast(frame: Buffer): void {
        this.lastFrame = frame;
        for (const client of this.clients) {
            if (!client.writableNeedDrain) {
                this.send(client, frame);
            }
        }
    }

    private send(client: ServerResponse, frame: Buffer): void {
        client.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        client.write(frame);
        client.write('\r\n');
    }

    private refuse(response: ServerResponse, status: number): void {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end();
    }

    private handle(request: IncomingMessage, response: ServerResponse): void {
        const url = new URL(request.url ?? '/', 'http://live.invalid');
        if (request.method !== 'GET' || url.pathname !== `/live/${this.cameraId}.mjpeg`) {
            this.refuse(response, 404);
            return;
        }
        const token = url.searchParams.get('token') ?? '';
        if (!this.token || !timingSafeEqual(digest(token), digest(this.token))) {
            this.refuse(response, 401);
            return;
        }
        if (this.clients.size >= LIVE_MAX_CLIENTS) {
            this.refuse(response, 503);
            return;
        }
        response.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-store',
            Connection: 'close',
        });
        // the first image can take seconds: the viewer should know right away that it is connected
        response.flushHeaders();
        this.clients.add(response);
        this.onClients(this.clients.size);
        if (this.lastFrame) {
            this.send(response, this.lastFrame);
        }
        response.on('close', () => {
            if (this.clients.delete(response)) {
                this.onClients(this.clients.size);
            }
        });
    }
}
