// Brewing potions: fill water bottles, then run them through a brewing stand
// one ingredient at a time (water -> awkward -> healing -> ...).
//
// Brewing stand window slots: 0-2 bottles, 3 ingredient, 4 fuel (blaze powder).

const SLOT_INGREDIENT = 3;
const SLOT_FUEL = 4;
const BREWS_PER_BLAZE_POWDER = 20;

function installBrewing(ctx) {
    const { bot, config, kb, learn } = ctx;

    // Ingredients in order, from a water bottle to `potion` (+ modifier).
    function steps(potion, modifier) {
        const chain = [];
        let current = potion;
        while (current !== "water") {
            const recipe = kb.POTIONS[current];
            if (!recipe) throw new Error(`unknown potion ${current}`);
            chain.unshift(recipe.ingredient);
            current = recipe.base;
        }
        if (modifier) {
            const extra = kb.POTION_MODIFIERS[modifier];
            if (!extra) throw new Error(`unknown modifier ${modifier} (use long, strong, splash or lingering)`);
            chain.push(extra);
        }
        return chain;
    }

    // A water bottle: a "potion" whose contents are water (id 0 in the
    // game's potion list; finished potions have other ids).
    const WATER = 0;
    function isWaterBottle(item) {
        if (item?.name !== "potion") return false;
        const contents = item.componentMap?.get("potion_contents")?.data;
        if (contents) return contents.potionId === WATER;
        const nbt = item.nbt?.value?.Potion?.value; // before components (1.20.4 and older)
        return nbt === "minecraft:water";
    }
    const waterBottles = () => bot.inventory.items().filter(isWaterBottle);
    ctx.waterBottleCount = () => waterBottles().length;

    // `count` water bottles, using the ones in the bag first; only the rest
    // get filled, from empty bottles in the bag before any are made (making
    // them means glass, so sand and a furnace). Returns their slots.
    async function fillBottles(count, seen) {
        const short = () => count - waterBottles().length;
        if (short() > 0) {
            if (ctx.countItem("glass_bottle") < short()) await ctx.obtain("glass_bottle", short(), seen);
            ctx.doing(`Filling ${short()} water bottle${short() === 1 ? "" : "s"}`);
            for (let attempt = 0; short() > 0 && attempt < count * 2 + 4; attempt++) {
                ctx.checkStop();
                const source = ctx.findWaterSource();
                if (!source) {
                    await ctx.explore("block", ["water"], () => [ctx.findWaterSource()].filter(Boolean));
                    continue;
                }
                await ctx.act(() => ctx.goTo(source.position, 3, "the water"));
                const bottle = bot.inventory.items().find((i) => i.name === "glass_bottle");
                if (!bottle) break;
                await bot.equip(bottle, "hand");
                await bot.lookAt(source.position.offset(0.5, 0.9, 0.5), true);
                bot.activateItem();
                await bot.waitForTicks(4);
            }
        }
        return waterBottles().slice(0, count).map((i) => i.slot);
    }

    // Move `count` items of `name` from our inventory into a window slot.
    async function putIn(window, name, slot, count = 1) {
        for (let placed = 0; placed < count; placed++) {
            const source = window.items().find((i) => i.name === name);
            if (!source) throw new Error(`out of ${name}`);
            await bot.clickWindow(source.slot, 0, 0); // pick up stack
            await bot.clickWindow(slot, 1, 0); // drop one
            if (window.selectedItem) await bot.clickWindow(source.slot, 0, 0); // put the rest back
        }
    }

    // Move the single item in inventory slot `invSlot` into window slot `slot`.
    async function moveFromInventory(window, invSlot, slot) {
        const windowSlot = invSlot - bot.inventory.inventoryStart + window.inventoryStart;
        await bot.clickWindow(windowSlot, 0, 0);
        await bot.clickWindow(slot, 0, 0);
    }

    async function waitForBrew(window, timeoutMs = 30000) {
        const start = Date.now();
        while (window.slots[SLOT_INGREDIENT]) {
            ctx.checkStop();
            if (Date.now() - start > timeoutMs) throw new Error("brewing stand isn't brewing (out of fuel?)");
            await ctx.wait(1000);
        }
        await ctx.wait(500);
    }

    // Brew `count` potions of `potion` (e.g. "healing"), optionally long/strong/splash.
    async function brew(potion, count = 3, modifier = null, seen = new Set()) {
        const ingredients = steps(potion, modifier);
        const batches = Math.ceil(count / 3);
        const fuelNeeded = Math.ceil((ingredients.length * batches) / BREWS_PER_BLAZE_POWDER);
        ctx.say(`Brewing ${count} ${modifier ? modifier + " " : ""}${potion}: ${ingredients.join(" → ")}.`);

        // What it has already, and what it still has to get.
        const needs = new Map([["water bottle", count]]);
        for (const ing of ingredients) needs.set(ing, (needs.get(ing) || 0) + batches);
        needs.set("blaze_powder", (needs.get("blaze_powder") || 0) + fuelNeeded);
        const has = (name) => (name === "water bottle" ? waterBottles().length : ctx.countItem(name));
        const missing = [...needs].filter(([name, n]) => has(name) < n).map(([name, n]) => `${n - has(name)} ${name}`);
        const stationKnown = ctx.stationNearby("brewing_stand");
        if (!stationKnown) missing.push("a brewing stand");
        ctx.log(missing.length ? `For the potions I still need ${missing.join(", ")}.` : "I have everything for the potions.");

        // Gather everything first so we fail early on Nether-only items.
        ctx.doing("Gathering the ingredients");
        for (const ing of ingredients) await ctx.obtain(ing, needs.get(ing), seen);
        await ctx.obtain("blaze_powder", needs.get("blaze_powder"), seen);
        const stand = await ctx.ensureStation("brewing_stand", seen);

        const done = learn.begin("brew", potion, count);
        let made = 0;
        try {
            for (let batch = 0; batch < batches; batch++) {
                const size = Math.min(3, count - made);
                const bottles = await fillBottles(size, seen);
                if (bottles.length < size) throw new Error("couldn't fill water bottles");

                await ctx.act(() => ctx.goTo(stand.position, 2, "the brewing stand"));
                ctx.doing(`Brewing batch ${batch + 1}/${batches}`);
                const window = await bot.openBlock(stand); // openContainer only takes chests and the like
                try {
                    if (!window.slots[SLOT_FUEL]) await putIn(window, "blaze_powder", SLOT_FUEL);
                    for (let slot = 0; slot < size; slot++) {
                        if (!window.slots[slot]) await moveFromInventory(window, bottles[slot], slot);
                    }
                    for (const [i, ing] of ingredients.entries()) {
                        ctx.doing(`Brewing batch ${batch + 1}/${batches}: adding ${ctx.pretty(ing)} (${i + 1}/${ingredients.length})`);
                        await putIn(window, ing, SLOT_INGREDIENT);
                        await waitForBrew(window);
                    }
                    for (let slot = 0; slot < 3; slot++) {
                        if (window.slots[slot]) await bot.clickWindow(slot, 0, 1); // shift-click out
                    }
                } finally {
                    window.close();
                }
                made += size;
                learn.count("potions", size);
            }
            done(true);
        } catch (err) {
            done(err instanceof ctx.Stopped || err instanceof ctx.Retry ? null : false);
            throw err;
        }
        ctx.say(`Brewed ${made} ${potion} potion${made === 1 ? "" : "s"}.`);
    }

    function potionNames() {
        return Object.keys(kb.POTIONS);
    }

    Object.assign(ctx, { brew, potionNames, brewSteps: steps });
}

module.exports = { installBrewing };
