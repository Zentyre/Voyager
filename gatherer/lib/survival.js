// Staying alive between and during tasks: react to mobs, put out fire, eat
// (finding food if there is none), and sleep through the night.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const GOOD_IN_A_PINCH = ["enchanted_golden_apple", "golden_apple"];

function installSurvival(ctx) {
    const { bot, config, kb, planner, learn } = ctx;
    let fighting = false;
    let seekingFood = false;
    let sleeping = false; // in bed (or walking to it)
    let bedtime = false; // anywhere inside sleep(), including fetching a bed
    let sleepRetryAt = 0;
    const ignoreUntil = new Map(); // entity id -> timestamp
    const waitedOut = new WeakSet(); // lurkers already waited on once
    const shotAt = new WeakMap(); // lurker -> times it tried shooting it

    function inDanger() {
        return ["survival", "adventure"].includes(bot.game?.gameMode);
    }

    function isThreat(entity) {
        if (!entity?.position || entity === bot.entity || entity === ctx.target) return false;
        if (!ctx.isHostile(entity) || kb.DONT_PROVOKE.has(entity.name)) return false;
        if ((ignoreUntil.get(entity.id) || 0) > Date.now()) return false;
        const me = bot.entity.position;
        // Creepers get noticed sooner (running needs a head start), and from
        // further above or below: one at the edge of the pit the bot is
        // digging in still blows it up.
        const flee = kb.FLEE_FROM.has(entity.name);
        const radius = flee ? Math.max(config.defendRadius, 12) : config.defendRadius;
        if (entity.position.distanceTo(me) > radius || Math.abs(entity.position.y - me.y) >= (flee ? 7 : 4)) return false;
        // Only what can get at us: in sight, or it just hurt us. A zombie on
        // the other side of the wall of the tunnel it's mining isn't a fight.
        return ctx.hurtMe(entity) || ctx.canSee(entity);
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

    // A mob we ran from that is still within 24 blocks.
    function lurking() {
        const me = bot.entity.position;
        return Object.values(bot.entities).find((e) => ctx.ranFrom?.(e) && e.isValid && e.position.distanceTo(me) < 24);
    }

    // A creeper (or warden) we ran from that would come for the bot again if it
    // went to `pos`: there, a creeper would see it (16 blocks), or the way
    // there passes it. Creepers don't burn in the day, so one standing by the
    // furnace can stay there for good.
    ctx.lurkerNear = (pos) => {
        const me = bot.entity.position;
        return Object.values(bot.entities).find(
            (e) => ctx.ranFrom?.(e) && kb.FLEE_FROM.has(e.name) && e.isValid && e.position && (e.position.distanceTo(pos) < 16 || fromLine(e.position, me, pos) < 8)
        );
    };
    // How far `p` is from the straight line from `a` to `b`.
    function fromLine(p, a, b) {
        const ab = b.minus(a);
        const len = ab.dot(ab);
        const t = len > 0 ? Math.max(0, Math.min(1, p.minus(a).dot(ab) / len)) : 0;
        return p.distanceTo(a.plus(ab.scaled(t)));
    }
    const goto = bot.pathfinder.goto.bind(bot.pathfinder);
    bot.pathfinder.goto = (goal, ...rest) => {
        const g = goal?.pos ?? goal;
        if (Number.isFinite(g?.x) && Number.isFinite(g?.z)) {
            const lurker = ctx.lurkerNear(new Vec3(g.x, Number.isFinite(g.y) ? g.y : bot.entity.position.y, g.z));
            if (lurker) return Promise.reject(new Error(`a ${ctx.pretty(lurker.name)} is waiting by there`));
        }
        return goto(goal, ...rest);
    };

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
        let ownBed = false; // put down for tonight: picked up again after
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
            ownBed = true;
        }
        if (!bed) throw new Error("no bed nearby");

        sleeping = true;
        try {
            const half = await ctx.act(() => reachBed(bed));
            await bot.sleep(half);
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
            if (ownBed) await pickUpBed(bed);
        }
    }

    // Break the bed it put down and take it along again.
    async function pickUpBed(bed) {
        await ctx.during("Picking up my bed", async () => {
            for (let i = 0; i < 40 && bot.isSleeping; i++) await ctx.wait(250);
            if (bot.isSleeping) await bot.wake().catch(() => {});
            const block = bot.blockAt(bed.position);
            if (!block?.name.endsWith("_bed")) return; // gone already
            try {
                if (block.position.distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) {
                    await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)), 20000);
                }
                await bot.dig(bot.blockAt(bed.position), true);
                await ctx.wait(400);
                await ctx.pickUpDrops(block.name, 6);
                learn.forget("block", [block.name], block.position);
                ctx.log(`Picked my ${ctx.pretty(block.name)} back up.`);
            } catch (err) {
                if (err instanceof ctx.Stopped) throw err;
                ctx.log(`Couldn't pick my bed back up: ${err.message}`);
            }
        });
    }

    // Stand where one half of the bed can be seen, and return that half. Being
    // close isn't enough: from behind a wall the click lands on the wall, and
    // the bot kept trying from there.
    async function reachBed(bed) {
        const halves = [bed, ...[[1, 0], [-1, 0], [0, 1], [0, -1]]
            .map(([dx, dz]) => bot.blockAt(bed.position.offset(dx, 0, dz)))
            .filter((b) => b && b.name === bed.name)];
        let lastError = null;
        for (const half of halves) {
            const goal = new goals.GoalLookAtBlock(half.position, bot.world, { reach: 3 });
            const before = ctx.interrupts;
            try {
                await ctx.during("Walking to the bed", () => ctx.withTimeout(bot.pathfinder.goto(goal), 30000));
                return half;
            } catch (err) {
                if (err instanceof ctx.Stopped || ctx.interrupts !== before) throw err; // a mob: deal with it, then retry
                lastError = err; // walled in on this side: try the other half
            }
        }
        throw new Error(`can't get to the bed (${lastError?.message || "no way there"})`);
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
        await ctx.breathe?.(); // air first
        await ctx.equipArmor();
        await ctx.extinguish();
        const waitUntil = Date.now() + 10000;
        for (;;) {
            for (let i = 0; i < 8 && ctx.threatNearby(); i++) {
                const mob = nearestThreat();
                fighting = true;
                try {
                    await ctx.fight(mob);
                } finally {
                    fighting = false;
                    // Don't keep chasing something we couldn't reach. Something we ran
                    // from (a creeper) stays a threat, so we run again if it follows.
                    if (mob.isValid && !ctx.ranFrom?.(mob)) ignoreUntil.set(mob.id, Date.now() + 20000);
                }
            }
            // Something we ran from still about (a creeper by the work): keep
            // away a few seconds for it to lose interest, instead of walking
            // straight back to it and running again; with a bow, shoot it from
            // here. Only mid-job; idle, there's no need. After that the job goes
            // on round it (it won't go near: lurkerNear).
            const lurker = ctx.busy && lurking();
            if (lurker && ctx.hasBow?.() && ctx.canSee(lurker) && (shotAt.get(lurker) || 0) < 2) {
                shotAt.set(lurker, (shotAt.get(lurker) || 0) + 1);
                fighting = true;
                try {
                    await ctx.fight(lurker, { maxDistance: 32 });
                } finally {
                    fighting = false;
                }
                continue;
            }
            if (!lurker || Date.now() >= waitUntil || waitedOut.has(lurker)) break;
            if (Date.now() + 1000 >= waitUntil) waitedOut.add(lurker); // once is enough
            await ctx.during(`Keeping away from the ${ctx.pretty(lurker.name)}`, () => ctx.wait(1000));
            ctx.checkStop();
        }
        if (!seekingFood) await maybeEat();
        await maybeSleep();
        await ctx.getOutOfWater?.();
    }

    // Watch for mobs and fire while busy; look after ourselves while idle.
    let ticks = 0;
    let idleGuard = false;
    bot.on("physicsTick", () => {
        ticks++;
        // Five times a second: a creeper closes 3 blocks in a second.
        if (ticks % 4 !== 0 || fighting || sleeping) return;
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
