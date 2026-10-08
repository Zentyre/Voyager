// Staying alive between and during tasks: react to mobs, put out fire, eat
// (finding food if there is none), and sleep through the night.

const GOOD_IN_A_PINCH = ["enchanted_golden_apple", "golden_apple"];

function installSurvival(ctx) {
    const { bot, config, kb, planner, learn } = ctx;
    let fighting = false;
    let seekingFood = false;
    let sleeping = false; // in bed (or walking to it)
    let bedtime = false; // anywhere inside sleep(), including fetching a bed
    let sleepRetryAt = 0;
    const ignoreUntil = new Map(); // entity id -> timestamp

    function inDanger() {
        return ["survival", "adventure"].includes(bot.game?.gameMode);
    }

    function isThreat(entity) {
        if (!entity?.position || entity === bot.entity || entity === ctx.target) return false;
        if (!ctx.isHostile(entity) || kb.DONT_PROVOKE.has(entity.name)) return false;
        if ((ignoreUntil.get(entity.id) || 0) > Date.now()) return false;
        const me = bot.entity.position;
        return (
            entity.position.distanceTo(me) <= config.defendRadius &&
            Math.abs(entity.position.y - me.y) < 4
        );
    }

    // Closest threat, with archers and creepers dealt with first.
    function nearestThreat() {
        const me = bot.entity.position;
        const urgency = (e) =>
            e.position.distanceTo(me) * (e.name === "creeper" ? 0.5 : /skeleton|stray|bogged/.test(e.name) ? 0.7 : 1);
        return Object.values(bot.entities)
            .filter(isThreat)
            .sort((a, b) => urgency(a) - urgency(b))[0];
    }

    ctx.threatNearby = () =>
        config.defend !== false && Boolean(bot.entity) && inDanger() && Boolean(nearestThreat());

    // ---------- food ----------

    function bestFood(desperate, healing = false) {
        const items = bot.inventory.items();
        if (healing) {
            const gold = items.find((i) => GOOD_IN_A_PINCH.includes(i.name));
            if (gold) return gold;
        }
        return items
            .filter((i) => kb.isFood(i.name) && !GOOD_IN_A_PINCH.includes(i.name))
            .filter((i) => desperate || !kb.BAD_FOOD.has(i.name))
            .sort((a, b) => kb.foodPoints(b.name) - kb.foodPoints(a.name))[0];
    }
    ctx.bestFood = bestFood;

    async function maybeEat() {
        if (!inDanger()) return;
        const hungry = bot.food <= config.eatBelow || (bot.health < 12 && bot.food < 20);
        if (!hungry) return;
        let food = bestFood(bot.food <= 6);
        // While guarding someone, eat what we carry; don't wander off for food.
        if (!food && bot.food <= config.findFoodBelow && !ctx.ward) {
            seekingFood = true;
            try {
                const choice = planner.cheapestOf(kb.FOOD_SOURCES);
                if (choice && choice.cost < Infinity) {
                    ctx.say(`Hungry, going to get some ${choice.name}.`);
                    await ctx.during(`Hungry: getting ${ctx.pretty(choice.name)}`, () =>
                        ctx.obtain(choice.name, ctx.countItem(choice.name) + 3)
                    );
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
            await ctx.during(`Eating ${ctx.pretty(food.name)}`, async () => {
                await bot.equip(food, "hand");
                await bot.consume();
            });
            ctx.log(`Ate ${food.name}.`);
        } catch (err) {
            ctx.log(`Couldn't eat: ${err.message}`);
        }
    }

    // ---------- sleep ----------

    function isNight() {
        const t = bot.time?.timeOfDay ?? 0;
        return (t >= 12542 && t <= 23459) || bot.thunderState > 0;
    }

    function inOverworld() {
        return String(bot.game?.dimension || "overworld").includes("overworld");
    }

    function bedNames() {
        return bot.registry.blocksArray.filter((b) => b.name.endsWith("_bed")).map((b) => b.name);
    }

    function findBed(radius) {
        const ids = bedNames().map((n) => bot.registry.blocksByName[n].id);
        const near = bot.findBlock({ matching: ids, maxDistance: Math.min(radius, 64) });
        if (near) return near;
        // A bed we remember from before (e.g. one we placed).
        for (const spot of learn.recall("block", bedNames(), bot.entity.position, radius)) {
            const block = bot.blockAt(new ctx.Vec3(spot.x, spot.y, spot.z));
            if (block && block.name.endsWith("_bed")) return block;
        }
        return null;
    }

    // Sleep in a bed nearby. With `getBed`, make and place one if needed.
    async function sleep(options = {}) {
        if (bedtime || sleeping || bot.isSleeping) return true;
        if (!inOverworld()) throw new Error("beds only work in the overworld");
        if (!isNight()) throw new Error("it isn't night");
        bedtime = true;
        try {
            return await goToBed(options);
        } finally {
            bedtime = false;
        }
    }

    async function goToBed({ getBed = false }) {
        let bed = findBed(config.stationRadius * 4);
        if (!bed && getBed) {
            let have = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
            if (!have) {
                const bedItems = Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith("_bed"));
                const choice = planner.cheapestOf(bedItems);
                if (!choice || choice.cost === Infinity) throw new Error("I can't make a bed");
                ctx.say(`Getting a ${choice.name} to sleep in.`);
                await ctx.obtain(choice.name, 1);
                have = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
            }
            bed = await ctx.during("Placing a bed", () => ctx.act(() => ctx.placeNearby(have.name)));
            learn.remember("block", bed.name, bed.position);
        }
        if (!bed) throw new Error("no bed nearby");

        sleeping = true;
        try {
            await ctx.act(() => ctx.goTo(bed.position, 2, "the bed"));
            await bot.sleep(bed);
            ctx.say("Sleeping.");
            learn.remember("block", bed.name, bed.position);
            await ctx.during("Sleeping", () => new Promise((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    bot.removeListener("wake", done);
                    resolve();
                };
                const timer = setTimeout(done, 120000);
                bot.once("wake", done);
            }));
            learn.count("nightsSlept");
            return true;
        } finally {
            sleeping = false;
        }
    }

    async function maybeSleep() {
        if (bedtime || ctx.ward || config.autoSleep === false || !isNight() || !inOverworld()) return;
        if (Date.now() < sleepRetryAt) return;
        if (!findBed(config.stationRadius * 4) && !config.bringBed) return;
        try {
            await sleep({ getBed: Boolean(config.bringBed) });
        } catch (err) {
            if (err instanceof ctx.Stopped) throw err;
            ctx.log(`Couldn't sleep: ${err.message}`);
            sleepRetryAt = Date.now() + 60000; // e.g. monsters nearby
        }
    }

    // ---------- guard ----------

    // Called between actions: armor, fire, mobs, hunger, bedtime.
    async function guard() {
        if (fighting || sleeping || !bot.entity) return;
        await ctx.equipArmor();
        await ctx.extinguish();
        for (let i = 0; i < 8 && ctx.threatNearby(); i++) {
            const mob = nearestThreat();
            fighting = true;
            try {
                await ctx.fight(mob);
            } finally {
                fighting = false;
                // Don't keep chasing something we couldn't reach or had to run from.
                if (mob.isValid) ignoreUntil.set(mob.id, Date.now() + 20000);
            }
        }
        if (!seekingFood) await maybeEat();
        await maybeSleep();
    }

    // Watch for mobs and fire while busy; look after ourselves while idle.
    let ticks = 0;
    let idleGuard = false;
    bot.on("physicsTick", () => {
        ticks++;
        if (ticks % 10 !== 0 || fighting || sleeping) return;
        if (ctx.onFire()) ctx.extinguish().catch(() => {});
        if (ctx.busy) {
            if (ctx.threatNearby()) ctx.stopCurrentAction();
        } else if (!idleGuard && (ticks % 40 === 0 || ctx.threatNearby())) {
            idleGuard = true;
            ctx.idleWork = guard()
                .catch((err) => ctx.log(err.message))
                .finally(() => (idleGuard = false));
        }
    });

    // Remember where we died, to stay away from there.
    bot.on("death", () => {
        ctx.deaths++;
        learn.count("deaths");
        if (bot.entity) learn.addDanger(bot.entity.position, 5);
    });

    Object.assign(ctx, { guard, eat: maybeEat, sleep, isNight });
}

module.exports = { installSurvival };
