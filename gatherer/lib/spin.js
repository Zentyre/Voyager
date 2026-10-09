// Spinning: walk round and round a player.
//
// Every bot spinning round the same player takes its own place on one
// circle, spaced evenly, and they all go round together like a carousel, so
// they never walk into each other. They agree through the crew: each one
// holds a claim "spin:<player>:<bot>", and the place of each is its turn in
// the list of those (by name). The angle comes from the clock, which the
// crew's bots share, so they stay in step without talking every tick. Join
// or leave and the rest spread out again. The circle grows with more bots
// (at least 1.6 blocks between them).

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const SPEED = 3.2; // blocks a second round the circle (walking is 4.3, so it can catch up)
const GAP = 1.6; // least room between two bots on the circle

function installSpin(ctx) {
    const { bot, config } = ctx;

    async function spin(name, radius = 3) {
        const me = config.username;
        const key = `spin:${name.toLowerCase()}:`;
        let lostSince = null;
        let lastClaim = 0;
        let slot = null;
        let stuckSince = null;
        let lastPos = bot.entity.position.clone();
        ctx.say(`Spinning round ${name}. Say ${config.commandPrefix}stop to stop.`);
        try {
            while (true) {
                ctx.checkStop();
                if (Date.now() - lastClaim > 1000) {
                    ctx.crew?.claim(key + me, 4000);
                    lastClaim = Date.now();
                }
                const target = bot.players[name]?.entity;
                if (!target) {
                    stop();
                    ctx.doing(`Waiting for ${name} to come back into view`);
                    if (!lostSince) {
                        lostSince = Date.now();
                        ctx.say(`I can't see ${name}. Come back near me and I'll carry on.`);
                    }
                    await ctx.wait(1000);
                    continue;
                }
                lostSince = null;

                // Mobs, hunger and so on first.
                if (ctx.threatNearby()) {
                    stop();
                    await ctx.guard();
                    continue;
                }

                // My place on the circle.
                const spinners = [...new Set([...(ctx.crew?.holders(key) || []), me])].sort();
                const n = spinners.length;
                const i = spinners.indexOf(me);
                if (slot !== `${i}/${n}`) {
                    slot = `${i}/${n}`;
                    ctx.doing(n > 1 ? `Spinning round ${name} (${i + 1} of ${n})` : `Spinning round ${name}`);
                }
                const r = Math.max(radius, (n * GAP) / (2 * Math.PI));
                const w = SPEED / r;
                const angle = ((Date.now() / 1000) * w + (2 * Math.PI * i) / n) % (2 * Math.PI);
                const centre = target.position;
                // Aim a little ahead of the place, so it keeps moving rather than arriving.
                const ahead = angle + w * 0.35;
                const spot = new Vec3(centre.x + r * Math.cos(ahead), centre.y, centre.z + r * Math.sin(ahead));
                const place = new Vec3(centre.x + r * Math.cos(angle), centre.y, centre.z + r * Math.sin(angle));

                // Far off (just started, or it fell behind round an obstacle): walk there first.
                const off = bot.entity.position.distanceTo(place);
                if (off > 6) {
                    stop();
                    ctx.doing(`Going over to spin round ${name}`);
                    await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(place.x, place.y, place.z, 1)), 15000).catch(() => {});
                    slot = null;
                    continue;
                }

                steer(spot, off);
                // Not getting anywhere (a wall, a fence): let the pathfinder take it round.
                if (bot.entity.position.distanceTo(lastPos) > 0.5) {
                    lastPos = bot.entity.position.clone();
                    stuckSince = null;
                } else if (off > 1.5) {
                    stuckSince = stuckSince ?? Date.now();
                    if (Date.now() - stuckSince > 1500) {
                        stop();
                        await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(place.x, place.y, place.z, 1)), 8000).catch(() => {});
                        stuckSince = null;
                    }
                }
                await bot.waitForTicks(1);
            }
        } finally {
            stop();
            ctx.crew?.claim(key + me, 0); // let the others close up
            ctx.say(`Stopped spinning round ${name}.`);
        }
    }

    // Walk straight at `spot`: forward, sprinting if well behind, jumping a
    // block in the way, never into lava or fire or off a drop.
    function steer(spot, behind) {
        const p = bot.entity.position;
        const dx = spot.x - p.x, dz = spot.z - p.z;
        const yaw = Math.atan2(-dx, -dz);
        bot.look(yaw, 0, true).catch(() => {});
        const ahead = p.offset(-Math.sin(yaw) * 0.8, 0, -Math.cos(yaw) * 0.8).floored();
        const feet = bot.blockAt(ahead), head = bot.blockAt(ahead.offset(0, 1, 0)), over = bot.blockAt(ahead.offset(0, 2, 0));
        const floor = bot.blockAt(ahead.offset(0, -1, 0)), below = bot.blockAt(ahead.offset(0, -2, 0));
        const danger = [feet, floor].some((b) => /lava|fire|magma|cactus/.test(b?.name || ""));
        const drop = floor?.boundingBox === "empty" && below?.boundingBox === "empty";
        const blocked = feet?.boundingBox === "block" && head?.boundingBox === "empty" && over?.boundingBox === "empty";
        const go = Math.hypot(dx, dz) > 0.3 && !danger && !drop;
        bot.setControlState("forward", go);
        bot.setControlState("sprint", go && behind > 1.5);
        bot.setControlState("jump", go && blocked);
    }

    function stop() {
        bot.pathfinder.setGoal(null);
        for (const c of ["forward", "sprint", "jump"]) bot.setControlState(c, false);
    }

    Object.assign(ctx, { spin });
}

module.exports = { installSpin };
