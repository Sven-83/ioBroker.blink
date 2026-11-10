import { expect } from 'chai';
import { describeMediaPage } from './media';

describe('api/media', () => {
    it('says what it got when the answer is not a media page', () => {
        expect(describeMediaPage(undefined)).to.equal('no object: undefined');
        expect(describeMediaPage({ limit: 25 })).to.equal('top {limit:number}, no "media" list');
    });

    it('lists the fields of all entries with their types and shortens the first entry', () => {
        const text = describeMediaPage({
            limit: 25,
            media: [
                {
                    id: 1,
                    created_at: '2026-11-10T20:00:00+00:00',
                    device_name: 'y'.repeat(70),
                    media: `/api/v2/accounts/1/media/clip/${'x'.repeat(80)}.mp4`,
                    thumbnail: 'https://rest-e001.immedia-semi.com/media/x/thumb',
                    metadata: { cv_detection: [{ type: 'person' }] },
                },
                { id: 2, deleted: false, metadata: null },
            ],
        });
        expect(text).to.contain('top {limit:number, media:array(2)}, 2 entries');
        expect(text).to.contain(
            'fields {created_at:string, deleted:boolean, device_name:string, id:number, media:string, metadata:object|null, thumbnail:string}',
        );
        expect(text).to.contain('…(70)');
        // addresses of clips and images never reach the log
        expect(text).to.contain('"media":"<address 114>"');
        expect(text).not.to.contain('/media/');
        expect(text).not.to.contain('immedia-semi');
        expect(text).to.contain('"cv_detection":[{"type":"person"}]');
    });

    it('counts type and source and collects the keys inside metadata, also when it is JSON text', () => {
        const text = describeMediaPage({
            media: [
                { type: 'video', source: 'pir', metadata: '{"pts_length_ms":20944}' },
                { type: 'video', source: 'cv_motion', metadata: '{"cv_detection":["person"]}' },
                { type: 'video', source: 'pir', metadata: null },
            ],
        });
        expect(text).to.contain('values {type: video 3; source: pir 2, cv_motion 1}');
        expect(text).to.contain('metadata {pts_length_ms=20944, cv_detection=["person"]}');
    });
});
