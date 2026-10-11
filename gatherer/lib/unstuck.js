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
// (not digging), or three failed steps over at least 5 s with no progress
// in between (nothing dug, not 3 blocks further on), and the step
// it kept failing on is left out of its plans for two minutes, and it plans
// again. The third time in a row with no progress, it gives up on getting
// there with an error (the job then skips that target, or tries something
// else) rather than hang.
//
// (Failures alone weren't enough: on its way up a mountain, digging and
// climbing, with the odd failed dig among them, it gave up on one emerald
// after another within a second each. Its own replanning set off more:
// a dig just starting when it replanned went on, and the next one cut it
// short, which counts as a failed dig. So a few seconds after replanning
// don't count.)
//
// And going round in circles: putting a block somewhere and digging it out
// again, twice over at the same spot (a pillar it built and the pathfinder
// dug back out, a step it put down and then had to dig away, ...), is stuck
// too, however busy it looks; digging out its own block isn't progress.
// That spot is then left alone (no putting a block there, digging there or
// standing there) for two minutes, and no tunnelling straight up meanwhile.

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
    movements.exclusionAreasBreak.push(avoided);

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

    // Progress: a block dug, or a few blocks further on (towering and
    // bridging too: a block it puts down shows before the server has said
    // yes, so that isn't counted by itself).
    let progressAt = 0;
    const progress = () => (progressAt = Date.now());
    // What it put down and dug out where, lately (key -> times).
    const touched = new Map();
    const note = (pos, what) => {
        const k = key(pos.floored ? pos.floored() : pos);
        const now = Date.now();
        const t = (touched.get(k) || []).filter((e) => now - e.at < 60000);
        t.push({ at: now, what });
        touched.set(k, t);
        if (touched.size > 500) touched.delete(touched.keys().next().value);
        return t;
    };
    const placedHere = (pos) => (touched.get(key(pos)) || []).some((e) => e.what === "placed" && Date.now() - e.at < 60000);
    bot.on("diggingCompleted", (block) => {
        // (its own block dug out again is undoing, not getting anywhere)
        if (!block?.position || !placedHere(block.position)) progress();
    });
    const placeBlock = bot.placeBlock.bind(bot);
    bot.placeBlock = (ref, face, ...rest) => {
        if (ref?.position && face) circles(note(ref.position.plus(face), "placed"), ref.position.plus(face));
        return placeBlock(ref, face, ...rest);
    };
    // The last dig that failed, and why (for the log).
    let digError = null;
    const dig = bot.dig.bind(bot);
    bot.dig = (block, ...rest) => {
        const wasPlaced = block?.position && placedHere(block.position);
        return dig(block, ...rest).then(
            (done) => {
                if (wasPlaced) circles(note(block.position, "dug"), block.position);
                return done;
            },
            (err) => {
                digError = { at: Date.now(), block, message: err?.message };
                throw err;
            }
        );
    };
    // Put down and dug out twice over at one spot: going round in circles.
    function circles(t, pos) {
        const placed = t.filter((e) => e.what === "placed").length;
        const dug = t.filter((e) => e.what === "dug").length;
        if (placed < 2 || dug < 2) return;
        touched.delete(key(pos));
        ctx.noTunnelUntil = Date.now() + AVOID_MS;
        setTimeout(() => stuck([pos], `going round in circles, putting a block at ${ctx.fmt(pos)} and digging it out again`), 0);
    }

    // Failed steps: no step reached in time, a block it couldn't place or dig.
    let failures = [];
    let replannedAt = 0;
    bot.on("path_reset", (reason) => {
        if (!/^(stuck|place_error|dig_error)$/.test(reason) || !goal || !bot.entity) return;
        const now = Date.now();
        if (now - replannedAt < 3000) return; // (stirred up by its own replanning)
        failures = failures.filter((f) => f.at > progressAt && now - f.at < 25000);
        failures.push({ at: now, here: bot.entity.position.clone(), step: path[0] });
        if (failures.length < 3 || now - failures[0].at < 5000) return;
        const steps = failures.map((f) => f.step);
        failures = [];
        setTimeout(() => stuck(steps, describe(reason)), 0); // (out of the pathfinder's own reset first)
    });
    function describe(reason) {
        if (reason === "stuck") return "can't get to the next step";
        if (reason === "place_error") return "can't put a block down";
        const e = digError && Date.now() - digError.at < 3000 ? digError : null;
        return e ? `can't dig through the ${ctx.pretty(e.block?.name || "block")} at ${ctx.fmt(e.block?.position || bot.entity.position.floored())}: ${e.message}` : "can't dig through";
    }

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
        if (failures.length && bot.entity.position.distanceTo(failures[0].here) >= 3) progress();
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

    let strikeAt = 0;
    function stuck(steps, why) {
        placingSince = null;
        stepSince = Date.now();
        failures = [];
        for (const s of steps) if (s) avoid.set(key(s), Date.now() + AVOID_MS);
        if (!goal || !bot.entity) {
            if (/circles/.test(why)) ctx.log(`Going round in circles (${why.replace(/^going round in circles, /, "")}); leaving that spot alone.`);
            return;
        }
        const where = ctx.fmt(bot.entity.position.floored());
        if (progressAt > strikeAt) strikes = 0; // (got somewhere since the last time: start counting again)
        strikeAt = Date.now();
        // Something that moves (a mob, a player): its own loop decides; just go another way.
        if (dynamic || ++strikes < STRIKES) {
            ctx.log(`Stuck at ${where} (${why}); trying another way.`);
            replannedAt = Date.now();
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
    //
    // And too far (or too much water, or too many bots sharing the computer)
    // to plan all the way in the time allowed: it walks the best part it
    // found, and plans again from there, for as long as each leg gets it
    // nearer.
    const goto = pf.goto.bind(pf);
    pf.goto = async (g, ...rest) => {
        let best = Infinity;
        for (let legs = 0; ; legs++) {
            try {
                return await goto(g, ...rest);
            } catch (err) {
                if (err?.name === "Timeout" && pf.goal === g && legs < 12 && bot.entity) {
                    const left = () => g.heuristic(bot.entity.position.floored());
                    if (best === Infinity) best = left();
                    const t0 = Date.now();
                    while (pf.goal === g && pf.isMoving() && Date.now() - t0 < 60000) await ctx.wait(250);
                    if (g.isEnd(bot.entity.position.floored())) return;
                    if (pf.goal === g && left() < best - 4) {
                        best = left();
                        ctx.log(`Too far to plan all the way at once; planning the rest from here (about ${Math.round(best)} to go).`);
                        continue;
                    }
                }
                await failed(g, err);
            }
        }
    };
    async function failed(g, err) {
        const gaveUpNow = err?.name === "GoalChanged" && Date.now() - gaveUp < 2000;
        if (gaveUpNow || err?.name === "NoPath" || err?.name === "Timeout") {
            if (pf.goal === g) setGoal(null); // (left set, it went on trying in the background)
            await ctx.getOutOfWater?.({ evenIfBusy: true }).catch(() => {});
        }
        if (gaveUpNow) throw new Error(`I got stuck on the way at ${ctx.fmt(bot.entity.position.floored())}`);
        throw err;
    }

    ctx.unstuck = { avoided: () => avoid.size };
}

module.exports = { installUnstuck };
