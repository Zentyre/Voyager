// Fighting: weapon and armor choice, a melee loop with attack cooldowns,
// critical hits and shield blocking, running away, and putting out fire.
// The fighting style used against each mob type is learned from experience.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

// [damage, attacks per second]
const WEAPON_STATS = {
    wooden_sword: [4, 1.6], golden_sword: [4, 1.6], stone_sword: [5, 1.6],
    iron_sword: [6, 1.6], diamond_sword: [7, 1.6], netherite_sword: [8, 1.6],
    wooden_axe: [7, 0.8], golden_axe: [7, 1.0], stone_axe: [9, 0.8],
    iron_axe: [9, 0.9], diamond_axe: [9, 1.0], netherite_axe: [10, 1.0],
    trident: [9, 1.1],
};
const FIST = { name: null, damage: 1, speed: 4 };

const ARMOR_SLOTS = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet" };
const ARMOR_RANK = ["leather", "golden", "chainmail", "turtle", "iron", "diamond", "netherite"];

// Fighting styles the bot chooses between per mob type:
//   crit - jump and hit while falling, not sprinting (+50% damage, slower)
//   fast - hit as soon as the weapon is ready
//   kite - hit, then step back out of reach
//   bow  - shoot from a distance (only when carrying a bow and arrows)
// A player gets none of these: see duel().
const STYLES = ["crit", "fast", "kite"];
const RANGED = new Set(["skeleton", "stray", "bogged", "pillager", "witch", "blaze"]);
// Mobs that fly at you: no walking to them; see skyFight().
const FLYERS = new Set(["phantom", "vex"]);
// Melee reach, measured as the game does: from the eyes to the nearest point
// of the mob's hitbox. A player gets 3; the server accepts up to 6 (3 plus 3
// blocks of tolerance), so config.attackReach (default 5) lets the bot hit
// from further than a mob can hit back.
const REACH = 3.0;
// Ticks from jumping to falling (when a hit is a crit).
const CRIT_TICKS = 7;

function armorInfo(name) {
    const match = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name || "");
    if (!match) return null;
    return { slot: ARMOR_SLOTS[match[2]], rank: ARMOR_RANK.indexOf(match[1]) };
}

