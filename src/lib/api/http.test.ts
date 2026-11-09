import { expect } from 'chai';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, describeResponse } from './http';

const URL_OF_COMMAND = 'https://rest-test.example/network/12345/command/678';

describe('api/http describeResponse', () => {
    it('shows field names without their values', () => {
        const line = describeResponse(
            'GET',
            'https://rest-test.example/api/v3/accounts/12345/homescreen',
            200,
            42,
            JSON.stringify({
                networks: [{ id: 111222, name: 'Secret network', armed: true }],
                cameras: [{ serial: 'SERIAL-SECRET', signals: { temp: 21 } }],
            }),
        );
        expect(line).to.equal(
            'GET /api/v3/accounts/:id/homescreen -> 200 in 42 ms, fields: networks[].id networks[].name ' +
                'networks[].armed cameras[].serial cameras[].signals.temp',
        );
    });

    it('keeps tokens and addresses out', () => {
        const line = describeResponse(
            'POST',
            'https://oauth.example/oauth/token?code=SECRET-CODE',
            200,
            1,
            JSON.stringify({ access_token: 'SECRET-TOKEN', email: 'someone@example.com' }),
        );
        expect(line).to.contain('fields: access_token email');
        expect(line).to.not.match(/SECRET|someone|example\.com/);
    });

    it('hides field names that could be data', () => {
        const line = describeResponse(
            'GET',
            URL_OF_COMMAND,
            200,
            1,
            JSON.stringify({ 12345: { name: 'x' }, 'someone@example.com': 1 }),
        );
        expect(line).to.contain('fields: *.name *');
        expect(line).to.not.match(/12345|someone/);
    });

    it('shows the status values of a command, only as number or boolean', () => {
        expect(
            describeResponse(
                'GET',
                URL_OF_COMMAND,
                200,
                1,
                JSON.stringify({ complete: true, status: 5, status_code: 908 }),
            ),
        ).to.match(/, values: complete=true status=5 status_code=908$/);
        expect(describeResponse('GET', URL_OF_COMMAND, 200, 1, JSON.stringify({ status: 'SECRET' }))).to.not.contain(
            'SECRET',
        );
    });

    it('copes with an answer that is not JSON', () => {
        expect(describeResponse('GET', URL_OF_COMMAND, 500, 1, '<html>SECRET</html>')).to.equal(
            'GET /network/:id/command/:id -> 500 in 1 ms, fields: -',
        );
    });

    it('limits the number of field names', () => {
        const big = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`field${index}`, index]));
        const fields = describeResponse('GET', URL_OF_COMMAND, 200, 1, JSON.stringify(big)).split('fields: ')[1];
        expect(fields.split(' ')).to.have.lengthOf(300);
    });
});

describe('api/http HttpClient certificate checks', () => {
    const name = 'NODE_TLS_REJECT_UNAUTHORIZED';
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env[name];
        process.env[name] = '0';
    });

    afterEach(() => {
        if (saved === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = saved;
        }
    });

    it('sends nothing to Blink while they are switched off', async () => {
        let error: unknown;
        try {
            await new HttpClient().request('https://127.0.0.1:1/never');
        } catch (err) {
            error = err;
        }
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.contain('TLS certificate checks');
    });
});

describe('api/http HttpClient trace', () => {
    let server: Server;
    let origin: string;

    before(done => {
        server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ access_token: 'SECRET-TOKEN' }));
        });
        server.listen(0, '127.0.0.1', () => {
            origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            done();
        });
    });

    after(done => {
        server.close(() => done());
    });

    it('reports each response and leaves the answer untouched', async () => {
        const lines: string[] = [];
        const http = new HttpClient({ testOrigin: origin, trace: line => lines.push(line) });
        const response = await http.request('https://oauth.example/oauth/token', {
            method: 'POST',
            form: { password: 'SECRET-PASSWORD' },
        });
        expect(response.body).to.contain('SECRET-TOKEN');
        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.match(/^POST \/oauth\/token -> 200 in \d+ ms, fields: access_token$/);
    });
});
