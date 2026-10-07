// Executes plans: mine, craft, smelt, hunt. `obtain` is the entry point; it
// asks the planner for the cheapest method and recurses into the inputs.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

function installActions(ctx) {
    const { bot, config, kb, planner } = ctx;

    // Make sure the inventory holds at least `target` of `name`.
    async function obtain(name, target, seen = new Set()) {
        if (ctx.countItem(name) >= target) return;
        if (seen.has(name)) throw new Error(`going in circles on ${name}`);
        if (!bot.registry.itemsByName[name]) throw new Error(`unknown item ${name}`);
        const next = new Set(seen).add(name);
        const plan = planner.plan(name, seen);
        const missing = target - ctx.countItem(name);
        ctx.log(`Need ${missing} more ${name}: ${plan.type}`);
        switch (plan.type) {
            case "mine":
                return mine(name, target, plan.blocks, next);
            case "craft":
                return craft(name, target, plan, next);
            case "smelt":
                return smelt(name, target, plan.input, next);
            case "hunt":
                return hunt(name, target, plan.mobs, next);
            default:
                throw new Error(`I don't know how to get ${name}`);
        }
    }

    // ---------- mining ----------

    async function mine(name, target, blocks, seen) {
        let exploreAttempts = 0;
        let failedDigs = 0;
        const skipped = new Set(); // blocks we could not reach or break
        while (ctx.countItem(name) < target) {
            ctx.checkStop();
            await ctx.guard();
            await makeRoom(name);

            const harvestable = blocks.filter(ctx.canHarvest);
            if (harvestable.length === 0) {
                const tool = planner.toolFor(blocks);
                if (!tool) throw new Error(`no tool I can make will mine ${name}`);
                ctx.say(`Getting a ${tool} to mine ${name}.`);
                await obtain(tool, 1, seen);
                continue;
            }

            const positions = bot
                .findBlocks({
                    matching: harvestable.map((b) => b.id),
                    maxDistance: config.searchRadius,
                    count: 64,
                })
                .filter((p) => !skipped.has(p.toString()) && !isProtected(p));
            if (positions.length === 0) {
                if (++exploreAttempts > config.maxExploreAttempts) {
                    throw new Error(`couldn't find any ${name} nearby`);
                }
                ctx.log(`No ${name} source in range, exploring (${exploreAttempts}/${config.maxExploreAttempts}).`);
                await exploreAndReplan(seen);
                continue;
            }
            exploreAttempts = 0;

            const block = bot.blockAt(positions[0]);
            const before = ctx.interrupts;
            let failure = null;
            try {
                await bot.collectBlock.collect(block, { ignoreNoPath: true });
            } catch (err) {
                failure = err.message;
            }
            ctx.checkStop();
            if (ctx.interrupts !== before) continue; // a mob showed up; try again
            // collectBlock swallows path errors, so check whether the block is gone.
            if (!failure && bot.blockAt(block.position)?.type === block.type) {
                failure = "unreachable";
            }
            if (failure) {
                skipped.add(block.position.toString());
                ctx.log(`Skipping ${block.name} at ${ctx.fmt(block.position)}: ${failure}`);
                if (++failedDigs > 10) throw new Error(`too many failures mining ${name}`);
            } else {
                failedDigs = 0;
            }
        }
    }

    function isProtected(pos) {
        const r = config.protectRadius;
        if (!r) return false;
        const anchors = [ctx.home, config.chest && new Vec3(config.chest.x, config.chest.y, config.chest.z)];
        return anchors.some((a) => a && a.distanceTo(pos) <= r);
    }

    // After wandering somewhere new, a different material may now be closer
    // (birch instead of oak), so sub-steps hand control back to re-plan.
    async function exploreAndReplan(seen) {
        await explore();
        const task = ctx.current;
        if (!task) return;
        task.explores = (task.explores || 0) + 1;
        if (task.explores > config.maxExploreAttempts * 3) {
            throw new Error("explored too long without finding what I need");
        }
        if (seen.size > 1) throw new ctx.Retry();
    }

    async function explore() {
        const angle = Math.random() * Math.PI * 2;
        const pos = bot.entity.position;
        const x = Math.floor(pos.x + Math.cos(angle) * config.exploreDistance);
        const z = Math.floor(pos.z + Math.sin(angle) * config.exploreDistance);
        await ctx.safely(() =>
            ctx.withTimeout(bot.pathfinder.goto(new goals.GoalXZ(x, z)), 60000)
        );
    }

    // ---------- crafting ----------

    async function craft(name, target, plan, seen) {
        const item = bot.registry.itemsByName[name];
        const perCraft = plan.recipe.result.count;
        const times = Math.ceil((target - ctx.countItem(name)) / perCraft);

        // Gathering one ingredient can use up another (sticks eat planks), so
        // loop until everything is in hand at once.
        for (let pass = 0; ; pass++) {
            ctx.checkStop();
            if (plan.recipe.requiresTable) await ensureStation("crafting_table", seen);
            for (const ing of plan.ingredients) {
                await obtain(ing.name, ing.count * times, seen);
            }
            const ready = plan.ingredients.every((ing) => ctx.countItem(ing.name) >= ing.count * times);
            if (ready) break;
            if (pass >= 4) throw new Error(`couldn't collect ingredients for ${name}`);
        }

        let table = null;
        if (plan.recipe.requiresTable) {
            table = await ensureStation("crafting_table", seen);
            await ctx.act(() => ctx.goTo(table.position, 2));
        }
        const recipe = bot.recipesFor(item.id, null, 1, table)[0];
        if (!recipe) throw new Error(`no usable recipe for ${name}`);
        await bot.craft(recipe, times, table);
        ctx.log(`Crafted ${times * perCraft} ${name}.`);
    }

    // Find a crafting table / furnace nearby, or make and place one.
    async function ensureStation(name, seen) {
        let block = ctx.findStation(name);
        if (block) return block;
        if (seen.has(name)) throw new Error(`need a ${name} to make a ${name}`);
        await obtain(name, 1, seen);
        block = await ctx.act(() => placeNearby(name));
        ctx.placedStations.push(block.position);
        ctx.say(`Placed a ${name} at ${ctx.fmt(block.position)}.`);
        return block;
    }

    async function placeNearby(name) {
        const item = bot.inventory.items().find((i) => i.name === name);
        if (!item) throw new Error(`no ${name} to place`);
        const feet = bot.entity.position.floored();
        const spots = bot
            .findBlocks({
                matching: (b) => b.boundingBox === "block",
                maxDistance: 3,
                count: 40,
            })
            .filter((p) => {
                const above = p.offset(0, 1, 0);
                if (above.equals(feet) || above.equals(feet.offset(0, 1, 0))) return false;
                return bot.blockAt(above)?.name === "air";
            })
            .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
        for (const pos of spots.slice(0, 6)) {
            try {
                await bot.equip(item, "hand");
                await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
                const placed = bot.blockAt(pos.offset(0, 1, 0));
                if (placed?.name === name) return placed;
            } catch (err) {
                ctx.log(`Couldn't place ${name} at ${ctx.fmt(pos)}: ${err.message}`);
            }
        }
        throw new Error(`no room to place a ${name}`);
    }

    // ---------- smelting ----------

    async function smelt(name, target, input, seen) {
        const amount = target - ctx.countItem(name);
        await obtain(input, amount, seen);
        const furnaceBlock = await ensureStation("furnace", seen);
        await ensureFuel(amount, input, seen);
        await obtain(input, amount, seen); // planks for fuel may have used up logs
        await ctx.act(() => ctx.goTo(furnaceBlock.position, 2));

        let furnace = await bot.openFurnace(furnaceBlock);
        try {
            if (furnace.outputItem()) await furnace.takeOutput();
            const leftover = furnace.inputItem();
            if (leftover && leftover.name !== input) await furnace.takeInput();

            await addFuel(furnace, amount, input);
            const inputItem = bot.registry.itemsByName[input];
            let toLoad = amount;
            // The input slot holds one stack; top it up as it empties.
            const loadInput = async () => {
                const n = Math.min(toLoad, 64 - (furnace.inputItem()?.count || 0), ctx.countItem(input));
                if (n <= 0) return;
                await furnace.putInput(inputItem.id, null, n);
                toLoad -= n;
            };
            await loadInput();

            ctx.say(`Smelting ${amount} ${input} into ${name}.`);
            let lastProgress = Date.now();
            while (ctx.countItem(name) < target) {
                ctx.checkStop();
                if (ctx.threatNearby()) {
                    furnace.close();
                    await ctx.guard();
                    await ctx.act(() => ctx.goTo(furnaceBlock.position, 2));
                    furnace = await bot.openFurnace(furnaceBlock);
                }
                if (furnace.outputItem()) {
                    await furnace.takeOutput();
                    await loadInput();
                    lastProgress = Date.now();
                    continue;
                }
                if (Date.now() - lastProgress > 15000) {
                    if (!furnace.fuelItem() && furnace.fuel <= 0) {
                        await addFuel(furnace, target - ctx.countItem(name), input);
                        lastProgress = Date.now();
                        continue;
                    }
                    throw new Error(`furnace stopped making ${name}`);
                }
                await ctx.wait(1000);
            }
            // Leave nothing behind in the furnace that we put in.
            if (furnace.inputItem()) await furnace.takeInput().catch(() => {});
        } finally {
            try {
                furnace.close();
            } catch (err) {
                // already closed
            }
        }
    }

    // Make sure we carry enough fuel to smelt `amount` items.
    async function ensureFuel(amount, input, seen) {
        if (ctx.fuelInInventory(input) >= amount) return;
        const planks = Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith("_planks"));
        const choice = planner.cheapestOf(["coal", ...planks]);
        if (!choice || choice.cost === Infinity) throw new Error("can't find any fuel");
        const missing = amount - ctx.fuelInInventory(input);
        const units = Math.ceil(missing / kb.fuelValue(choice.name));
        await obtain(choice.name, ctx.countItem(choice.name) + units, seen);
    }

    async function addFuel(furnace, amount, input) {
        let needed = amount - (furnace.fuelItem() ? kb.fuelValue(furnace.fuelItem().name) * furnace.fuelItem().count : 0);
        const fuels = bot.inventory
            .items()
            .filter((i) => i.name !== input && kb.fuelValue(i.name) > 0)
            .sort((a, b) => kb.fuelValue(b.name) - kb.fuelValue(a.name));
        for (const fuel of fuels) {
            if (needed <= 0) break;
            const current = furnace.fuelItem();
            if (current && current.name !== fuel.name) continue;
            const n = Math.min(fuel.count, Math.ceil(needed / kb.fuelValue(fuel.name)));
            await furnace.putFuel(fuel.type, null, n);
            needed -= n * kb.fuelValue(fuel.name);
        }
    }

    // ---------- hunting ----------

    async function hunt(name, target, mobs, seen) {
        let exploreAttempts = 0;
        const gaveUpOn = new Set(); // mobs we couldn't catch
        while (ctx.countItem(name) < target) {
            ctx.checkStop();
            await ctx.guard();
            await makeRoom(name);
            await ctx.act(() => pickUpDrops(name));
            if (ctx.countItem(name) >= target) break;

            const mob = nearestEntity(mobs, config.searchRadius, gaveUpOn);
            if (!mob) {
                if (++exploreAttempts > config.maxExploreAttempts) {
                    throw new Error(`couldn't find any ${mobs.join("/")} nearby`);
                }
                ctx.log(`No ${mobs.join("/")} in range, exploring (${exploreAttempts}/${config.maxExploreAttempts}).`);
                await exploreAndReplan(seen);
                continue;
            }
            exploreAttempts = 0;
            ctx.log(`Hunting ${mob.name} for ${name}.`);
            try {
                await ctx.act(() => ctx.attack(mob));
            } catch (err) {
                if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                ctx.log(err.message);
                gaveUpOn.add(mob.id);
                continue;
            }
            await ctx.wait(500); // let drops spawn
        }
    }

    function nearestEntity(names, radius, exclude = new Set()) {
        const pos = bot.entity.position;
        return Object.values(bot.entities)
            .filter((e) => names.includes(e.name) && !exclude.has(e.id))
            .filter((e) => e.position.distanceTo(pos) <= radius)
            .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0];
    }

    // Walk over dropped items (optionally only `name`) lying nearby.
    async function pickUpDrops(name, radius = 12) {
        const pos = bot.entity.position;
        const drops = Object.values(bot.entities)
            .filter((e) => e.name === "item" && e.position.distanceTo(pos) <= radius)
            .filter((e) => !name || e.getDroppedItem?.()?.name === name)
            .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));
        for (const drop of drops) {
            if (!drop.isValid) continue;
            await ctx.safely(() => ctx.withTimeout(ctx.goTo(drop.position, 1), 8000));
        }
    }

    // ---------- inventory ----------

    async function makeRoom(name) {
        if (bot.inventory.emptySlotCount() >= 2) return;
        if (!config.chest) throw new Error("inventory is full and no chest is configured");
        const before = ctx.countItem(name);
        await depositAll();
        if (ctx.countItem(name) < before) throw new ctx.Retry();
        if (bot.inventory.emptySlotCount() < 2) throw new Error("inventory is still full after unloading");
    }

    // Put the items we were asked to gather into the configured chest.
    async function depositAll() {
        const chestPos = new Vec3(config.chest.x, config.chest.y, config.chest.z);
        await ctx.act(() => ctx.goTo(chestPos, 2));
        const chestBlock = bot.blockAt(chestPos);
        if (!chestBlock || !chestBlock.name.includes("chest")) {
            ctx.say(`No chest at ${ctx.fmt(chestPos)}.`);
            return;
        }
        const chest = await bot.openContainer(chestBlock);
        try {
            const wanted = new Set(
                [ctx.current, ...ctx.queue, ...config.tasks].filter(Boolean).map((t) => t.item)
            );
            for (const item of bot.inventory.items()) {
                if (!wanted.has(item.name)) continue;
                try {
                    await chest.deposit(item.type, null, item.count);
                    if (ctx.current && item.name === ctx.current.item) {
                        ctx.current.deposited += item.count;
                    }
                } catch (err) {
                    ctx.say(`Chest is full: ${err.message}`);
                    break;
                }
            }
        } finally {
            chest.close();
        }
        ctx.log("Deposited items in chest.");
    }

    Object.assign(ctx, { obtain, depositAll, pickUpDrops, nearestEntity, explore });
}

module.exports = { installActions };
