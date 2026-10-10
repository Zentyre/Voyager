// Getting unstuck: a watch on the pathfinder for when it stops getting
// anywhere, and the same thing would only happen again.
//
// The pathfinder's own check (no step reached in 3.5 s) plans again from
// where it is, and often picks the very move that just failed: pushed off
// it by flowing water, a jump it can't make, a block it can't put down. And
// while it's putting a block down (bridging: backing up to the edge of its
// block first) it doesn't check at all, so if it never quite gets to the
// edge (on a slab, a mob in the way) it waits there for ever.
//
// So: a block placement taking more than 8 s, the same next step for 12 s
// (not digging), or three failed steps in the same few blocks within 25 s,
// and the step it kept failing on is left out of its plans for two minutes,
// and it plans again. The third time on the
// same trip, it gives up on it with an error (the job then skips that
// target, or tries something else) rather than hang.

const AVOID_MS = 120000;
const PLACING_MS = 8000;
const STEP_MS = 12000;
const STRIKES = 3;

function installUnstuck(ctx, movements) {
    const { bot } = ctx;
    const pf = bot.pathfinder;

    // Steps (block positions) to leave out of plans, until when.
    const avoid = new Map();
    const key = (p) => `${p.x},${p.y},${p.z}`;
    const avoided = (block) => {
        if (avoid.size === 0 || !block?.position) return 0;
        const until = avoid.get(key(block.position));
        if (until === undefined) return 0;
        if (until > Date.now()) return 100;
        avoid.delete(key(block.position));
        return 0;
    };
    movements.exclusionAreasStep.push(avoided);
    movements.exclusionAreasPlace.push(avoided);

    // The goal, and whether it moves (a mob, a player): the pathfinder keeps neither where we can see.
    let goal = null;
    let dynamic = false;
    let strikes = 0;
    let gaveUp = 0;
    const setGoal = pf.setGoal.bind(pf);
    pf.setGoal = (g, dyn = false) => {
        if (g !== goal) {
            strikes = 0;
            failures = [];
        }
        goal = g;
        dynamic = dyn;
        return setGoal(g, dyn);
    };

    let path = [];
    bot.on("path_update", (r) => (path = r.path || []));

    // Failed steps: no step reached in time, a block it couldn't place or dig.
    let failures = [];
    bot.on("path_reset", (reason) => {
        if (!/^(stuck|place_error|dig_error)$/.test(reason) || !goal || !bot.entity) return;
        const now = Date.now();
        const here = bot.entity.position.clone();
        failures.push({ at: now, here, step: path[0] });
        failures = failures.filter((f) => now - f.at < 25000);
        const near = failures.filter((f) => f.here.distanceTo(here) < 3);
        if (near.length < 3) return;
        failures = [];
        const what = { stuck: "can't get to the next step", place_error: "can't put a block down", dig_error: "can't dig through" }[reason];
        setTimeout(() => stuck(near.map((f) => f.step), what), 0); // (out of the pathfinder's own reset first)
    });

    // Putting a block down for longer than that; or the same next step for
    // longer than that, not digging (it waits to be standing on something
    // before it digs, and floating in water it never is, so it waited for
    // ever there too, without its own check noticing).
    let placingSince = null;
    let stepKey = null;
    let stepSince = Date.now();
    let ticks = 0;
    bot.on("physicsTick", () => {
        if (++ticks % 10 !== 0) return;
        if (!goal || !pf.isMoving()) {
            placingSince = null;
            stepKey = null;
            return;
        }
        if (pf.isBuilding()) {
            placingSince = placingSince ?? Date.now();
            if (Date.now() - placingSince >= PLACING_MS) return stuck([path[0]], "can't put a block down");
        } else placingSince = null;
        const next = path[0] ? key(path[0]) : null;
        if (next !== stepKey || pf.isMining()) {
            stepKey = next;
            stepSince = Date.now();
        } else if (Date.now() - stepSince >= STEP_MS) {
            stuck([path[0]], "not getting to the next step");
        }
    });

    function stuck(steps, why) {
        placingSince = null;
        stepSince = Date.now();
        failures = [];
        if (!goal || !bot.entity) return;
        for (const s of steps) if (s) avoid.set(key(s), Date.now() + AVOID_MS);
        const where = ctx.fmt(bot.entity.position.floored());
        // Something that moves (a mob, a player): its own loop decides; just go another way.
        if (dynamic || ++strikes < STRIKES) {
            ctx.log(`Stuck at ${where} (${why}); trying another way.`);
            setGoal(goal, dynamic);
            return;
        }
        ctx.log(`Stuck at ${where} (${why}); giving up on getting there.`);
        gaveUp = Date.now();
        pf.setGoal(null);
    }

    // goto's error when it gave up: say why, not "the goal was changed".
    // And a trip that failed (no way there, stuck) in the water: out of the
    // water first (onto a bank it can climb, or digging one down, as when
    // idle), rather than try the next thing from in the river.
    const goto = pf.goto.bind(pf);
    pf.goto = async (g, ...rest) => {
        try {
            return await goto(g, ...rest);
        } catch (err) {
            const gaveUpNow = err?.name === "GoalChanged" && Date.now() - gaveUp < 2000;
            if (gaveUpNow || err?.name === "NoPath" || err?.name === "Timeout") {
                if (pf.goal === g) setGoal(null); // (left set, it went on trying in the background)
                await ctx.getOutOfWater?.({ evenIfBusy: true }).catch(() => {});
            }
            if (gaveUpNow) throw new Error(`I got stuck on the way at ${ctx.fmt(bot.entity.position.floored())}`);
            throw err;
        }
    };

    ctx.unstuck = { avoided: () => avoid.size };
}

module.exports = { installUnstuck };
