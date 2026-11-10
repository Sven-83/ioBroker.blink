/*
 * Tests for the logic of the camera page (www/js/core.js).
 */

import { expect } from 'chai';
import type * as Core from '../www/js/core.js';
import { fileName } from './lib/model/image-store';

// plain browser script with a CommonJS fallback
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the page core is a plain browser script, loaded via require
const core = require('../www/js/core.js') as typeof Core;

const NS = 'blink.0';

describe('camera page core', () => {
    it('uses German only for a German system and fills in values', () => {
        expect(core.pickLanguage('de')).to.equal('de');
        expect(core.pickLanguage('fr')).to.equal('en');
        expect(core.t('de', 'minutesAgo', 5)).to.equal('vor 5 Min');
        expect(core.t('de', 'pinTitle', 'Test Home')).to.equal('Test Home unscharf schalten');
        expect(core.t('de', 'unknownKey')).to.equal('unknownKey');
    });

    it('has the same text keys in both languages', () => {
        expect(Object.keys(core.TEXTS.de).sort()).to.deep.equal(Object.keys(core.TEXTS.en).sort());
    });

    it('has a text for every result the adapter writes', () => {
        for (const result of ['confirmed', 'unconfirmed', 'rejected', 'busy', 'offline', 'throttled']) {
            expect(core.resultText('de', 'snapshot', result)).to.not.equal('');
        }
        for (const result of ['running', 'ended', 'idle', 'failed', 'certificate', 'noFfmpeg', 'busy', 'rejected']) {
            expect(core.resultText('en', 'live', result)).to.not.equal('');
        }
        expect(core.resultText('de', 'arm', '')).to.equal('');
        expect(core.resultText('de', 'arm', 'whatever')).to.equal('');
        expect(core.resultText('de', 'arm', null)).to.equal('');
    });

    it('reads instance and PIN settings from the address', () => {
        expect(core.instanceFromSearch('?instance=2')).to.equal(2);
        expect(core.instanceFromSearch('')).to.equal(0);
        expect(core.pinFromSearch('?pin=0_userdata.0.vis.sicherheit')).to.deep.equal({
            base: '0_userdata.0.vis.sicherheit',
            digits: 4,
        });
        expect(core.pinFromSearch('?pin=javascript.0.pin&pinDigits=6')).to.deep.equal({
            base: 'javascript.0.pin',
            digits: 6,
        });
        expect(core.pinFromSearch('?pin=0_userdata.0.x&pinDigits=99')?.digits).to.equal(4);
        // states of an adapter or anything odd are not accepted
        expect(core.pinFromSearch('?pin=blink.0.networks')).to.equal(null);
        expect(core.pinFromSearch('?pin=0_userdata.0.a b')).to.equal(null);
        expect(core.pinFromSearch('')).to.equal(null);
    });

    it('builds the PIN entry key by key', () => {
        expect(core.pinKey('', '1', 4)).to.deep.equal({ entry: '1', complete: false });
        expect(core.pinKey('123', '4', 4)).to.deep.equal({ entry: '1234', complete: true });
        expect(core.pinKey('12', 'del', 4)).to.deep.equal({ entry: '1', complete: false });
        expect(core.pinKey('12', 'x', 4)).to.deep.equal({ entry: '12', complete: false });
        expect(core.pinKey('1234', '5', 4)).to.deep.equal({ entry: '1234', complete: true });
    });

    it('finds networks and cameras in the state IDs', () => {
        const ids = [
            `${NS}.networks.20.armed`,
            `${NS}.networks.10.name`,
            `${NS}.networks.10.armed`,
            `${NS}.cameras.300.image`,
            `${NS}.cameras.bad.image`,
            `blink.1.cameras.400.image`,
        ];
        expect(core.deviceIds(ids, NS, 'networks')).to.deep.equal([10, 20]);
        expect(core.deviceIds(ids, NS, 'cameras')).to.deep.equal([300]);
    });

    it('groups cameras by network in the order of Blink, cameras by name, without devices Blink no longer reports', () => {
        const groups = core.groupCameras(
            [
                { id: 1, name: 'Garden', available: true },
                { id: 2, name: 'Basement', available: true },
                { id: 3, name: 'Old', available: false },
                { id: 4, name: 'Empty', available: true },
            ],
            [
                { id: 11, name: 'Shed', networkId: 1, available: true },
                { id: 12, name: 'Gate 10', networkId: 1, available: true },
                { id: 13, name: 'Gate 9', networkId: 1, available: true },
                { id: 14, name: 'Gone', networkId: 1, available: false },
                { id: 21, name: 'Stairs', networkId: 2, available: undefined },
                { id: 31, name: 'Attic', networkId: 3, available: true },
            ],
            'en',
        );
        expect(groups.map(g => g.name)).to.deep.equal(['Garden', 'Basement']);
        expect(groups[0].cameras.map(c => c.name)).to.deep.equal(['Gate 9', 'Gate 10', 'Shed']);
    });

    it('tells the age of an image', () => {
        const now = 1_700_000_000_000;
        expect(core.formatAge('de', now - 20_000, now)).to.equal('gerade eben');
        expect(core.formatAge('de', now - 5 * 60_000, now)).to.equal('vor 5 Min');
        expect(core.formatAge('en', now - 3 * 3_600_000, now)).to.equal('3 h ago');
        expect(core.formatAge('de', now - 3 * 86_400_000, now)).to.equal('vor 3 Tagen');
        expect(core.formatAge('de', 0, now)).to.equal('');
        expect(core.formatAge('de', 'x', now)).to.equal('');
    });

    it('accepts only image files of its own instance', () => {
        expect(core.imageSrc(NS, '/blink.0/cameras_300.jpg', 1234)).to.equal('../blink.0/cameras_300.jpg?t=1234');
        expect(core.imageSrc(NS, '/blink.0/cameras_300.jpg', 0)).to.equal('../blink.0/cameras_300.jpg?t=0');
        expect(core.imageSrc(NS, '/blink.0/a.jpg', undefined)).to.equal('../blink.0/a.jpg');
        expect(core.imageSrc(NS, 'https://example.com/x.jpg', 1)).to.equal('');
        expect(core.imageSrc(NS, '/blink.1/a.jpg', 1)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/../system/x', 1)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/.hidden', 1)).to.equal('');
        // the adapter stores images as cameras/<id>.jpg and writes the address with ?t=<saved at> (image-store.ts)
        expect(core.imageSrc(NS, `/${NS}/${fileName(42)}`, 1)).to.not.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/42.jpg?t=1794238918100', 5)).to.equal(
            '../blink.0/cameras/42.jpg?t=1794238918100',
        );
        expect(core.imageSrc(NS, '/blink.0/cameras/42.jpg?x=1', 5)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/42.jpg?t=1?t=2', 5)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/42.jpg?t=1&u=//evil', 5)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/721232.jpg', 5)).to.equal('../blink.0/cameras/721232.jpg?t=5');
        expect(core.imageSrc(NS, '/blink.0/a/b/c.jpg', 1)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/../x.jpg', 1)).to.equal('');
        expect(core.imageSrc(NS, '/blink.0/cameras/.x', 1)).to.equal('');
        expect(core.imageSrc(NS, null, 1)).to.equal('');
    });

    it('builds the live address only from a valid answer, on the host of the page, over http', () => {
        const access = { port: 8766, path: `/live/300.mjpeg?token=${'ab'.repeat(32)}` };
        const page = { protocol: 'http:', hostname: '192.0.2.10' };
        expect(core.liveUrl(page, access)).to.equal(`http://192.0.2.10:8766${access.path}`);
        expect(core.liveUrl({ protocol: 'http:', hostname: '::1' }, access)).to.equal(
            `http://[::1]:8766${access.path}`,
        );
        expect(core.liveUrl({ protocol: 'https:', hostname: '192.0.2.10' }, access)).to.equal('');
        expect(core.liveUrl(page, { ...access, port: 0 })).to.equal('');
        expect(core.liveUrl(page, { ...access, path: '//evil.example/x' })).to.equal('');
        expect(core.liveUrl(page, { ...access, path: '/live/300.mjpeg?token=x' })).to.equal('');
        expect(core.liveUrl(page, null)).to.equal('');
    });

    it('reads the view from the address', () => {
        expect(core.viewFromSearch('?view=all')).to.equal('all');
        expect(core.viewFromSearch('?pin=0_userdata.0.x&view=tabs')).to.equal('tabs');
        expect(core.viewFromSearch('?view=grid')).to.equal(null);
        expect(core.viewFromSearch('')).to.equal(null);
    });

    it('picks the largest images with which every network fits the page', () => {
        const box = { width: 1026, height: 525, headWidth: 178, headMin: 126, gap: 8, strip: 36 };
        // 5 + 2 + 10 cameras like a house with three networks
        const cols = core.fitColumns({ ...box, counts: [5, 2, 10] });
        expect(core.overviewHeight({ ...box, counts: [5, 2, 10] }, cols)).to.be.at.most(box.height);
        expect(core.overviewHeight({ ...box, counts: [5, 2, 10] }, cols - 1)).to.be.greaterThan(box.height);
        // a few cameras: the minimum of three columns, never more columns than cameras
        expect(core.fitColumns({ ...box, counts: [2] })).to.equal(3);
        // no space at all: as many columns as useful, then the page scrolls
        expect(core.fitColumns({ ...box, height: 100, counts: [5, 2, 10] })).to.equal(10);
        expect(core.fitColumns({ ...box, height: 100, counts: [4] })).to.equal(4);
    });

    it('shows the last motion of the day with what was detected', () => {
        const now = Date.parse('2026-01-01T12:00:00Z');
        expect(core.motionBadge('de', now - 5 * 60_000, 'person', now)).to.deep.equal({
            text: 'Person · vor 5 Min',
            short: 'Person 5 Min',
            detected: true,
        });
        expect(core.motionBadge('de', now - 20_000, '', now)).to.deep.equal({
            text: 'Bewegung · gerade eben',
            short: 'jetzt',
            detected: false,
        });
        expect(core.motionBadge('en', now - 3 * 3_600_000, 'vehicle,dog', now)).to.include({
            text: 'Vehicle, dog · 3 h ago',
            short: 'Vehicle, dog 3 h',
        });
        expect(core.motionBadge('de', now - 40 * 60_000, '', now).short).to.equal('40 Min');
        // older than a day, nothing known or odd names: no marker, no markup
        expect(core.motionBadge('de', now - 25 * 3_600_000, 'person', now).text).to.equal('');
        expect(core.motionBadge('de', 0, 'person', now).text).to.equal('');
        expect(core.motionBadge('de', now, '<b>x</b>', now).text).to.equal('Bewegung · gerade eben');
    });

    it('accepts the stored clip of its own instance like an image', () => {
        expect(core.imageSrc(NS, '/blink.0/clips/300.mp4?t=1234', 0)).to.equal('../blink.0/clips/300.mp4?t=1234');
        expect(core.imageSrc(NS, '/blink.0/../x.mp4', 0)).to.equal('');
    });

    it('marks cameras that are offline, have a low battery or no motion detection', () => {
        expect(core.cameraBadges({ status: 'done', batteryLow: false, enabled: true })).to.deep.equal([]);
        expect(core.cameraBadges({ status: 'online', batteryLow: undefined, enabled: undefined })).to.deep.equal([]);
        expect(core.cameraBadges({ status: 'offline', batteryLow: true, enabled: false })).to.deep.equal([
            'offline',
            'batteryLow',
            'motionOff',
        ]);
        expect(core.cameraBadges({ status: undefined, batteryLow: false, enabled: true })).to.deep.equal([]);
    });
});
