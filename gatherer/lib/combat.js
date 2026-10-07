// Fighting: weapon and armor choice, a melee loop with attack cooldowns,
// critical hits and shield blocking, running away, and putting out fire.
// The fighting style used against each mob type is learned from experience.

const { goals } = require("mineflayer-pathfinder");

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
const STYLES = ["crit", "fast", "kite"];
const RANGED = new Set(["skeleton", "stray", "bogged", "pillager", "witch", "blaze"]);
const REACH = 3.0;

function armorInfo(name) {
    const match = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name || "");
    if (!match) return null;
    return { slot: ARMOR_SLOTS[match[2]], rank: ARMOR_RANK.indexOf(match[1]) };
}

function installCombat(ctx) {
    const { bot, config, kb, learn } = ctx;
    let shieldUp = false;
    let extinguishing = false;

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
        if (config.autoArmor === false) return;
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

    function raiseShield(up) {
        if (up && !shieldUp && hasShield()) {
            bot.activateItem(true);
            shieldUp = true;
        } else if (!up && shieldUp) {
            bot.deactivateItem();
            shieldUp = false;
        }
    }

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

    async function attack(mob, { timeoutMs = 30000, maxDistance = Infinity, style = "fast", leash = null } = {}) {
        if (style === "bow") return ctx.shoot(mob, { timeoutMs, maxDistance, leash });
        const before = ctx.interrupts;
        ctx.target = mob;
        const weapon = await equipWeapon();
        const cooldownMs = 1000 / weapon.speed;
        const follow = new goals.GoalFollow(mob, style === "kite" ? 2.5 : 1.5);
        bot.pathfinder.setGoal(follow, true);
        const start = Date.now();
        let lastSwing = 0;
        try {
            while (mob.isValid && bot.entities[mob.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > timeoutMs) throw new Error(`couldn't kill the ${mob.name} in time`);
                const distance = mob.position.distanceTo(bot.entity.position);
                if (distance > maxDistance || offLeash(leash)) return; // it left, or we strayed
                if (isHostile(mob) && bot.health <= config.fleeHealth) {
                    raiseShield(false);
                    await retreat(mob);
                    throw new Error(`too hurt to keep fighting the ${mob.name}`);
                }

                // Block arrows while closing in on ranged mobs.
                raiseShield(distance > REACH + 0.5 && (RANGED.has(mob.name) || rangedNearby()));

                // Going for crits: never throw a plain swing mid-jump.
                const airborne = style === "crit" && !bot.entity.onGround && !bot.entity.isInWater;
                if (!airborne && distance <= REACH + 0.2 && Date.now() - lastSwing >= cooldownMs) {
                    raiseShield(false);
                    if (style === "crit" && !bot.entity.isInWater) {
                        await critSwing(mob);
                        bot.pathfinder.setGoal(follow, true);
                    } else {
                        if (!mob.isValid) break;
                        await bot.lookAt(aimPoint(mob), true);
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

    function aimPoint(mob) {
        return mob.position.offset(0, (mob.height || 1.6) * 0.6, 0);
    }

    // A critical hit (+50% damage) needs the hit to land while falling after a
    // jump, and not while sprinting. So: stop chasing and sprinting, jump, and
    // swing on the way down if it's still in reach (otherwise a normal hit).
    async function critSwing(mob) {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates(); // also stops sprinting, which cancels crits
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
        if (!mob.isValid || mob.position.distanceTo(bot.entity.position) > REACH + 0.5) return;
        await bot.lookAt(aimPoint(mob), true);
        bot.attack(mob);
    }

    // ---------- running away ----------

    async function flee(mob, ms = 6000) {
        ctx.log(`Running from ${mob.name}.`);
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 16)), true);
        await ctx.wait(ms);
        bot.pathfinder.setGoal(null);
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
        return { style: learn.choose(context, bow ? [...STYLES, "bow"] : STYLES), context };
    }

    async function fight(mob, { maxDistance = config.defendRadius * 2, leash = null } = {}) {
        const startHealth = bot.health;
        const deathsBefore = ctx.deaths;
        const { style, context } = chooseStyle(mob);
        let won = false;
        try {
            if (style === "flee") {
                await flee(mob);
            } else {
                ctx.log(`Fighting ${mob.name} (${style}).`);
                await attack(mob, { timeoutMs: style === "bow" ? 40000 : 20000, maxDistance, style, leash });
                won = !mob.isValid;
            }
        } catch (err) {
            if (err instanceof ctx.Stopped) throw err;
            ctx.log(err.message);
        } finally {
            if (style !== "flee") {
                const died = ctx.deaths > deathsBefore;
                const damage = Math.max(0, startHealth - bot.health);
                const score = died ? 0 : won ? Math.max(0.1, 1 - damage / 20) : 0.2;
                learn.reward(context, style, score);
            }
            if (bot.health < startHealth - 4) learn.addDanger(bot.entity.position, 0.5);
        }
        return won;
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
