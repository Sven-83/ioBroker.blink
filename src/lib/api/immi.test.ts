import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import {
    IMMI_KEEPALIVE_MS,
    ImmiClient,
    buildAuthPacket,
    buildMessage,
    isCertificateError,
    parseImmiServer,
    type ImmiServer,
} from './immi';

const ADDRESS = 'immis://stream-test.immedia-semi.com:443/TRANS_ACTION__IMDS_SERIAL?client_id=250';
const SERVER: ImmiServer = {
    host: 'stream-test.immedia-semi.com',
    port: 443,
    transaction: 'TRANS_ACTION',
    clientId: 250,
};

class FakeSocket extends EventEmitter {
    public written: Buffer[] = [];
    public destroyed = false;

    public write(data: Buffer): void {
        this.written.push(data);
    }

    public destroy(): void {
        this.destroyed = true;
        this.emit('close');
    }
}

function setup(): {
    client: ImmiClient;
    socket: FakeSocket;
    ready: () => void;
    video: Buffer[];
    closed: (Error | undefined)[];
    timers: { run: () => void; ms: number }[];
} {
    const socket = new FakeSocket();
    const video: Buffer[] = [];
    const closed: (Error | undefined)[] = [];
    const timers: { run: () => void; ms: number }[] = [];
    const result = { socket, video, closed, timers, ready: (): void => undefined };
    const client = new ImmiClient({
        server: SERVER,
        token: 'SECRET',
        serial: 'SERIAL',
        connect: (_host, _port, ready) => {
            result.ready = ready;
            return socket;
        },
        onVideo: chunk => video.push(chunk),
        onClose: err => closed.push(err),
        setTimer: (run, ms) => {
            timers.push({ run, ms });
            return timers.length;
        },
        clearTimer: () => undefined,
    });
    client.open();
    return { client, ...result };
}

describe('api/immi parseImmiServer', () => {
    it('reads an address with underscores in the transaction', () => {
        expect(parseImmiServer(ADDRESS)).to.deep.equal(SERVER);
    });

    it('takes 443 as the default port', () => {
        expect(parseImmiServer('immis://a.immedia-semi.com/T__X?client_id=1')?.port).to.equal(443);
    });

    it('never accepts another host or scheme, as the token goes there', () => {
        for (const address of [
            'immis://evil.example/T__X?client_id=1',
            'immis://immedia-semi.com.evil.example/T__X?client_id=1',
            'immis://evilimmedia-semi.com/T__X?client_id=1',
            'https://a.immedia-semi.com/T__X?client_id=1',
        ]) {
            expect(parseImmiServer(address), address).to.equal(undefined);
        }
    });

    it('refuses incomplete values', () => {
        for (const value of [
            undefined,
            null,
            42,
            '',
            'immis://',
            'immis://a.immedia-semi.com/T__X',
            'immis://a.immedia-semi.com/?client_id=1',
            'immis://a.immedia-semi.com/T__X?client_id=abc',
        ]) {
            expect(parseImmiServer(value), String(value)).to.equal(undefined);
        }
    });
});

describe('api/immi packets', () => {
    it('builds the first packet in the known layout', () => {
        const packet = buildAuthPacket({ ...SERVER, transaction: 'TX', clientId: 250 }, 'TOK', 'SER');
        expect(packet.readUInt32BE(0)).to.equal(0x28);
        expect(packet.readUInt32BE(4)).to.equal(3);
        expect(packet.subarray(8, 11).toString()).to.equal('SER');
        expect(packet.readUInt32BE(11)).to.equal(250);
        expect([...packet.subarray(15, 17)]).to.deep.equal([0x01, 0x08]);
        expect(packet.readUInt32BE(17)).to.equal(3);
        expect(packet.subarray(21, 24).toString()).to.equal('TOK');
        expect(packet.subarray(24, 66).every(byte => byte === 0)).to.equal(true);
        expect(packet.readUInt32BE(66)).to.equal(2);
        expect(packet.subarray(70, 72).toString()).to.equal('TX');
        expect(packet.readUInt32BE(72)).to.equal(1);
        expect(packet).to.have.lengthOf(76);
    });

    it('builds a message', () => {
        const message = buildMessage(0x0a, 7, Buffer.from('ab'));
        expect(message.readUInt8(0)).to.equal(0x0a);
        expect(message.readUInt32BE(1)).to.equal(7);
        expect(message.readUInt32BE(5)).to.equal(2);
        expect(message.subarray(9).toString()).to.equal('ab');
    });
});

