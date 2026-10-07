// Picks the cheapest way to get an item (mine, craft, smelt, or hunt) by
// scoring each option with a rough cost and recursing into its inputs.
// Plain search over game data plus the bot's own learned statistics (how long
// each method has taken, how often it failed, where things were seen before);
// no language model involved.

const COST = {
    mineVisible: 1,
    mineHidden: 6, // has to explore first
    mineRemembered: 3, // seen nearby before
    craft: 1,
    smelt: 2,
    huntVisible: 2,
    huntHidden: 7,
    huntRemembered: 4,
    harvestRipe: 2,
    waitForCrops: 10,
    newFarm: 15, // till, plant, then wait for it to grow
};
const MAX_DEPTH = 8;

// When nothing is in sight, prefer materials that are common in most worlds,
// so the bot goes looking for oak rather than pale oak or bamboo.
const RARE = [
    [/^(oak_log)$/, 0],
    [/^(birch|spruce)_log$/, 0.5],
    [/_log$|_stem$|bamboo/, 1.5],
];
function rarity(blocks) {
    return Math.min(
        ...blocks.map((b) => {
            const match = RARE.find(([pattern]) => pattern.test(b.name));
            return match ? match[1] : 0;
        })
    );
}
const MAX_EVALUATIONS = 4000;

