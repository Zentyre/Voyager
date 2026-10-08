// Water: don't drown, don't sink when idle, and get down to things under it.
//
// - Short of air (the server's air level, or 9 s with the head under water):
//   stop what it's doing, even a dig, and swim up; with something overhead,
//   swim to the nearest open air. Then carry on.
// - Idle in deep water: keep afloat, and after a few seconds swim to land.
// - Diving: the pathfinder holds "jump" all the time in water, so the bot
//   could never get down to a block or spot under water. When its goal is
//   below, let it sink.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

function installSwimming(ctx) {
    const { bot } = ctx;

    const watery = (b) => Boolean(b) && (WATERY.test(b.name) || String(b.getProperties?.().waterlogged) === "true");
    const dry = (b) => Boolean(b) && !watery(b) && (b.boundingBox === "empty") && !/lava|fire/.test(b.name);
    const eye = () => bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const headUnder = () => Boolean(bot.entity) && watery(bot.blockAt(eye().floored()));
    const air = () => bot.oxygenLevel ?? 20; // 0-20, from the server
    // In the water, or bobbing on top of it (the bot pops out of it at each bob).
    const wet = () => {
        const feet = bot.entity.position.floored();
        return bot.entity.isInWater || watery(bot.blockAt(feet)) || watery(bot.blockAt(feet.offset(0, -1, 0)));
    };

    let underSince = null;
    let inWaterSince = null;
    // How far down the head is.
    function depth() {
        const e = eye().floored();
        let y = e.y;
        while (y < e.y + 30 && watery(bot.blockAt(new Vec3(e.x, y + 1, e.z)))) y++;
        return y + 1 - eye().y;
    }
    // Time to come up is the depth at ~2.5 blocks a second; keep 3 s spare.
    // Air is the server's (20 = 15 s); without it, guess from time under.
    ctx.shortOfAir = () => {
        if (!headUnder()) return false;
        const needed = depth() / 2.5 + 3;
        const left = bot.oxygenLevel !== undefined ? (air() * 15) / 20 : 15 - (underSince !== null ? (Date.now() - underSince) / 1000 : 0);
        return left <= needed;
    };

    let floating = false;
    let surfacing = false;
    let raisedAlarm = false;
    let diving = false;
    bot.on("physicsTick", () => {
        if (!bot.entity) return;
        const under = headUnder();
        underSince = under ? underSince ?? Date.now() : null;
        inWaterSince = wet() ? inWaterSince ?? Date.now() : null;
        if (surfacing) return;

        // Running out of air: drop everything (the job's next safety check swims up).
        if (ctx.shortOfAir()) {
            if (!raisedAlarm) {
                raisedAlarm = true;
                if (bot.targetDigBlock) bot.stopDigging();
                ctx.stopCurrentAction();
                if (!ctx.busy) ctx.breathe().catch(() => {});
            }
        } else {
            raisedAlarm = false;
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

        // Diving: let it sink towards a goal below (the pathfinder would hold jump).
        if (bot.entity.isInWater && bot.pathfinder.isMoving()) {
            const goal = bot.pathfinder.goal;
            const goalY = goal?.y ?? goal?.pos?.y;
            if (goalY !== undefined && bot.entity.position.y > goalY + 0.5) bot.setControlState("jump", false);
        }
    });

    // The nearest air to breathe: open air with water (or ground) under it.
    function breathingSpot() {
        const me = bot.entity.position.floored();
        let best = null;
        for (let dy = 0; dy <= 12; dy++) {
            for (let dx = -8; dx <= 8; dx++) {
                for (let dz = -8; dz <= 8; dz++) {
                    const p = me.offset(dx, dy, dz);
                    if (!dry(bot.blockAt(p))) continue;
                    const below = bot.blockAt(p.offset(0, -1, 0));
                    if (!below || (!watery(below) && below.boundingBox !== "block")) continue;
                    const d = p.distanceTo(me);
                    if (!best || d < best.d) best = { p, d };
                }
            }
        }
        return best?.p || null;
    }

    async function breathe() {
        if (surfacing || !ctx.shortOfAir()) return;
        surfacing = true;
        try {
            await ctx.during("Swimming up for air", async () => {
                bot.pathfinder.setGoal(null);
                bot.clearControlStates();
                const start = Date.now();
                let bestY = bot.entity.position.y;
                let stuckSince = Date.now();
                let outSince = null;
                while (Date.now() - start < 25000) {
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
                    // Not getting any higher: something overhead. Swim to open air.
                    if (headUnder() && Date.now() - stuckSince > 2000) {
                        const spot = breathingSpot();
                        if (spot) {
                            ctx.log(`Something above me; swimming to air at ${ctx.fmt(spot)}.`);
                            await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 1)), 10000).catch(() => {});
                        }
                        stuckSince = Date.now();
                        bestY = bot.entity.position.y;
                    }
                    await bot.waitForTicks(2);
                }
            });
        } finally {
            bot.setControlState("jump", false);
            surfacing = false;
        }
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
                if (ctx.shortOfAir()) return false;
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
    async function getOutOfWater() {
        if (ctx.busy || !wet() || inWaterSince === null || Date.now() - inWaterSince < 4000) return;
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
    async function diveTo(pos) {
        const target = pos.offset(0.5, 0.5, 0.5);
        const close = () => eye().distanceTo(target) <= 4.2;
        if (close() && (bot.entity.onGround || !wet())) return;
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
                bot.setControlState("forward", Math.hypot(dx, dz) > 1.2);
                await bot.waitForTicks(2);
            }
        } finally {
            diving = false;
            bot.setControlState("forward", false);
        }
    }

    Object.assign(ctx, { breathe, getOutOfWater, headUnderwater: headUnder, isUnderwater, diveTo });
}

module.exports = { installSwimming };
