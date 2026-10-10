// Water: don't drown, don't sink when idle, and get down to things under it.
//
// - Short of air (the server's air level, or 9 s with the head under water):
//   stop what it's doing, even a dig, and swim up; with something overhead,
//   swim to the nearest open air. Then carry on.
// - Idle in deep water: keep afloat, and after a few seconds swim to land.
// - Diving: the pathfinder holds "jump" all the time in water, so the bot
//   could never get down to a block or spot under water. When its goal is
//   below, let it sink.
// - Never a dive it can't come back from: down, the digging and back up
//   must fit in one breath with time to spare, or the block is left for
//   one on land or in shallower water. A dive starts with full air.
// - The air alarm takes over at once and keeps at it until the bot is up,
//   whatever job it was on (it used to warn once and wait for the job to
//   notice; a job that went straight on to something else under water, like
//   picking up drops, could drown it). Walking waits until it's up. Under
//   something (ice, a cave roof) the alarm goes off in time to get out that
//   way: it breaks through if that's quick, or swims through the water to
//   the nearest gap.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

function installSwimming(ctx) {
    const { bot } = ctx;

    const watery = (b) => Boolean(b) && (WATERY.test(b.name) || String(b.getProperties?.().waterlogged) === "true");
    const dry = (b) => Boolean(b) && !watery(b) && (b.boundingBox === "empty") && !/lava|fire/.test(b.name);
    const eye = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const headUnder = () => Boolean(bot.entity) && watery(bot.blockAt(eye().floored()));
    const air = () => bot.oxygenLevel ?? 20; // 0-20, from the server
    // In the water, or bobbing on top of it (the bot pops out of it at each bob).
    const wet = () => {
        const feet = bot.entity.position.floored();
        return bot.entity.isInWater || watery(bot.blockAt(feet)) || watery(bot.blockAt(feet.offset(0, -1, 0)));
    };

    let underSince = null;
    let inWaterSince = null;
    // Time to come up is the depth at ~2.5 blocks a second; keep 4 s spare.
    // Air is the server's (20 = 15 s); without it, guess from time under.
    const UP = 2.5, DOWN = 3.5, SWIM = 2, SPARE = 4, BREATH = 15; // blocks/s, blocks/s, blocks/s, s, s
    const airLeft = () => (bot.oxygenLevel !== undefined ? (air() * BREATH) / 20 : BREATH - (underSince !== null ? (Date.now() - underSince) / 1000 : 0));
    // How long to get to air from here: straight up, or with something over
    // the water (ice, rock), breaking it if it's quick, else swimming across
    // to the nearest air (worked out once a second: it's a search).
    let across = { at: 0, secs: 0 };
    function secondsToAir() {
        const e = eye().floored();
        let y = e.y;
        while (y < e.y + 30 && watery(bot.blockAt(new Vec3(e.x, y + 1, e.z)))) y++;
        const up = (y + 1 - eye().y) / UP;
        const lid = bot.blockAt(new Vec3(e.x, y + 1, e.z));
        if (!lid || dry(lid)) return up;
        const dig = lidSeconds(lid);
        if (dig !== null) return up + dig;
        if (Date.now() - across.at > 1000) {
            const way = wayToAir();
            across = { at: Date.now(), secs: way ? way.length / SWIM + 1 : BREATH };
        }
        return Math.max(up, across.secs);
    }
    ctx.shortOfAir = () => {
        if (!headUnder()) return false;
        return airLeft() <= secondsToAir() + SPARE;
    };

    let floating = false;
    let surfacing = null; // the trip up, while it's under way
    let diving = false;
    bot.on("physicsTick", () => {
        if (!bot.entity) return;
        const under = headUnder();
        underSince = under ? underSince ?? Date.now() : null;
        inWaterSince = wet() ? inWaterSince ?? Date.now() : null;
        if (surfacing) return;

        // Running out of air: drop everything and go up, now.
        if (ctx.shortOfAir()) {
            if (bot.targetDigBlock) bot.stopDigging();
            ctx.stopCurrentAction();
            ctx.breathe().catch(() => {});
            return;
        }

        // Idle in deep water: keep the head up.
        const deep = under || watery(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)));
        const idleAfloat = !ctx.busy && wet() && deep && !bot.pathfinder.isMoving();
        if (idleAfloat && !floating) {
            floating = true;
            bot.setControlState("jump", true);
        } else if (!idleAfloat && floating) {
            floating = false;
            bot.setControlState("jump", false);
        }

        // Swimming down, as a player does holding sneak (the physics here has no such thing).
        if (diving && bot.entity.isInWater) bot.entity.velocity.y -= 0.04;

        // Diving: let it sink towards a goal just below (the pathfinder would
        // hold jump). Only one close by: for one further off that's merely
        // lower (past a river), it sank to the bottom on the way and couldn't
        // get up the far bank.
        if (bot.entity.isInWater && bot.pathfinder.isMoving()) {
            const goal = bot.pathfinder.goal;
            const g = goal?.pos ?? goal;
            const p = bot.entity.position;
            const below = Number.isFinite(g?.y) && Number.isFinite(g?.x) && Number.isFinite(g?.z) && p.y > g.y + 0.5;
            if (below && Math.hypot(g.x + 0.5 - p.x, g.z + 0.5 - p.z) < 3) bot.setControlState("jump", false);
        }
    });

    // The pathfinder plans through deep water at the level it went in at, a
    // block or more under the top, but the bot (holding jump) swims at the
    // top. More than a block above a step, it never counted it reached: it
    // went past, turned back for it, past again, while any current carried
    // it off downstream. So steps in deep water go up to the top of it (as
    // copies: the pathfinder's own may still be in its search). Not the last
    // one: that may be something on the bottom it's diving for.
    bot.on("path_update", (r) => {
        const path = r.path;
        for (let i = 0; path && i < path.length - 1; i++) {
            const n = path[i];
            if (n.toBreak?.length || n.toPlace?.length) continue;
            let y = n.y;
            while (y < n.y + 8 && watery(bot.blockAt(new Vec3(n.x, y, n.z))) && watery(bot.blockAt(new Vec3(n.x, y + 1, n.z)))) y++;
            if (y !== n.y) path[i] = Object.assign(Object.create(Object.getPrototypeOf(n)), n, { y });
        }
    });

    // The nearest air it can swim up into: a gap in the top of the water (a
    // hole in the ice, the open sea, an air pocket in a flooded cave), found
    // by swimming outwards through the water, so not one past a wall or on
    // the far side of the ice. Returns the way there (water blocks, the last
    // one under the air) or null.
    function wayToAir() {
        const start = eye().floored();
        if (!watery(bot.blockAt(start))) return null;
        const seen = new Map([[start.toString(), null]]);
        let edge = [start];
        for (let steps = 0; steps < 40 && edge.length; steps++) {
            const next = [];
            for (const p of edge) {
                if (dry(bot.blockAt(p.offset(0, 1, 0)))) {
                    const way = [];
                    for (let q = p; q; q = seen.get(q.toString())) way.unshift(q);
                    return way;
                }
                for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
                    const q = p.offset(dx, dy, dz);
                    const k = q.toString();
                    if (seen.has(k) || seen.size > 4000 || Math.abs(q.x - start.x) > 12 || Math.abs(q.z - start.z) > 12 || q.y < start.y - 6) continue;
                    seen.set(k, p);
                    if (watery(bot.blockAt(q))) next.push(q);
                }
            }
            edge = next;
        }
        return null;
    }

    // Up for air: short of it, or (`full`) before a dive with less than a
    // full breath. Anyone asking while it's on its way up waits for it.
    function breathe({ full = false } = {}) {
        if (surfacing) return surfacing;
        if (!(ctx.shortOfAir() || (full && headUnder() && air() < 19))) return Promise.resolve();
        surfacing = surface().finally(() => (surfacing = null));
        return surfacing;
    }

    async function surface() {
        try {
            await ctx.during("Swimming up for air", async () => {
                bot.pathfinder.setGoal(null);
                bot.clearControlStates();
                const start = Date.now();
                let bestY = bot.entity.position.y;
                let stuckSince = Date.now();
                let outSince = null;
                while (Date.now() - start < 30000) {
                    // Breathe until full (bobbing at the top pops it out of the water now and then).
                    outSince = headUnder() ? null : outSince ?? Date.now();
                    const full = bot.oxygenLevel !== undefined ? air() >= 19 : outSince !== null && Date.now() - outSince > 2500;
                    if (!headUnder() && full) break;
                    if (!wet() && bot.entity.onGround) break; // on land
                    if (headUnder()) bot.setControlState("jump", true);
                    if (bot.entity.position.y > bestY + 0.3) {
                        bestY = bot.entity.position.y;
                        stuckSince = Date.now();
                    }
                    // Not getting any higher: something overhead. Break through it,
                    // or swim through the water to the nearest air.
                    if (headUnder() && Date.now() - stuckSince > 1000) {
                        if (!(await breakThrough())) {
                            const way = wayToAir();
                            if (way) {
                                ctx.log(`Something above me; swimming to air at ${ctx.fmt(way[way.length - 1].offset(0, 1, 0))}.`);
                                await swimAlong(way, 10000);
                            }
                        }
                        stuckSince = Date.now();
                        bestY = bot.entity.position.y;
                    }
                    await bot.waitForTicks(2);
                }
            });
        } finally {
            for (const c of ["jump", "forward", "sprint"]) bot.setControlState(c, false);
        }
    }

    // Seconds to break a block over the water from below, if it's quick
    // (2.5 s at most) and safe: not lava above it, not something it mustn't
    // break, not sand or gravel with more on top (that would only drop in).
    // Otherwise null.
    function lidSeconds(lid) {
        if (lid.boundingBox !== "block" || !lid.diggable) return null;
        if (ctx.kb?.neverBreakIds?.().includes(lid.type)) return null;
        const over = bot.blockAt(lid.position.offset(0, 1, 0));
        if (/lava/.test(over?.name || "")) return null;
        if (bot.pathfinder.movements?.gravityBlocks?.has(lid.type) && over?.boundingBox === "block") return null;
        const tool = bot.pathfinder.bestHarvestTool(lid);
        const ms = lid.digTime(tool ? tool.type : null, false, true, true, [], bot.entity.effects);
        return ms > 2500 ? null : ms / 1000 + 0.5;
    }

    // The block over its head, if lidSeconds says so: break it and go on up.
    async function breakThrough() {
        const above = bot.blockAt(eye().floored().offset(0, 1, 0));
        if (!above || lidSeconds(above) === null) return false;
        const tool = bot.pathfinder.bestHarvestTool(above);
        try {
            ctx.log(`Breaking the ${ctx.pretty(above.name)} over my head to get up for air.`);
            if (tool) await bot.equip(tool, "hand");
            await bot.dig(above, true);
            return true;
        } catch (err) {
            return false;
        }
    }

    // Swim along a way through the water (from wayToAir) until the head is
    // out: at each moment, at the furthest of the next few blocks of it that
    // it can swim straight to.
    async function swimAlong(way, ms) {
        const start = Date.now();
        const centre = (p) => p.offset(0.5, 0.5, 0.5);
        try {
            while (Date.now() - start < ms && headUnder()) {
                const e = eye();
                // where it's got to along the way
                let at = 0;
                way.forEach((p, i) => {
                    if (centre(p).distanceTo(e) < centre(way[at]).distanceTo(e)) at = i;
                });
                let aim = way[at];
                for (let i = at + 1; i < Math.min(way.length, at + 6); i++) if (straight(e, centre(way[i]))) aim = way[i];
                if (aim === way[way.length - 1]) aim = aim.offset(0, 1, 0); // the last one: up into the air
                const t = centre(aim);
                const dx = t.x - e.x, dy = t.y - e.y, dz = t.z - e.z;
                await bot.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true);
                bot.setControlState("forward", Math.hypot(dx, dz) > 0.3);
                bot.setControlState("jump", dy > -0.3);
                await bot.waitForTicks(2);
            }
        } finally {
            bot.setControlState("forward", false);
        }
    }

    // Nothing but water between two points?
    function straight(a, b) {
        const n = Math.ceil(a.distanceTo(b) / 0.3);
        for (let i = 1; i < n; i++) {
            const p = a.plus(b.minus(a).scaled(i / n));
            if (!watery(bot.blockAt(p.floored())) && !dry(bot.blockAt(p.floored()))) return false;
        }
        return true;
    }

    // The top of the water the bot is in (the highest water block above its feet).
    function surfaceY() {
        let y = bot.entity.position.floored().y - 1;
        while (watery(bot.blockAt(new Vec3(bot.entity.position.x, y + 1, bot.entity.position.z))) && y < 320) y++;
        return y;
    }

    // Swim straight at a spot (look at it, forward and up): the pathfinder
    // doesn't really plan swimming, and dragged the bot along the bottom.
    // A bank level with the water (or lower) can be climbed straight out of.
    async function swimTo(spot, ms = 15000) {
        const start = Date.now();
        try {
            while (Date.now() - start < ms) {
                if (!wet() && bot.entity.onGround) return true;
                if (ctx.shortOfAir() || bot.pathfinder.goal) return false; // (something else is taking it somewhere)
                const p = bot.entity.position;
                const dx = spot.x + 0.5 - p.x, dz = spot.z + 0.5 - p.z;
                if (Math.hypot(dx, dz) < 0.3 && !wet()) return true;
                await bot.look(Math.atan2(-dx, -dz), 0, true);
                bot.setControlState("forward", true);
                bot.setControlState("jump", true);
                await bot.waitForTicks(2);
            }
            return false;
        } finally {
            bot.setControlState("forward", false);
            bot.setControlState("jump", false);
        }
    }

    // Idle and still in deep water after a few seconds: swim to the nearest
    // place it can climb out (where the bank isn't above the water). If the
    // banks are all a block too high, dig the edge of the nearest one down.
    // (`evenIfBusy`: a job's trip that failed in the water, straight away.)
    async function getOutOfWater({ evenIfBusy = false } = {}) {
        // (not while the pathfinder is taking it somewhere: both steering, it
        // was turned to the bank every other tick and swam neither way, while
        // any current carried it off; ".home" and the like aren't "busy")
        if (surfacing || bot.pathfinder.goal || !wet() || inWaterSince === null) return;
        if (!evenIfBusy && (ctx.busy || Date.now() - inWaterSince < 4000)) return;
        const me = bot.entity.position.floored();
        const top = surfaceY();
        let low = null, high = null;
        for (let dx = -16; dx <= 16; dx++) {
            for (let dz = -16; dz <= 16; dz++) {
                for (let y = top - 2; y <= top + 2; y++) {
                    const p = new Vec3(me.x + dx, y, me.z + dz);
                    const ground = bot.blockAt(p.offset(0, -1, 0));
                    if (!ground || ground.boundingBox !== "block" || watery(ground)) continue;
                    if (!dry(bot.blockAt(p)) || !dry(bot.blockAt(p.offset(0, 1, 0)))) continue;
                    // at the water's edge (not a spot behind a bank: it swam into the bank)
                    if (!SIDES.some(([sx, sz]) => watery(bot.blockAt(p.offset(sx, -1, sz))) || watery(bot.blockAt(p.offset(sx, -2, sz))))) continue;
                    const d = Math.hypot(dx, dz);
                    if (y <= top + 1) {
                        if (!low || d < low.d) low = { p, d };
                    } else if (y === top + 2 && ground.diggable && ground.hardness !== null && ground.hardness < 3) {
                        if (!high || d < high.d) high = { p, d, ground };
                    }
                }
            }
        }
        if (low) {
            await ctx.during("Swimming to dry land", () => swimTo(low.p));
            return;
        }
        if (!high) return; // nowhere to get out: stay afloat
        await ctx.during("Swimming to the bank", async () => {
            // up to the bank, dig its edge down a block, climb out there
            const edge = high.p.offset(0, -1, 0);
            await swimTo(edge, 8000);
            const block = bot.blockAt(edge);
            if (block && block.boundingBox === "block") {
                await bot.tool.equipForBlock(block, {}).catch(() => {});
                await bot.dig(block, true).catch(() => {});
            }
            await swimTo(edge);
        });
    }

    // A block with water over it: the pathfinder never goes under water, so
    // swim to the water above it and dive, down to stand on the bottom next to
    // it (digging while floating takes five times as long).
    const isUnderwater = (pos) => watery(bot.blockAt(pos.offset(0, 1, 0)));

    // How much water is over `pos`, and whether a dive for it (down, digging
    // it, back up, with time to spare) fits in one breath.
    function waterOver(pos) {
        let d = 0;
        while (d < 64 && watery(bot.blockAt(pos.offset(0, d + 1, 0)))) d++;
        return d;
    }
    function digSeconds(pos) {
        const block = bot.blockAt(pos);
        if (!block || block.boundingBox !== "block") return 0;
        const tool = bot.pathfinder.bestHarvestTool(block);
        return block.digTime(tool ? tool.type : null, false, true, false, [], bot.entity.effects) / 1000 + 0.5;
    }
    function diveSeconds(pos) {
        const d = waterOver(pos);
        return d / DOWN + digSeconds(pos) + d / UP + SPARE;
    }
    ctx.tooDeepToDive = (pos) => isUnderwater(pos) && diveSeconds(pos) > BREATH;
    ctx.waterOver = waterOver;

    async function diveTo(pos) {
        const target = pos.offset(0.5, 0.5, 0.5);
        const close = () => eye().distanceTo(target) <= 4.2;
        if (diveSeconds(pos) > BREATH) throw new Error(`too deep to dive for (${waterOver(pos)} blocks of water)`);
        // Not enough air left for this one (already down there: to dig it and
        // get back up): up for a full breath first, rather than start and be
        // called away half way through.
        const there = close() && (bot.entity.onGround || !wet());
        if (headUnder() && airLeft() < (there ? digSeconds(pos) + secondsToAir() + SPARE : diveSeconds(pos))) await breathe({ full: true });
        else if (there) return;
        if (!wet() || Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) > 3) {
            ctx.doing(`Swimming over the ${bot.blockAt(pos)?.name.replace(/_/g, " ") || "spot"} at ${ctx.fmt(pos)}`);
            await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(pos.x, pos.z, 2)), 40000);
        }
        ctx.doing(`Diving to ${ctx.fmt(pos)}`);
        const start = Date.now();
        diving = true;
        let closeSince = null;
        try {
            while (!(close() && bot.entity.onGround)) {
                ctx.checkStop();
                // In reach but can't get a footing (a corner, a ledge): dig from here, slower.
                closeSince = close() ? closeSince ?? Date.now() : null;
                if (closeSince !== null && Date.now() - closeSince > 3000) break;
                if (ctx.shortOfAir()) throw new Error("out of air on the way down");
                if (Date.now() - start > 12000) throw new Error("couldn't dive down to it");
                if (close() && !wet()) break;
                const p = bot.entity.position;
                const dx = target.x - p.x, dz = target.z - p.z;
                await bot.look(Math.atan2(-dx, -dz), -0.6, true);
                bot.setControlState("jump", false);
                // (on the bank right by it: step off into the water)
                bot.setControlState("forward", Math.hypot(dx, dz) > 1.2 || !wet());
                await bot.waitForTicks(2);
            }
        } finally {
            diving = false;
            bot.setControlState("forward", false);
        }
    }

    // Nowhere to walk to while it's on its way up for air.
    const goto = bot.pathfinder.goto.bind(bot.pathfinder);
    bot.pathfinder.goto = async (...args) => {
        if (surfacing) await surfacing.catch(() => {});
        return goto(...args);
    };

    Object.assign(ctx, { breathe, getOutOfWater, headUnderwater: headUnder, isUnderwater, diveTo });
}

