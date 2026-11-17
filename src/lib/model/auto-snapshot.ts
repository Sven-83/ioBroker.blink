/*
 * Automatic image of all cameras on a fixed day and time, every few weeks (e.g. every second Saturday at 12:00).
 * A snapshot wakes a battery camera, so this stays rare (audit B.11.16). The image is then kept until a newer
 * one replaces it. The planned time of the last run is stored in a state, so a restart does not shift the rhythm.
 * A run missed while the adapter was not running is made up as soon as it is connected again.
 */

const DAY_MS = 24 * 3_600_000;
/** A planned time counts as due a little early, so clock changes do not push a run by a week */
const DUE_SLACK_MS = 12 * 3_600_000;
/** Timers are planned at most this far ahead and then planned again (setTimeout limit, clock changes) */
export const AUTO_SNAPSHOT_MAX_WAIT_MS = DAY_MS;
/** Not connected when a run is due: tried again after this wait */
export const AUTO_SNAPSHOT_RETRY_MS = 60_000;

/** When the automatic image is taken */
export interface AutoSnapshotPlan {
    /** Weeks between two runs, 0 = off */
    weeks: number;
    /** Day of the week, 0 = Sunday ... 6 = Saturday */
    day: number;
    /** Hour, local time */
    hour: number;
    /** Minute */
    minute: number;
}

/** Next run */
export interface AutoSnapshotRun {
    /** Planned day and time; stored after the run, so the rhythm stays on it */
    slot: number;
    /** When to run: the slot, or now if it was missed */
    runAt: number;
}

/**
 * First planned day and time at or after a moment.
 *
 * @param from - Moment
 * @param plan - Day and time
 */
function slotFrom(from: number, plan: AutoSnapshotPlan): number {
    const candidate = new Date(from);
    candidate.setHours(plan.hour, plan.minute, 0, 0);
    // setDate keeps the local time over clock changes
    while (candidate.getDay() !== plan.day || candidate.getTime() < from) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(plan.hour, plan.minute, 0, 0);
    }
    return candidate.getTime();
}

/**
 * Next automatic image. Without an earlier run it starts on the next planned day (nothing is made up right after
 * switching it on). After a run it is due the chosen number of weeks later; if that time has passed, it runs at
 * once, and only once, however many runs were missed.
 *
 * @param now - Current time
 * @param lastRun - Planned time of the last run, undefined or 0 if there was none
 * @param plan - Day, time and rhythm
 * @returns The run, undefined if switched off
 */
export function nextAutoSnapshot(
    now: number,
    lastRun: number | undefined,
    plan: AutoSnapshotPlan,
): AutoSnapshotRun | undefined {
    if (plan.weeks <= 0) {
        return undefined;
    }
    if (!lastRun || lastRun <= 0) {
        const slot = slotFrom(now, plan);
        return { slot, runAt: slot };
    }
    let slot = slotFrom(lastRun + plan.weeks * 7 * DAY_MS - DUE_SLACK_MS, plan);
    if (slot > now) {
        return { slot, runAt: slot };
    }
    // missed: the latest planned time that has passed keeps the rhythm for the runs after it
    for (;;) {
        const following = new Date(slot);
        following.setDate(following.getDate() + plan.weeks * 7);
        if (following.getTime() > now) {
            break;
        }
        slot = following.getTime();
    }
    return { slot, runAt: now };
}
