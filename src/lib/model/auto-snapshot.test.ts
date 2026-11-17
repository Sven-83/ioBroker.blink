import { expect } from 'chai';
import { nextAutoSnapshot, type AutoSnapshotPlan } from './auto-snapshot';

/** Every second Saturday at 12:00 */
const PLAN: AutoSnapshotPlan = { weeks: 2, day: 6, hour: 12, minute: 0 };

// local time, month 1-12
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
    return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('model/auto-snapshot', () => {
    it('is off with 0 weeks', () => {
        expect(nextAutoSnapshot(at(2026, 11, 17), undefined, { ...PLAN, weeks: 0 })).to.equal(undefined);
    });

    it('starts on the next planned day without an earlier run, nothing is made up', () => {
        // Tuesday 17.11.2026 -> Saturday 21.11. 12:00
        const first = { slot: at(2026, 11, 21, 12), runAt: at(2026, 11, 21, 12) };
        expect(nextAutoSnapshot(at(2026, 11, 17, 9), undefined, PLAN)).to.deep.equal(first);
        expect(nextAutoSnapshot(at(2026, 11, 17, 9), 0, PLAN)).to.deep.equal(first);
        expect(nextAutoSnapshot(at(2026, 11, 21, 11, 59), undefined, PLAN)).to.deep.equal(first);
        expect(nextAutoSnapshot(at(2026, 11, 21, 12, 1), undefined, PLAN)?.slot).to.equal(at(2026, 11, 28, 12));
    });

    it('waits the chosen weeks after the last run', () => {
        const last = at(2026, 11, 21, 12);
        const next = { slot: at(2026, 12, 5, 12), runAt: at(2026, 12, 5, 12) };
        expect(nextAutoSnapshot(at(2026, 11, 21, 12, 5), last, PLAN)).to.deep.equal(next);
        expect(nextAutoSnapshot(at(2026, 11, 28, 12), last, PLAN), 'not the week in between').to.deep.equal(next);
        expect(nextAutoSnapshot(at(2026, 11, 21, 12, 5), last, { ...PLAN, weeks: 1 })?.slot).to.equal(
            at(2026, 11, 28, 12),
        );
    });

    it('makes up a missed run at once and keeps the rhythm on the planned day', () => {
        const last = at(2026, 11, 7, 12);
        // adapter was off on Saturday 21.11. 12:00, live again on Sunday 22.11. 08:00
        const now = at(2026, 11, 22, 8);
        expect(nextAutoSnapshot(now, last, PLAN)).to.deep.equal({ slot: at(2026, 11, 21, 12), runAt: now });
        // after that run (stored as 21.11.) the next one is 05.12., not two weeks after the Sunday
        expect(nextAutoSnapshot(now + 60_000, at(2026, 11, 21, 12), PLAN)?.runAt).to.equal(at(2026, 12, 5, 12));
    });

    it('makes up only one run after a long pause', () => {
        const last = at(2026, 9, 5, 12);
        const now = at(2026, 11, 17, 9);
        // missed 19.09., 03.10., 17.10., 31.10., 14.11. -> one run now for 14.11.
        expect(nextAutoSnapshot(now, last, PLAN)).to.deep.equal({ slot: at(2026, 11, 14, 12), runAt: now });
        expect(nextAutoSnapshot(now, at(2026, 11, 14, 12), PLAN)?.runAt).to.equal(at(2026, 11, 28, 12));
    });

    it('runs at the planned time even if the timer is a moment late', () => {
        const last = at(2026, 11, 21, 12);
        const now = at(2026, 12, 5, 12) + 500;
        expect(nextAutoSnapshot(now, last, PLAN)).to.deep.equal({ slot: at(2026, 12, 5, 12), runAt: now });
    });

    it('keeps the local time over a clock change', () => {
        // last Sunday of March: clocks go forward in Europe; the time of day stays 12:00 local
        const next = nextAutoSnapshot(at(2027, 3, 26, 9), undefined, { ...PLAN, weeks: 1, day: 0 });
        expect(next?.slot).to.equal(at(2027, 3, 28, 12));
        expect(new Date(next!.slot).getHours()).to.equal(12);
        // two weeks over the change in autumn
        const autumn = nextAutoSnapshot(at(2027, 10, 24, 13), at(2027, 10, 23, 12), PLAN);
        expect(autumn?.slot).to.equal(at(2027, 11, 6, 12));
    });

    it('uses other days and times', () => {
        expect(
            nextAutoSnapshot(at(2026, 11, 17, 9), undefined, { weeks: 1, day: 1, hour: 7, minute: 30 })?.slot,
        ).to.equal(at(2026, 11, 23, 7, 30));
    });
});