// The pathfinder can't plan getting out of water up onto a bank: "can't
// jump from water", so it only leaves where the shore slopes in level with
// it. A river with a bank a block high was a trap: it planned in, couldn't
// plan out, and swam about (pushed by any current) replanning. A player
// swims at the bank holding jump and climbs out (the game boosts you up
// when you swim into a wall at the top of the water), and the bot's physics
// does the same; this adds that move: from water onto ground beside it
// level with the top of the water, with room to come up.
const Move = require("mineflayer-pathfinder/lib/move");
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function addWaterExits(movements) {
    const isWater = (b) => Boolean(b?.name) && (/^(water|bubble_column)$/.test(b.name) || String(b.getProperties?.().waterlogged) === "true");
    const getNeighbors = movements.getNeighbors.bind(movements);
    movements.getNeighbors = (node) => {
        const neighbors = getNeighbors(node);
        if (!isWater(movements.getBlock(node, 0, 0, 0))) return neighbors;
        // the top of the water here, and air over it to come up into
        let top = 0;
        while (top < 3 && isWater(movements.getBlock(node, 0, top + 1, 0))) top++;
        if (top === 3) return neighbors; // too deep under: swim up first
        const over = (dy) => {
            const b = movements.getBlock(node, 0, dy, 0);
            return b.safe && !b.liquid;
        };
        if (!over(top + 1)) return neighbors;
        // Onto ground level with the top of the water. (Not a block higher:
        // the boost only lifts it about half a block clear of the water, in
        // the game as here; it tried, fell back, and tried again.)
        const up = top + 1;
        if (!over(up + 1)) return neighbors;
        for (const [dx, dz] of SIDES) {
            const ground = movements.getBlock(node, dx, up - 1, dz);
            const feet = movements.getBlock(node, dx, up, dz);
            const head = movements.getBlock(node, dx, up + 1, dz);
            if (!ground.physical || ground.liquid || !feet.safe || feet.liquid || !head.safe || head.liquid) continue;
            const cost = 2 + movements.liquidCost + (up - 1) + movements.exclusionStep(feet);
            if (cost < 100) neighbors.push(new Move(node.x + dx, node.y + up, node.z + dz, node.remainingBlocks, cost, [], []));
        }
        return neighbors;
    };
}

module.exports = { installSwimming, addWaterExits };