function createPlanner(ctx) {
    const { bot, config, kb, learn } = ctx;
    const adjust = (type, name, base) => (learn ? learn.costAdjust(type, name, base) : base);

    function remembered(kind, names) {
        return Boolean(learn && bot.entity && learn.recall(kind, names, bot.entity.position).length);
    }

    let memo = new Map();
    let evaluations = 0;
    let visibleCache = new Map();

    function startSession() {
        memo = new Map();
        evaluations = 0;
        visibleCache = new Map();
    }

    function blockVisible(blocks) {
        const key = blocks.map((b) => b.id).join(",");
        if (!visibleCache.has(key)) {
            const found = bot.findBlock({
                matching: blocks.map((b) => b.id),
                maxDistance: config.searchRadius,
            });
            visibleCache.set(key, Boolean(found));
        }
        return visibleCache.get(key);
    }

    // "ripe", "growing", or null for crops of this kind nearby.
    function cropState(crop) {
        const key = "crop:" + crop.block;
        if (!visibleCache.has(key)) {
            const blocks = bot
                .findBlocks({
                    matching: bot.registry.blocksByName[crop.block].id,
                    maxDistance: config.searchRadius,
                    count: 64,
                })
                .map((pos) => bot.blockAt(pos))
                .filter(Boolean);
            const state = blocks.some(kb.isMatureCrop) ? "ripe" : blocks.length ? "growing" : null;
            visibleCache.set(key, state);
        }
        return visibleCache.get(key);
    }

    function waterVisible() {
        if (!visibleCache.has("water")) {
            const found = bot.findBlock({
                matching: bot.registry.blocksByName.water.id,
                maxDistance: config.searchRadius,
            });
            visibleCache.set("water", Boolean(found));
        }
        return visibleCache.get("water");
    }

    function mobVisible(names) {
        const pos = bot.entity?.position;
        if (!pos) return false;
        return Object.values(bot.entities).some(
            (e) => names.includes(e.name) && e.position.distanceTo(pos) <= config.searchRadius
        );
    }

    // Cost of having one more of `name`: 0 if already in inventory.
    function estimate(name, depth, seen) {
        if (ctx.countItem(name) > 0) return 0;
        return best(name, depth, seen).cost;
    }

    // Cheapest method for `name`, ignoring what is already in the inventory.
    function best(name, depth = 0, seen = new Set()) {
        if (memo.has(name)) return memo.get(name);
        const none = { type: "none", cost: Infinity };
        if (depth > MAX_DEPTH || seen.has(name) || ++evaluations > MAX_EVALUATIONS) {
            return none;
        }
        const path = new Set(seen).add(name);
        const options = [];

        // Mining
        const blocks = kb.blocksThatDrop(name);
        if (blocks.length > 0) {
            const harvestable = blocks.filter(ctx.canHarvest);
            let toolCost = 0;
            let tool = null;
            if (harvestable.length === 0) {
                for (const candidate of cheapestTools(blocks, depth, path)) {
                    if (candidate.cost < Infinity) {
                        tool = candidate.name;
                        toolCost = candidate.cost;
                        break;
                    }
                }
                if (!tool) toolCost = Infinity;
            }
            const base = blockVisible(blocks)
                ? COST.mineVisible
                : remembered("block", blocks.map((b) => b.name))
                  ? COST.mineRemembered
                  : COST.mineHidden + rarity(blocks);
            options.push({ type: "mine", cost: adjust("mine", name, base) + toolCost, blocks, tool });
        }

        // Crafting
        for (const recipe of kb.craftingRecipes(name)) {
            const ingredients = kb.recipeIngredients(recipe);
            let cost = adjust("craft", name, COST.craft);
            for (const ing of ingredients) cost += estimate(ing.name, depth + 1, path);
            if (recipe.requiresTable && !ctx.stationNearby("crafting_table")) {
                cost += estimate("crafting_table", depth + 1, path);
            }
            options.push({ type: "craft", cost, recipe, ingredients });
        }

        // Smelting
        for (const input of kb.smeltInputs(name)) {
            let cost = adjust("smelt", name, COST.smelt) + estimate(input, depth + 1, path);
            if (!ctx.stationNearby("furnace")) cost += estimate("furnace", depth + 1, path);
            if (ctx.fuelInInventory() === 0) cost += 1;
            options.push({ type: "smelt", cost, input });
        }

        // Farming
        const crop = kb.cropFor(name);
        if (crop) {
            const state = cropState(crop);
            let cost;
            if (state === "ripe") cost = adjust("farm", name, COST.harvestRipe);
            else if (state === "growing") cost = adjust("farm", name, COST.waitForCrops);
            else {
                // Potatoes and carrots are their own seed: need one to start.
                const seedCost =
                    crop.seed === name
                        ? ctx.countItem(name) > 0 ? 0 : Infinity
                        : estimate(crop.seed, depth + 1, path);
                const hoeCost = Math.min(...kb.HOES.map((hoe) => estimate(hoe, depth + 1, path)));
                // No water in sight: bring a bucket of it, if we know where water is.
                let waterCost = 0;
                if (!waterVisible()) {
                    if (config.placeWater === false) waterCost = Infinity;
                    else if (ctx.countItem("water_bucket") > 0) waterCost = 1;
                    else if (remembered("block", ["water"])) waterCost = 4 + estimate("bucket", depth + 1, path);
                    else waterCost = Infinity;
                }
                cost = adjust("farm", name, COST.newFarm) + seedCost + hoeCost + waterCost;
            }
            options.push({ type: "farm", cost, crop, state });
        }

        // Hunting
        const mobs = kb.mobsThatDrop(name);
        if (mobs.length > 0) {
            const base = mobVisible(mobs)
                ? COST.huntVisible
                : remembered("mob", mobs)
                  ? COST.huntRemembered
                  : COST.huntHidden;
            options.push({ type: "hunt", cost: adjust("hunt", name, base), mobs });
        }

        const result = options.reduce((a, b) => (b.cost < a.cost ? b : a), none);
        // Only remember finite answers; infinite ones may just be a cycle on this path.
        if (result.cost < Infinity) memo.set(name, result);
        return result;
    }

    // Harvest tools for these blocks, cheapest first.
    function cheapestTools(blocks, depth, seen) {
        const names = new Set(blocks.flatMap(kb.harvestTools));
        return [...names]
            .map((name) => ({ name, cost: estimate(name, depth + 1, seen) }))
            .sort((a, b) => a.cost - b.cost);
    }

    function cheapestOf(names) {
        startSession();
        return names
            .map((name) => ({ name, cost: estimate(name, 0, new Set()) }))
            .sort((a, b) => a.cost - b.cost)[0];
    }

    function plan(name, seen = new Set()) {
        startSession();
        return best(name, 0, seen);
    }

    function toolFor(blocks) {
        startSession();
        return cheapestTools(blocks, 0, new Set()).find((t) => t.cost < Infinity)?.name;
    }

    // Human-readable dry run of the plan for `name`.
    function explain(name, indent = "", seen = new Set(), lines = [], shown = new Set()) {
        if (lines.length > 40) return lines;
        if (shown.has(name)) {
            lines.push(`${indent}${name}: (as above)`);
            return lines;
        }
        shown.add(name);
        if (ctx.countItem(name) > 0) {
            lines.push(`${indent}${name}: have ${ctx.countItem(name)}`);
            return lines;
        }
        const p = plan(name, seen);
        const next = new Set(seen).add(name);
        const sub = indent + "  ";
        switch (p.type) {
            case "mine":
                lines.push(`${indent}${name}: mine ${p.blocks.map((b) => b.name).join("/")}`);
                if (p.tool) explain(p.tool, sub, next, lines, shown);
                break;
            case "craft":
                lines.push(
                    `${indent}${name}: craft from ${p.ingredients.map((i) => `${i.count} ${i.name}`).join(", ")}` +
                        (p.recipe.requiresTable ? " (crafting table)" : "")
                );
                if (p.recipe.requiresTable && !ctx.stationNearby("crafting_table")) {
                    explain("crafting_table", sub, next, lines, shown);
                }
                for (const ing of p.ingredients) explain(ing.name, sub, next, lines, shown);
                break;
            case "smelt":
                lines.push(`${indent}${name}: smelt ${p.input}`);
                if (!ctx.stationNearby("furnace")) explain("furnace", sub, next, lines, shown);
                explain(p.input, sub, next, lines, shown);
                break;
            case "hunt":
                lines.push(`${indent}${name}: hunt ${p.mobs.join("/")}`);
                break;
            case "farm":
                if (p.state === "ripe") {
                    lines.push(`${indent}${name}: harvest ripe ${p.crop.block} nearby`);
                } else if (p.state === "growing") {
                    lines.push(`${indent}${name}: wait for ${p.crop.block} nearby to grow`);
                } else {
                    lines.push(`${indent}${name}: plant a ${p.crop.block} field by water and wait`);
                    if (!kb.HOES.some((h) => ctx.countItem(h) > 0)) explain("wooden_hoe", sub, next, lines, shown);
                    if (p.crop.seed !== name) explain(p.crop.seed, sub, next, lines, shown);
                }
                break;
            default:
                lines.push(`${indent}${name}: no known way to get this`);
        }
        return lines;
    }

    return { plan, cheapestOf, toolFor, explain };
}

module.exports = { createPlanner };
