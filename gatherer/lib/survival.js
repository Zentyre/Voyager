// Staying alive: fight back against hostile mobs, run from creepers or when
// low on health, and eat (hunting for food if there's none).

const { goals } = require("mineflayer-pathfinder");

const ARMOR_SLOTS = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet" };
const ARMOR_RANK = ["leather", "golden", "chainmail", "turtle", "iron", "diamond", "netherite"];

function armorInfo(name) {
    const match = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name || "");
    if (!match) return null;
    return { slot: ARMOR_SLOTS[match[2]], rank: ARMOR_RANK.indexOf(match[1]) };
}

const WEAPONS = [
    "netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "golden_sword", "wooden_sword",
    "netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "golden_axe", "wooden_axe",
];

function installSurvival(ctx) {
    const { bot, config, kb, planner } = ctx;
    let fighting = false;
    let seekingFood = false;
    const ignoreUntil = new Map(); // entity id -> timestamp

    function inDanger() {
        return ["survival", "adventure"].includes(bot.game?.gameMode);
    }

    function isHostile(entity) {
        return bot.registry.entitiesByName[entity.name]?.category === "Hostile mobs";
    }

    function isThreat(entity) {
        if (!entity?.position || entity === bot.entity || entity === ctx.target) return false;
        if (!isHostile(entity) || kb.DONT_PROVOKE.has(entity.name)) return false;
        if ((ignoreUntil.get(entity.id) || 0) > Date.now()) return false;
        const me = bot.entity.position;
        return (
            entity.position.distanceTo(me) <= config.defendRadius &&
            Math.abs(entity.position.y - me.y) < 4
        );
    }

    function nearestThreat() {
        const me = bot.entity.position;
        return Object.values(bot.entities)
            .filter(isThreat)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    }

    ctx.threatNearby = () =>
        config.defend !== false && Boolean(bot.entity) && inDanger() && Boolean(nearestThreat());

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

    async function equipWeapon() {
        for (const name of WEAPONS) {
            const item = bot.inventory.items().find((i) => i.name === name);
            if (item) return bot.equip(item, "hand").catch(() => {});
        }
    }

    // Attack `mob` until it dies. Used both for hunting and for self-defence.
    async function attack(mob, timeoutMs = 30000, maxDistance = Infinity) {
        const before = ctx.interrupts;
        ctx.target = mob;
        await equipWeapon();
        bot.pvp.attack(mob);
        const start = Date.now();
        try {
            while (mob.isValid && bot.entities[mob.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > timeoutMs) throw new Error(`couldn't catch the ${mob.name}`);
                if (mob.position.distanceTo(bot.entity.position) > maxDistance) return; // it left
                if (isHostile(mob) && bot.health <= config.fleeHealth) {
                    bot.pvp.stop();
                    await flee(mob);
                    throw new Error(`too hurt to keep fighting the ${mob.name}`);
                }
                await bot.waitForTicks(4);
            }
        } finally {
            bot.pvp.stop();
            ctx.target = null;
        }
    }

    async function flee(mob, ms = 6000) {
        ctx.log(`Running from ${mob.name}.`);
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 16)), true);
        await ctx.wait(ms);
        bot.pathfinder.setGoal(null);
    }

    async function fight(mob) {
        fighting = true;
        try {
            if (kb.FLEE_FROM.has(mob.name) || bot.health <= config.fleeHealth) {
                await flee(mob);
            } else {
                ctx.log(`Defending against ${mob.name}.`);
                await attack(mob, 20000, config.defendRadius * 2);
            }
        } catch (err) {
            if (err instanceof ctx.Stopped) throw err;
            ctx.log(err.message);
        } finally {
            fighting = false;
            // Don't keep chasing something we couldn't reach or had to run from.
            if (mob.isValid) ignoreUntil.set(mob.id, Date.now() + 20000);
        }
    }

    function bestFood(desperate) {
        return bot.inventory
            .items()
            .filter((i) => kb.isFood(i.name) && (desperate || !kb.BAD_FOOD.has(i.name)))
            .sort((a, b) => kb.foodPoints(b.name) - kb.foodPoints(a.name))[0];
    }

    async function maybeEat() {
        if (!inDanger()) return;
        const hungry = bot.food <= config.eatBelow || (bot.health < 12 && bot.food < 20);
        if (!hungry) return;
        let food = bestFood(bot.food <= 6);
        if (!food && bot.food <= config.findFoodBelow && config.hunt !== false) {
            seekingFood = true;
            try {
                const choice = planner.cheapestOf(kb.FOOD_SOURCES);
                if (choice && choice.cost < Infinity) {
                    ctx.say(`Hungry, going to get some ${choice.name}.`);
                    await ctx.obtain(choice.name, ctx.countItem(choice.name) + 3);
                }
            } catch (err) {
                if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                ctx.log(`Couldn't find food: ${err.message}`);
            } finally {
                seekingFood = false;
            }
            food = bestFood(true);
        }
        if (!food) return;
        try {
            await bot.equip(food, "hand");
            await bot.consume();
            ctx.log(`Ate ${food.name}.`);
        } catch (err) {
            ctx.log(`Couldn't eat: ${err.message}`);
        }
    }

    // Called between actions: deal with nearby mobs, then hunger.
    async function guard() {
        if (fighting || !bot.entity) return;
        await equipArmor();
        for (let i = 0; i < 8 && ctx.threatNearby(); i++) {
            await fight(nearestThreat());
        }
        if (!seekingFood) await maybeEat();
    }

    // Watch for mobs while busy, and look after ourselves while idle.
    let ticks = 0;
    let idleGuard = false;
    bot.on("physicsTick", () => {
        ticks++;
        if (ticks % 10 !== 0 || fighting) return;
        if (ctx.busy) {
            if (ctx.threatNearby()) ctx.stopCurrentAction();
        } else if (!idleGuard && (ticks % 40 === 0 || ctx.threatNearby())) {
            idleGuard = true;
            ctx.idleWork = guard()
                .catch((err) => ctx.log(err.message))
                .finally(() => (idleGuard = false));
        }
    });

    Object.assign(ctx, { guard, attack, eat: maybeEat, equipArmor });
}

module.exports = { installSurvival };