describe('api/immi ImmiClient', () => {
    it('sends the token only after the connection is verified', () => {
        const { socket, ready } = setup();
        expect(socket.written).to.deep.equal([]);
        ready();
        expect(Buffer.concat(socket.written).toString('latin1')).to.contain('SECRET');
    });

    it('never sends the token if the connection fails first', () => {
        const { socket, closed } = setup();
        const failure = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        socket.emit('error', failure);
        socket.emit('close');
        expect(socket.written).to.deep.equal([]);
        expect(closed).to.deep.equal([failure]);
    });

    it('passes on video, also when split over several packets', () => {
        const { socket, video } = setup();
        const message = buildMessage(0x00, 1, Buffer.from('video'));
        socket.emit('data', message.subarray(0, 4));
        socket.emit('data', message.subarray(4, 11));
        expect(video).to.deep.equal([]);
        socket.emit('data', Buffer.concat([message.subarray(11), buildMessage(0x00, 2, Buffer.from('more'))]));
        expect(video.map(item => item.toString())).to.deep.equal(['video', 'more']);
    });

    it('answers the control messages of the server', () => {
        const { socket, ready } = setup();
        ready();
        socket.written = [];
        socket.emit('data', buildMessage(0x10, 5));
        socket.emit('data', buildMessage(0x08, 6));
        socket.emit('data', buildMessage(0x06, 7));
        const types = socket.written.map(item => [item.readUInt8(0), item.readUInt32BE(1)]);
        expect(types).to.deep.equal([
            [0x11, 5],
            [0x08, 6],
            [0x0a, 1],
        ]);
    });

    it('ignores messages it does not know', () => {
        const { socket, ready, video } = setup();
        ready();
        socket.written = [];
        socket.emit('data', buildMessage(0x77, 1, Buffer.from('x')));
        expect(socket.written).to.deep.equal([]);
        expect(video).to.deep.equal([]);
    });

    it('sends keepalives in a chain of single timers', () => {
        const { socket, ready, timers } = setup();
        ready();
        expect(timers.at(-1)?.ms).to.equal(IMMI_KEEPALIVE_MS);
        socket.written = [];
        timers.at(-1)?.run();
        expect(socket.written[0].readUInt8(0)).to.equal(0x0a);
    });

    it('sends no keepalive after the end', () => {
        const { client, socket, ready, timers } = setup();
        ready();
        client.close();
        socket.written = [];
        timers.at(-1)?.run();
        expect(socket.written).to.deep.equal([]);
    });

    it('stops when the stream is out of step', () => {
        const { socket, closed } = setup();
        const broken = Buffer.alloc(9);
        broken.writeUInt32BE(0x7fffffff, 5);
        socket.emit('data', broken);
        expect(socket.destroyed).to.equal(true);
        expect(closed[0]?.message).to.contain('out of step');
    });

    it('reports the end once', () => {
        const { client, socket, closed } = setup();
        client.close();
        socket.emit('close');
        expect(closed).to.deep.equal([undefined]);
    });
});

describe('api/immi isCertificateError', () => {
    it('recognises certificate errors', () => {
        for (const code of [
            'DEPTH_ZERO_SELF_SIGNED_CERT',
            'SELF_SIGNED_CERT_IN_CHAIN',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'CERT_HAS_EXPIRED',
            'ERR_TLS_CERT_ALTNAME_INVALID',
        ]) {
            expect(isCertificateError(Object.assign(new Error('x'), { code })), code).to.equal(true);
        }
    });

    it('does not confuse other errors', () => {
        expect(isCertificateError(undefined)).to.equal(false);
        expect(isCertificateError(new Error('x'))).to.equal(false);
        expect(isCertificateError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).to.equal(false);
    });
});
