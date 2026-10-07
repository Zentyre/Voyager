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

    function potionSlots() {
        return new Set(bot.inventory.items().filter((i) => i.name === "potion").map((i) => i.slot));
    }

    // Fill `count` glass bottles at a water source. Returns the inventory slots
    // of the new water bottles (all potions share the item name "potion", so
    // this is how we tell them apart from finished potions).
    async function fillBottles(count, seen) {
        const already = potionSlots();
        const before = ctx.countItem("potion");
        await ctx.obtain("glass_bottle", count, seen);
        for (let attempt = 0; ctx.countItem("potion") - before < count && attempt < count * 2 + 4; attempt++) {
            ctx.checkStop();
            const source = ctx.findWaterSource();
            if (!source) {
                await ctx.explore("block", ["water"]);
                continue;
            }
            await ctx.act(() => ctx.goTo(source.position, 3));
            const bottle = bot.inventory.items().find((i) => i.name === "glass_bottle");
            if (!bottle) break;
            await bot.equip(bottle, "hand");
            await bot.lookAt(source.position.offset(0.5, 0.9, 0.5), true);
            bot.activateItem();
            await bot.waitForTicks(4);
        }
        return [...potionSlots()].filter((slot) => !already.has(slot)).slice(0, count);
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

        // Gather everything first so we fail early on Nether-only items.
        for (const ing of ingredients) await ctx.obtain(ing, batches, seen);
        await ctx.obtain("blaze_powder", fuelNeeded, seen);
        const stand = await ctx.ensureStation("brewing_stand", seen);

        const done = learn.begin("brew", potion, count);
        let made = 0;
        try {
            for (let batch = 0; batch < batches; batch++) {
                const size = Math.min(3, count - made);
                const bottles = await fillBottles(size, seen);
                if (bottles.length < size) throw new Error("couldn't fill water bottles");

                await ctx.act(() => ctx.goTo(stand.position, 2));
                const window = await bot.openContainer(stand);
                try {
                    if (!window.slots[SLOT_FUEL]) await putIn(window, "blaze_powder", SLOT_FUEL);
                    for (let slot = 0; slot < size; slot++) {
                        if (!window.slots[slot]) await moveFromInventory(window, bottles[slot], slot);
                    }
                    for (const ing of ingredients) {
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