function installCombat(ctx) {
    const { bot, config, kb, learn } = ctx;
    let shieldUp = false;
    let extinguishing = false;

    // ---------- reach ----------

    const attackReach = () => Math.min(5.5, Math.max(2, Number(config.attackReach) || REACH));
    // From the bot's eyes to the nearest point of the mob's hitbox.
    function reachTo(mob) {
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
        const w = (mob.width ?? 0.6) / 2, h = mob.height ?? 1.8, p = mob.position;
        const near = new Vec3(
            Math.max(p.x - w, Math.min(eye.x, p.x + w)),
            Math.max(p.y, Math.min(eye.y, p.y + h)),
            Math.max(p.z - w, Math.min(eye.z, p.z + w))
        );
        return eye.distanceTo(near);
    }
    const inReach = (mob, spare = 0) => reachTo(mob) <= attackReach() + spare;
    // How far off to keep while fighting: close enough to hit, as far as that
    // allows, so it hits first (a zombie reaches about 2 blocks).
    const fightDistance = (style) => Math.max(style === "kite" ? 2.5 : 1.5, attackReach() - (style === "kite" ? 1 : 1.5));

    // ---------- who can get at us ----------

    // Can it see us (and so come for us, or shoot)? Mobs only go for a player
    // they can see: one on the other side of a wall isn't after the bot.
    function canSee(entity) {
        if (!entity?.position || !bot.entity) return false;
        const eyes = [bot.entity.position.offset(0, 1.62, 0), bot.entity.position.offset(0, 0.5, 0)];
        const theirs = [entity.position.offset(0, (entity.height || 1.6) * 0.85, 0), entity.position.offset(0, (entity.height || 1.6) * 0.4, 0)];
        return eyes.some((from) =>
            theirs.some((to) => {
                const dir = to.minus(from);
                const range = dir.norm();
                if (range < 0.5) return true;
                return !bot.world.raycast(from, dir.normalize(), range, (b) => b.boundingBox === "block");
            })
        );
    }

    // Who hurt the bot lately (the server names the attacker on 1.20+;
    // otherwise, the nearest hostile mob that can see it).
    const hurtBy = new Map(); // entity id -> when
    bot.on("entityHurt", (entity, source) => {
        if (!bot.entity || entity !== bot.entity) return;
        let attacker = source && source !== bot.entity ? source : null;
        if (!attacker) {
            const me = bot.entity.position;
            attacker = Object.values(bot.entities)
                .filter((e) => e !== bot.entity && e.position && isHostile(e) && e.position.distanceTo(me) < 6 && canSee(e))
                .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
        }
        if (attacker) hurtBy.set(attacker.id, Date.now());
    });
    const hurtMe = (entity, ms = 10000) => Date.now() - (hurtBy.get(entity?.id) || 0) < ms;

    function isHostile(entity) {
        return bot.registry.entitiesByName[entity.name]?.category === "Hostile mobs";
    }

    // ---------- equipment ----------

    function bestWeapon() {
        let best = FIST;
        for (const item of bot.inventory.items()) {
            const stats = WEAPON_STATS[item.name];
            if (!stats) continue;
            if (stats[0] * stats[1] > best.damage * best.speed) {
                best = { name: item.name, item, damage: stats[0], speed: stats[1] };
            }
        }
        return best;
    }

    async function equipWeapon() {
        const weapon = bestWeapon();
        if (weapon.item && bot.heldItem?.name !== weapon.name) {
            await bot.equip(weapon.item, "hand").catch(() => {});
        }
        return weapon;
    }

    // Wear the best armor we carry, and a shield in the off-hand.
    async function equipArmor() {
        if (config.autoArmor === false || ctx.handingOver) return;
        for (const slot of Object.values(ARMOR_SLOTS)) {
            const worn = armorInfo(bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name);
            const best = bot.inventory
                .items()
                .map((item) => ({ item, info: armorInfo(item.name) }))
                .filter(({ info }) => info && info.slot === slot)
                .sort((a, b) => b.info.rank - a.info.rank)[0];
            if (best && (!worn || best.info.rank > worn.rank)) {
                await bot
                    .equip(best.item, slot)
                    .then(() => ctx.log(`Put on ${best.item.name}.`))
                    .catch((err) => ctx.log(`Couldn't wear ${best.item.name}: ${err.message}`));
            }
        }
        const offHand = bot.inventory.slots[bot.getEquipmentDestSlot("off-hand")];
        const shield = bot.inventory.items().find((i) => i.name === "shield");
        if (!offHand && shield) await bot.equip(shield, "off-hand").catch(() => {});
    }

    function hasShield() {
        return (
            config.useShield !== false &&
            bot.inventory.slots[bot.getEquipmentDestSlot("off-hand")]?.name === "shield"
        );
    }

    // Up while a fight wants it (closing in on archers, a player about to
    // hit) or an arrow's on its way (see below).
    let fightWantsShield = false;
    let arrowComing = false;
    function applyShield() {
        const up = (fightWantsShield || arrowComing) && hasShield();
        if (up && !shieldUp) {
            bot.activateItem(true);
            shieldUp = true;
        } else if (!up && shieldUp) {
            bot.deactivateItem();
            shieldUp = false;
        }
    }
    function raiseShield(up) {
        fightWantsShield = up;
        applyShield();
    }
    // Down for its own swing (it can't hit with the shield up); back up next tick if still wanted.
    function lowerForSwing() {
        if (!shieldUp) return;
        bot.deactivateItem();
        shieldUp = false;
    }

    // ---------- arrows ----------

    // An arrow (or trident) on its way to it: the shield goes up, facing
    // where it's coming from, until it's gone by. Each one's path is worked
    // out from where it was last tick; it's blocked if it will pass within
    // a block and a half in the next 9 ticks (a shield takes 5 to come up:
    // no sooner, so it isn't stood still with its shield up for longer than
    // it has to be on its way somewhere).
    const PROJECTILES = /^(arrow|spectral_arrow|trident)$/;
    const BOWS = /^(bow|crossbow)$/;
    // A player (not the owner, an admin or crew) or an archer mob within 24
    // blocks that can see it, drawing a bow at it (the game shows others
    // using an item: the low bit of living entities' flags), facing it.
    function drawingAtMe() {
        const me = bot.entity.position;
        for (const e of Object.values(bot.entities)) {
            if (e === bot.entity || !e.position || !(e.type === "player" || RANGED.has(e.name))) continue;
            if (e.type === "player" && trustedName(e.username)) continue;
            if (!BOWS.test(e.heldItem?.name || "") || !((e.metadata?.[8] ?? 0) & 1)) continue;
            const to = me.minus(e.position);
            const d = Math.hypot(to.x, to.z);
            if (d < 2 || d > 24) continue;
            if ((-Math.sin(e.yaw) * to.x - Math.cos(e.yaw) * to.z) / d < 0.8) continue; // facing elsewhere
            if (canSee(e)) return e;
        }
        return null;
    }
    const trustedName = (name) => {
        const n = String(name || "").toLowerCase();
        return [config.owner, ...(config.admins || [])].some((t) => t && t.toLowerCase() === n) || Boolean(ctx.crew?.members().has(n));
    };
    const flying = new Map(); // id -> position last tick
    let blockUntil = 0;
    let blockFrom = null;
    bot.on("physicsTick", () => {
        if (!bot.entity) return;
        if (!hasShield()) {
            flying.clear();
            if (arrowComing) {
                arrowComing = false;
                applyShield();
            }
            return;
        }
        // (drawing its bow or eating: that goes on; it's not dropped for a shield)
        if (bot.usingHeldItem && !shieldUp) return;
        const me = bot.entity.position.offset(0, 1, 0);
        let soonest = null;
        for (const e of Object.values(bot.entities)) {
            if (!e.position || !PROJECTILES.test(e.name || "")) continue;
            const last = flying.get(e.id);
            const now = e.position.clone();
            flying.set(e.id, now);
            if (!last) continue;
            const v = now.minus(last);
            const speed2 = v.dot(v);
            if (speed2 < 0.04) continue; // stuck in something, or falling at the end
            const rel = me.minus(now);
            const t = rel.dot(v) / speed2; // ticks till it's nearest
            if (t <= 0 || t > 9) continue;
            if (rel.minus(v.scaled(t)).norm() > 1.5) continue; // goes wide
            if (!soonest || t < soonest.t) soonest = { t, from: now };
        }
        if (flying.size > 64) for (const id of flying.keys()) if (!bot.entities[id]) flying.delete(id);
        if (soonest) {
            blockUntil = Date.now() + soonest.t * 50 + 150;
            blockFrom = soonest.from;
        }
        // And one being drawn at it: a full bow's arrow comes 3 blocks a
        // tick, there in 4 ticks from 12 blocks off, too soon to get a
        // shield up once it's seen in the air. So up while they draw.
        const archer = drawingAtMe();
        if (archer && !soonest) {
            blockUntil = Math.max(blockUntil, Date.now() + 150);
            blockFrom = archer.position.offset(0, 1.5, 0);
        }
        const coming = Date.now() < blockUntil;
        if (coming) {
            bot.lookAt(blockFrom, true).catch(() => {});
            // Walking somewhere: it stops for that moment (it's facing the
            // arrow, so it would walk off that way), and carries on after.
            if (bot.pathfinder.isMoving()) for (const c of ["forward", "back", "left", "right", "sprint", "jump"]) bot.setControlState(c, false);
        }
        arrowComing = coming;
        applyShield(); // (also back up after its own swing, if still wanted)
    });

    function rangedNearby(radius = 16) {
        const me = bot.entity.position;
        return Object.values(bot.entities).some(
            (e) => RANGED.has(e.name) && e.position.distanceTo(me) <= radius
        );
    }

    // ---------- melee ----------

    // Attack `mob` until it dies (or it leaves `maxDistance`, or time runs out).
    // `leash` ({ entity, radius }) stops the fight if we get dragged too far
    // from someone (used by bodyguard mode).
    function offLeash(leash) {
        return Boolean(leash?.entity?.position && leash.entity.position.distanceTo(bot.entity.position) > leash.radius);
    }

    // `defend`: only while it's coming for us. Stop once it's out of sight, or
    // can't be got to without digging, and hasn't hurt us lately.
    async function attack(mob, { timeoutMs = 30000, maxDistance = Infinity, style = "fast", leash = null, defend = false } = {}) {
        if (style === "bow") return ctx.shoot(mob, { timeoutMs, maxDistance, leash });
        if (mob.type === "player") return duel(mob, { timeoutMs: Math.max(timeoutMs, 60000), maxDistance, leash, defend });
        if (FLYERS.has(mob.name)) return skyFight(mob, { timeoutMs, leash });
        const before = ctx.interrupts;
        let seen = Date.now();
        let closest = Infinity;
        let closer = Date.now();
        ctx.target = mob;
        const weapon = await equipWeapon();
        const cooldownMs = 1000 / weapon.speed;
        const follow = new goals.GoalFollow(mob, fightDistance(style));
        bot.pathfinder.setGoal(follow, true);
        const start = Date.now();
        let lastSwing = 0;
        let backing = false;
        try {
            while (mob.isValid && bot.entities[mob.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > timeoutMs) throw new Error(`couldn't kill the ${mob.name} in time`);
                const distance = mob.position.distanceTo(bot.entity.position);
                if (distance > maxDistance || offLeash(leash)) return; // it left, or we strayed
                if (defend) {
                    if (canSee(mob)) seen = Date.now();
                    // In reach, or getting closer: it can be got to.
                    if (inReach(mob, 0.5) || distance < closest - 0.5) {
                        closest = distance;
                        closer = Date.now();
                    }
                    if (!hurtMe(mob, 5000)) {
                        if (Date.now() - seen > 3000) throw new Error(`the ${mob.name} went out of sight; leaving it`);
                        if (!inReach(mob, 0.5) && Date.now() - closer > 6000) throw new Error(`can't get to the ${mob.name} without digging; leaving it`);
                    }
                }
                if (isHostile(mob) && bot.health <= config.fleeHealth) {
                    raiseShield(false);
                    await ctx.during("Too hurt: backing off to eat", () => retreat(mob));
                    throw new Error(`too hurt to keep fighting the ${mob.name}`);
                }

                // Block arrows while closing in on ranged mobs.
                raiseShield(!inReach(mob, 0.5) && (RANGED.has(mob.name) || rangedNearby()));

                // Going for crits: never throw a plain swing mid-jump.
                const airborne = style === "crit" && !bot.entity.onGround && !bot.entity.isInWater;
                // The mob closer than it needs to be: step back, facing it, so
                // it can't hit first (if there's safe ground behind). While
                // the weapon recharges; and for a crit (a jump: the mob walks
                // in meanwhile) until it's back at a comfortable distance.
                const keepOff = !airborne && isHostile(mob) && distance < fightDistance(style) - 1 && (style === "crit" || Date.now() - lastSwing < cooldownMs) && room(mob);
                if (keepOff && !backing) {
                    backing = true;
                    bot.pathfinder.setGoal(null);
                } else if (!keepOff && backing) {
                    backing = false;
                    bot.setControlState("back", false);
                    bot.pathfinder.setGoal(follow, true);
                }
                if (backing) {
                    await bot.lookAt(aimPoint(mob), true);
                    bot.setControlState("back", true);
                }

                // Only what it can see: no hitting through a wall.
                if (!airborne && !backing && inReach(mob) && Date.now() - lastSwing >= cooldownMs && canSee(mob)) {
                    raiseShield(false);
                    if (backing) {
                        backing = false;
                        bot.setControlState("back", false);
                    }
                    if (style === "crit" && !bot.entity.isInWater) {
                        await critSwing(mob);
                        bot.pathfinder.setGoal(follow, true);
                    } else {
                        if (!mob.isValid) break;
                        await bot.lookAt(aimPoint(mob), true);
                        lowerForSwing();
                        bot.attack(mob);
                    }
                    lastSwing = Date.now();
                    if (style === "kite") {
                        bot.pathfinder.setGoal(null);
                        bot.setControlState("back", true);
                        await bot.waitForTicks(5);
                        bot.setControlState("back", false);
                        bot.pathfinder.setGoal(follow, true);
                    }
                }
                await bot.waitForTicks(1);
            }
            learn.count("kills");
        } finally {
            raiseShield(false);
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            ctx.target = null;
        }
    }

    // A player: they reach 3 blocks, and it reaches further (attackReach, 5
    // by default; the server allows 6). So it keeps off at about 4.6 (eyes to
    // their hitbox): too far for them to hit, close enough for it. Coming in
    // closer, they're backed away from (facing them, while there's safe
    // ground behind); drifting out, it steps in, without sprinting (that
    // spoils a crit). Each time its weapon is ready, it jumps and hits on
    // the way down: a critical hit, half as much again. It used to stand
    // where it was once in reach, swinging, and trade hits.
    async function duel(foe, { timeoutMs, maxDistance, leash, defend }) {
        const before = ctx.interrupts;
        const start = Date.now();
        let seen = Date.now();
        ctx.target = foe;
        const weapon = await equipWeapon();
        const cooldownMs = 1000 / weapon.speed;
        const reach = attackReach();
        // (with a short attackReach it can't outreach them: then just in its own reach)
        const spacing = reach >= REACH + 1 ? Math.max(REACH + 1, reach - 0.4) : reach - 0.4;
        const chase = new goals.GoalFollow(foe, Math.max(2, spacing - 0.5));
        let chasing = false;
        let lastSwing = 0;
        let lastR = null;
        let closing = 0;
        const move = (dir) => {
            bot.setControlState("sprint", false);
            bot.setControlState("forward", dir === "in");
            bot.setControlState("back", dir === "out");
        };
        try {
            while (foe.isValid && bot.entities[foe.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > timeoutMs) throw new Error(`couldn't beat ${foe.username || "the player"} in time`);
                const distance = foe.position.distanceTo(bot.entity.position);
                if (distance > maxDistance || offLeash(leash)) return; // they left, or we strayed
                if (canSee(foe)) seen = Date.now();
                if (defend && !hurtMe(foe, 5000) && Date.now() - seen > 3000) throw new Error(`${foe.username || "the player"} went out of sight; leaving them`);
                // Fighting back (not guarding anyone): once they've stopped hitting it and gone off, it lets them go.
                if (!ctx.ward && !hurtMe(foe, 15000) && reachTo(foe) > attackReach() + 3) return;
                if (bot.health <= config.fleeHealth) {
                    move(null);
                    await ctx.during("Too hurt: backing off to eat", () => retreat(foe));
                    throw new Error(`too hurt to keep fighting ${foe.username || "the player"}`);
                }
                const r = reachTo(foe);
                // How fast they're closing in (blocks a tick, smoothed).
                if (lastR !== null) closing = 0.3 * closing + 0.7 * (lastR - r);
                lastR = r;
                if (r > reach + 3 || !canSee(foe)) {
                    // Well out of reach (or round a corner): go after them.
                    if (!chasing) {
                        move(null);
                        bot.pathfinder.setGoal(chase, true);
                        chasing = true;
                    }
                } else {
                    if (chasing) {
                        bot.pathfinder.setGoal(null);
                        chasing = false;
                    }
                    await bot.lookAt(aimPoint(foe), true);
                    // Keeping its distance, the crit jumps included (they
                    // take half a second, in which they'd walk right up);
                    // not walking at them when they're coming anyway. With
                    // its weapon nearly ready and them coming in, it backs
                    // off, so its jump carries it away from them, not on.
                    const soon = Date.now() >= lastSwing + cooldownMs - 500;
                    if (r < spacing - 0.3 && room(foe)) move("out");
                    else if (soon && closing > 0.02 && room(foe)) move("out");
                    else if (r > spacing + 0.4 && closing < 0.05 && !soon) move("in");
                    else move(null);
                    // A crit lands about 7 ticks after the jump, and they
                    // keep coming meanwhile: jump that much early, so it
                    // lands as they come into reach (not once they're at
                    // arm's length), and as the weapon's recharged.
                    const ready = lastSwing + cooldownMs;
                    const water = bot.entity.isInWater;
                    const willBe = water ? r : r - Math.max(0, closing) * CRIT_TICKS;
                    // Them about to be in their reach (3): shield up (it
                    // takes a quarter of a second to come up, so a little
                    // ahead), crit jumps included; it only comes down for
                    // the moment of its own swing. Not against an axe, which
                    // knocks a shield out for 5 s: it keeps backing off from
                    // that instead.
                    const axe = /_axe$/.test(foe.heldItem?.name || "");
                    raiseShield(!axe && r < REACH + 0.6 + Math.max(0, closing) * 5);
                    if (Date.now() >= ready - (water ? 0 : CRIT_TICKS * 50) && willBe <= reach - 0.3) {
                        const hit = water ? (inReach(foe) ? (lowerForSwing(), bot.attack(foe), true) : false) : await critSwing(foe, { moving: true, notBefore: ready });
                        if (hit) lastSwing = Date.now();
                        continue;
                    }
                }
                await bot.waitForTicks(1);
            }
            learn.count("kills");
        } finally {
            raiseShield(false);
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            ctx.target = null;
        }
    }

    // A phantom (or vex): it can't be walked to, it comes to you. It used to
    // be left alone (circling overhead, it was too far above to count), and
    // fought like a zombie when it dived (walking after it, then giving it
    // up as out of reach once it climbed away again). Now it stands its
    // ground facing it, shield up as it comes in, and hits it when it's in
    // reach; once it's climbed away (16 blocks off for 2 s) it goes back to
    // what it was doing, until the next dive.
    async function skyFight(mob, { timeoutMs, leash }) {
        const before = ctx.interrupts;
        const start = Date.now();
        ctx.target = mob;
        const weapon = await equipWeapon();
        const cooldownMs = 1000 / weapon.speed;
        let lastSwing = 0;
        let lastD = null;
        let awaySince = null;
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        try {
            while (mob.isValid && bot.entities[mob.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > Math.max(timeoutMs, 30000) || offLeash(leash)) return;
                if (bot.health <= config.fleeHealth) throw new Error(`too hurt to keep fighting the ${mob.name}`);
                const d = mob.position.distanceTo(bot.entity.position);
                const coming = lastD !== null && d < lastD - 0.05;
                lastD = d;
                if (d > 16) {
                    awaySince = awaySince ?? Date.now();
                    if (Date.now() - awaySince > 2000) return; // gone back up: back to work till it dives again
                } else awaySince = null;
                await bot.lookAt(aimPoint(mob), true);
                const ready = Date.now() - lastSwing >= cooldownMs;
                raiseShield(coming && d < 8 && !(ready && inReach(mob)));
                if (ready && inReach(mob) && canSee(mob)) {
                    lowerForSwing();
                    bot.attack(mob);
                    lastSwing = Date.now();
                }
                await bot.waitForTicks(1);
            }
            learn.count("kills");
        } finally {
            raiseShield(false);
            bot.clearControlStates();
            ctx.target = null;
        }
    }

    // Safe ground for two steps straight back from the mob.
    function room(mob) {
        const me = bot.entity.position;
        const away = me.minus(mob.position);
        away.y = 0;
        const n = away.norm();
        if (n < 0.01) return false;
        const dir = away.scaled(1 / n);
        for (let i = 1; i <= 2; i++) {
            const p = me.plus(dir.scaled(i)).floored();
            const feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), floor = bot.blockAt(p.offset(0, -1, 0));
            if (!feet || !head || !floor) return false;
            if (feet.boundingBox !== "empty" || head.boundingBox !== "empty" || floor.boundingBox !== "block") return false;
            if (/lava|fire|magma|cactus|sweet_berry/.test(floor.name + feet.name)) return false;
        }
        return true;
    }

    function aimPoint(mob) {
        return mob.position.offset(0, (mob.height || 1.6) * 0.6, 0);
    }

    // A critical hit (+50% damage) needs the hit to land while falling after a
    // jump, and not while sprinting. So: stop chasing and sprinting, jump, and
    // swing on the way down if it's still in reach (otherwise a normal hit).
    // (`moving`: carry on stepping back or in meanwhile, only not sprinting;
    // `notBefore`: not until then, the weapon's recharged, if still falling.)
    // True if it swung.
    async function critSwing(mob, { moving = false, notBefore = 0 } = {}) {
        bot.pathfinder.setGoal(null);
        if (moving) {
            bot.setControlState("sprint", false);
            bot.setControlState("forward", false); // (never on into them)
        }
        else bot.clearControlStates(); // also stops sprinting, which cancels crits
        await bot.lookAt(aimPoint(mob), true);
        await bot.waitForTicks(1); // let the server see we stopped sprinting
        bot.setControlState("jump", true);
        await bot.waitForTicks(1);
        bot.setControlState("jump", false);
        for (let i = 0; i < 12; i++) {
            if (!mob.isValid) return;
            if (!bot.entity.onGround && bot.entity.velocity.y < -0.05) break; // on the way down
            if (bot.entity.onGround && i > 2) break; // the jump didn't happen (ceiling, water)
            await bot.waitForTicks(1);
        }
        // The server decides from our position updates, so let it see us drop first.
        if (!bot.entity.onGround) await bot.waitForTicks(1);
        while (Date.now() < notBefore && !bot.entity.onGround) await bot.waitForTicks(1);
        if (!mob.isValid || !inReach(mob, 0.3)) return false;
        await bot.lookAt(aimPoint(mob), true);
        lowerForSwing();
        bot.attack(mob);
        return true;
    }

    // ---------- running away ----------

    // Mobs we ran from: never "ignored" afterwards like ones we gave up
    // chasing, or a creeper could walk up to a bot that went back to work.
    const fledFrom = new WeakSet();
    ctx.ranFrom = (mob) => fledFrom.has(mob);

    // Get away and stay away: run until it's `safe` blocks off or gone, not
    // for a fixed time (it used to stop after 6 seconds with the creeper still
    // close). Runs for a spot well away from it, re-aimed every 1.5 s, rather
    // than "away from the creeper" as a moving goal, which kept the pathfinder
    // re-planning and the bot stopping and starting. If the bot stops moving
    // (cornered, or no path), it sprint-jumps the most open way out.
    // 18 blocks: past the 16 a creeper follows a player for, so it gives up.
    async function flee(mob, { safe = 18, maxMs = 30000 } = {}) {
        ctx.log(`Running from ${mob.name}.`);
        fledFrom.add(mob);
        const start = Date.now();
        let aimedAt = 0;
        let lastHit = 0;
        let last = bot.entity.position.clone();
        let checkAt = Date.now() + 600;
        await equipWeapon().catch(() => {});
        try {
            while (mob.isValid && bot.entities[mob.id] && Date.now() - start < maxMs) {
                ctx.checkStop();
                const distance = mob.position.distanceTo(bot.entity.position);
                if (distance >= safe) break;
                // Too close to get away (it dropped into the hole the bot is in,
                // say): hit it while still trying to leave; knockback buys time.
                if (inReach(mob) && canSee(mob) && Date.now() - lastHit > 500) {
                    lastHit = Date.now();
                    await bot.lookAt(aimPoint(mob), true);
                    lowerForSwing();
                    bot.attack(mob);
                }
                // Digging or building its way out (of a pit, say): let it finish.
                const working = bot.pathfinder.isMining() || bot.pathfinder.isBuilding();
                if (!working && (Date.now() - aimedAt > 1500 || !bot.pathfinder.isMoving())) {
                    const dir = escapeDirection(mob);
                    const to = bot.entity.position.plus(dir.scaled(safe + 10));
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.floor(to.x), Math.floor(to.z)));
                    aimedAt = Date.now();
                }
                if (Date.now() >= checkAt) {
                    if (bot.entity.position.distanceTo(last) < 1 && !working) {
                        await dashFrom(mob);
                        aimedAt = 0;
                    }
                    last = bot.entity.position.clone();
                    checkAt = Date.now() + 600;
                }
                await bot.waitForTicks(2);
            }
        } finally {
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
        }
    }

    // The direction closest to "straight away from the mob" with room to run:
    // nothing to bump into for a few blocks and ground (not lava) underfoot.
    function escapeDirection(mob) {
        const me = bot.entity.position;
        const away = me.minus(mob.position);
        const base = Math.hypot(away.x, away.z) > 0.01 ? Math.atan2(away.z, away.x) : Math.random() * 2 * Math.PI;
        for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6]) {
            const dir = new Vec3(Math.cos(base + turn), 0, Math.sin(base + turn));
            if (roomToRun(me, dir, 3)) return dir;
        }
        return new Vec3(Math.cos(base), 0, Math.sin(base));
    }

    function roomToRun(me, dir, blocks) {
        for (let i = 1; i <= blocks; i++) {
            const p = me.plus(dir.scaled(i)).floored();
            const feet = bot.blockAt(p);
            const head = bot.blockAt(p.offset(0, 1, 0));
            const floor = bot.blockAt(p.offset(0, -1, 0));
            if (!feet || !head || !floor) return false; // not loaded: can't go there
            if (feet.boundingBox !== "empty" || head.boundingBox !== "empty") return false;
            if (/lava|fire|magma/.test(floor.name) || /lava|fire/.test(feet.name)) return false;
        }
        return true;
    }

    async function dashFrom(mob, ticks = 12) {
        bot.pathfinder.setGoal(null);
        const me = bot.entity.position;
        const dir = escapeDirection(mob);
        await bot.lookAt(me.offset(dir.x * 5, bot.entity.eyeHeight ?? 1.62, dir.z * 5), true);
        bot.setControlState("forward", true);
        bot.setControlState("sprint", true);
        bot.setControlState("jump", true);
        try {
            await bot.waitForTicks(ticks);
        } finally {
            bot.clearControlStates();
        }
    }

    // Back off and eat something to recover.
    async function retreat(mob) {
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 16)), true);
        await ctx.wait(2500);
        const food = ctx.bestFood?.(true, true);
        if (food) {
            try {
                await bot.equip(food, "hand");
                await bot.consume();
            } catch (err) {
                // interrupted
            }
        }
        await ctx.wait(1500);
        bot.pathfinder.setGoal(null);
    }

    // ---------- fight with learning ----------

    // What works depends on what we're holding (crits pay off with a sword,
    // not with bare hands), so styles are learned per mob *and* weapon type.
    function combatContext(mob) {
        const weapon = bestWeapon().name || "fist";
        const kind = weapon.endsWith("_sword") ? "sword" : weapon.endsWith("_axe") ? "axe" : weapon === "fist" ? "fist" : "other";
        return `combat:${mob.name}:${kind}`;
    }

    // Pick a fighting style for this mob type, fight, and score the result.
    // Pick how to deal with `mob`: run, shoot, or the learned melee style.
    function chooseStyle(mob) {
        const distance = mob.position.distanceTo(bot.entity.position);
        const bow = Boolean(ctx.hasBow?.());
        const context = combatContext(mob) + (bow ? "+bow" : "");
        if (mob.name === "warden") return { style: "flee", context };
        if (kb.FLEE_FROM.has(mob.name)) {
            // Creepers: shoot them before they get close, otherwise run.
            return { style: bow && distance > 4 ? "bow" : "flee", context };
        }
        if (bot.health <= config.fleeHealth) return { style: "flee", context };
        if (bow && distance > 10) return { style: "bow", context }; // not worth walking over
        if (mob.type === "player") return { style: "duel", context }; // (not learned: see duel())
        if (FLYERS.has(mob.name)) return { style: "sky", context }; // (nor this: see skyFight())
        return { style: learn.choose(context, bow ? [...STYLES, "bow"] : STYLES), context };
    }

    async function fight(mob, { maxDistance = config.defendRadius * 2, leash = null } = {}) {
        const startHealth = bot.health;
        const deathsBefore = ctx.deaths;
        const { style, context } = chooseStyle(mob);
        let won = false;
        const who = mob.type === "player" ? mob.username : `a ${ctx.pretty(mob.name)}`;
        const step = style === "flee" ? `Running from ${who}` : `Fighting ${who}${style === "bow" ? " with my bow" : ""}`;
        try {
            await ctx.during(step, () => fightAs(style, mob, maxDistance, leash));
            won = style !== "flee" && !mob.isValid;
        } catch (err) {
            if (err instanceof ctx.Stopped) throw err;
            ctx.log(err.message);
        } finally {
            if (!["flee", "duel", "sky"].includes(style)) {
                const died = ctx.deaths > deathsBefore;
                const damage = Math.max(0, startHealth - bot.health);
                const score = died ? 0 : won ? Math.max(0.1, 1 - damage / 20) : 0.2;
                learn.reward(context, style, score);
            }
            if (bot.health < startHealth - 4) learn.addDanger(bot.entity.position, 0.5);
        }
        return won;
    }

    // Fighting back, it doesn't dig its way to the mob: that would be going
    // looking for a fight (running away still may).
    async function fightAs(style, mob, maxDistance, leash) {
        if (style === "flee") {
            await flee(mob);
            return;
        }
        ctx.log(`Fighting ${mob.type === "player" ? mob.username : mob.name} (${style}).`);
        const movements = bot.pathfinder.movements;
        const canDig = movements.canDig;
        movements.canDig = false;
        try {
            await attack(mob, { timeoutMs: style === "bow" ? 40000 : 20000, maxDistance, style, leash, defend: true });
        } finally {
            movements.canDig = canDig;
        }
    }

    // Hunting: animals always get critical hits (fewer swings, less chasing);
    // hostile mobs use (and teach) the learned fighting style. Errors propagate
    // so the hunt can move on.
    async function huntMob(mob) {
        if (!isHostile(mob)) return attack(mob, { style: "crit" });
        const { style, context } = chooseStyle(mob);
        if (style === "flee") throw new Error(`not fighting a ${mob.name}`);
        const startHealth = bot.health;
        const deathsBefore = ctx.deaths;
        try {
            await attack(mob, { style });
            learn.reward(context, style, Math.max(0.1, 1 - Math.max(0, startHealth - bot.health) / 20));
        } catch (err) {
            if (err.message !== "interrupted" && !(err instanceof ctx.Stopped)) {
                learn.reward(context, style, ctx.deaths > deathsBefore ? 0 : 0.2);
            }
            throw err;
        }
    }

    // ---------- fire ----------

    function onFire() {
        return Boolean(bot.entity?.metadata?.[0] & 0x01);
    }

    // Put out fire with a water bucket, then scoop the water back up.
    async function extinguish() {
        if (extinguishing || !onFire() || bot.entity.isInWater) return;
        const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
        if (!bucket) return;
        extinguishing = true;
        try {
            const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
            if (!below || below.boundingBox !== "block") return;
            await bot.equip(bucket, "hand");
            await bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
            bot.activateItem();
            await bot.waitForTicks(10);
            const empty = bot.inventory.items().find((i) => i.name === "bucket");
            const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 3 });
            if (empty && water) {
                await bot.equip(empty, "hand");
                await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
                bot.activateItem();
            }
            ctx.log("Put out fire with water.");
        } catch (err) {
            ctx.log(`Couldn't put out fire: ${err.message}`);
        } finally {
            extinguishing = false;
        }
    }

    Object.assign(ctx, {
        FLYERS,
        canSee,
        hurtMe,
        reachTo,
        inReach,
        isHostile,
        offLeash,
        equipWeapon,
        equipArmor,
        attack,
        flee,
        fight,
        huntMob,
        onFire,
        extinguish,
    });
}

module.exports = { installCombat };
