// Bodyguard mode: follow a player and fight anything that threatens them.
// It stays close, attacks hostile mobs that come near the player (bow for
// far ones, melee for close ones), goes after whatever hurts the player, and
// keeps looking after itself (eating, armor, its own attackers) as it goes.

const { goals } = require("mineflayer-pathfinder");

function installBodyguard(ctx) {
    const { bot, config, kb } = ctx;
    const attackers = new Map(); // entity id -> time it hurt our player
    const ignoreUntil = new Map(); // entity id -> time (couldn't reach it)

    function wardEntity() {
        return ctx.ward ? bot.players[ctx.ward]?.entity : null;
    }

    // Note who hurts the player we're guarding. On 1.20+ the server tells us
    // the attacker; on older versions, blame the nearest hostile mob.
    bot.on("entityHurt", (entity, source) => {
        const ward = wardEntity();
        if (!ward || entity !== ward) return;
        let attacker = source && source !== bot.entity && source !== ward ? source : null;
        if (!attacker) {
            attacker = Object.values(bot.entities)
                .filter((e) => e !== ward && e !== bot.entity && ctx.isHostile(e))
                .filter((e) => e.position.distanceTo(ward.position) < 5)
                .sort((a, b) => a.position.distanceTo(ward.position) - b.position.distanceTo(ward.position))[0];
        }
        if (!attacker) return;
        if (attacker.type === "player" && !config.guardAgainstPlayers) {
            ctx.log(`${attacker.username} hurt ${ctx.ward}, but guardAgainstPlayers is off.`);
            return;
        }
        attackers.set(attacker.id, Date.now());
    });

    function threatToWard(ward) {
        const now = Date.now();
        const candidates = Object.values(bot.entities).filter((e) => {
            if (e === ward || e === bot.entity || !e.isValid || !e.position) return false;
            if ((ignoreUntil.get(e.id) || 0) > now) return false;
            if (now - (attackers.get(e.id) || 0) < 30000) return true; // hurt our player
            if (!ctx.isHostile(e) || kb.DONT_PROVOKE.has(e.name)) return false;
            return e.position.distanceTo(ward.position) <= config.guardRadius;
        });
        // Attackers first, then whatever is closest to the player.
        const score = (e) => (attackers.has(e.id) ? -100 : 0) + e.position.distanceTo(ward.position);
        return candidates.sort((a, b) => score(a) - score(b))[0];
    }

    async function bodyguard(name) {
        ctx.ward = name;
        attackers.clear();
        ctx.say(`Guarding ${name}. Say ${config.commandPrefix}stop to dismiss me.`);
        let lostSince = null;
        try {
            while (true) {
                ctx.checkStop();
                const ward = wardEntity();
                if (!ward) {
                    // Out of sight (too far, other dimension, logged off).
                    bot.pathfinder.setGoal(null);
                    if (!lostSince) {
                        lostSince = Date.now();
                        ctx.say(`I can't see ${name}. Come back near me and I'll follow.`);
                    }
                    await ctx.wait(1000);
                    continue;
                }
                if (lostSince) {
                    lostSince = null;
                    ctx.say(`Found ${name} again.`);
                }

                // Look after ourselves first (eat, armor, mobs on us).
                await ctx.guard();

                const threat = threatToWard(ward);
                if (threat) {
                    const before = ctx.interrupts;
                    const won = await ctx.fight(threat, {
                        maxDistance: config.guardRadius + 12,
                        leash: { entity: ward, radius: config.guardRadius + 8 },
                    });
                    if (won) {
                        attackers.delete(threat.id);
                    } else if (threat.isValid && ctx.interrupts === before) {
                        ignoreUntil.set(threat.id, Date.now() + 15000);
                    }
                    continue;
                }

                // Stay close.
                const distance = ward.position.distanceTo(bot.entity.position);
                if (distance > config.followDistance + 1) {
                    bot.pathfinder.setGoal(new goals.GoalFollow(ward, config.followDistance), true);
                } else if (distance < 1.5) {
                    bot.pathfinder.setGoal(null); // don't crowd them
                }
                await bot.waitForTicks(5);
            }
        } finally {
            ctx.ward = null;
            bot.pathfinder.setGoal(null);
            ctx.say(`Stopped guarding ${name}.`);
        }
    }

    Object.assign(ctx, { bodyguard });
}

module.exports = { installBodyguard };
