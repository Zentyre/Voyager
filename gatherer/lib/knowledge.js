// Static game knowledge: what drops what, what smelts into what, what burns,
// what is safe to eat. Everything here is table lookups, no reasoning model.

// Blocks the bot is allowed to mine. Limited to blocks that generate naturally
// so it doesn't take apart your house for planks, glass, or chests.
const NATURAL_BLOCKS = new Set([
    "stone", "deepslate", "granite", "diorite", "andesite", "tuff", "calcite",
    "dirt", "grass_block", "coarse_dirt", "podzol", "rooted_dirt", "mud",
    "gravel", "clay", "snow", "snow_block", "sandstone", "red_sandstone",
    "netherrack", "soul_sand", "soul_soil", "basalt", "blackstone",
    "end_stone", "obsidian", "ancient_debris", "glowstone", "magma_block",
    "moss_block", "dripstone_block", "pointed_dripstone", "amethyst_cluster",
    "pumpkin", "melon", "sugar_cane", "cactus", "bamboo", "kelp", "kelp_plant",
    "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip",
    "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower",
    "lily_of_the_valley", "brown_mushroom", "red_mushroom", "vine", "lily_pad",
]);
const NATURAL_PATTERNS = [
    /_log$/, // all tree logs
    /^(crimson|warped)_stem$/,
    /_ore$/,
    /^(red_)?sand$/,
    /^([a-z_]+_)?terracotta$/, // badlands
    /_mushroom_block$/,
];
const NOT_NATURAL = /glazed|stripped/;

// Mobs the bot may hunt for drops. Leaves out pets, mounts, villagers, golems,
// creepers (they explode), and mobs that fight back as a group.
const HUNTABLE_MOBS = new Set([
    "cow", "mooshroom", "pig", "sheep", "chicken", "rabbit", "goat",
    "spider", "cave_spider", "zombie", "husk", "drowned", "skeleton", "stray",
    "slime", "magma_cube",
]);

// Drops missing from minecraft-data's loot tables.
const EXTRA_LOOT = {
    sheep: ["white_wool"], // most sheep are white
};

// Hostile mobs the bot should not pick a fight with.
const DONT_PROVOKE = new Set([
    "enderman", "zombified_piglin", "piglin", "ghast", "phantom", "warden",
    "ender_dragon", "wither", "shulker",
]);
const FLEE_FROM = new Set(["creeper", "warden"]);

// Furnace recipes (output <- any one of inputs). minecraft-data has no
// smelting table, so the common ones are listed here.
const SMELTS = {
    iron_ingot: ["raw_iron"],
    gold_ingot: ["raw_gold"],
    copper_ingot: ["raw_copper"],
    netherite_scrap: ["ancient_debris"],
    glass: ["sand", "red_sand"],
    stone: ["cobblestone"],
    smooth_stone: ["stone"],
    deepslate: ["cobbled_deepslate"],
    smooth_sandstone: ["sandstone"],
    cracked_stone_bricks: ["stone_bricks"],
    brick: ["clay_ball"],
    terracotta: ["clay"],
    nether_brick: ["netherrack"],
    green_dye: ["cactus"],
    dried_kelp: ["kelp"],
    sponge: ["wet_sponge"],
    charcoal: [
        "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
        "dark_oak_log", "mangrove_log", "cherry_log",
    ],
    cooked_beef: ["beef"],
    cooked_porkchop: ["porkchop"],
    cooked_chicken: ["chicken"],
    cooked_mutton: ["mutton"],
    cooked_rabbit: ["rabbit"],
    cooked_cod: ["cod"],
    cooked_salmon: ["salmon"],
    baked_potato: ["potato"],
};

// How many items one unit of fuel smelts.
function fuelValue(name) {
    if (name === "coal" || name === "charcoal") return 8;
    if (name === "coal_block") return 80;
    if (name === "blaze_rod") return 12;
    if (name === "lava_bucket") return 100;
    if (/_log$|_wood$|_planks$|^(crimson|warped)_stem$/.test(name)) return 1.5;
    if (name === "stick") return 0.5;
    return 0;
}

const BAD_FOOD = new Set([
    "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish",
    "suspicious_stew", "chorus_fruit", "chicken",
]);
const FOOD_SOURCES = ["beef", "porkchop", "mutton", "chicken", "rabbit"];

function createKnowledge(bot, config) {
    const registry = bot.registry;
    const { Recipe } = require("prismarine-recipe")(registry);
    const extraMineable = new Set(config.extraMineable || []);

    function isMineable(name) {
        if (extraMineable.has(name)) return true;
        if (NOT_NATURAL.test(name)) return false;
        return NATURAL_BLOCKS.has(name) || NATURAL_PATTERNS.some((r) => r.test(name));
    }

    // Natural blocks that drop `itemName` (coal -> coal_ore, deepslate_coal_ore).
    function blocksThatDrop(itemName) {
        const item = registry.itemsByName[itemName];
        if (!item) return [];
        return registry.blocksArray.filter(
            (block) =>
                isMineable(block.name) &&
                (block.drops || []).some(
                    (d) => (typeof d === "number" ? d : d.drop?.id ?? d.drop) === item.id
                )
        );
    }

    // Huntable mobs that reliably drop `itemName` (leather -> cow, mooshroom).
    function mobsThatDrop(itemName) {
        if (config.hunt === false) return [];
        const mobs = Object.values(registry.entityLoot || {})
            .filter(
                (loot) =>
                    HUNTABLE_MOBS.has(loot.entity) &&
                    loot.drops.some((d) => d.item === itemName && d.dropChance >= 0.3)
            )
            .map((loot) => loot.entity);
        for (const [mob, items] of Object.entries(EXTRA_LOOT)) {
            if (items.includes(itemName) && !mobs.includes(mob)) mobs.push(mob);
        }
        return mobs;
    }

    // Crafting recipes for an item, minus "unpacking" recipes such as
    // diamond_block -> 9 diamond or nuggets -> ingot, which only go in circles.
    function craftingRecipes(itemName) {
        const item = registry.itemsByName[itemName];
        if (!item) return [];
        return Recipe.find(item.id, null).filter((recipe) => {
            const ingredients = recipeIngredients(recipe);
            if (ingredients.length !== 1) return true;
            const only = ingredients[0].name;
            return recipe.result.count !== 9 && !only.endsWith("_nugget");
        });
    }

    function recipeIngredients(recipe) {
        return recipe.delta
            .filter((d) => d.count < 0)
            .map((d) => ({ name: registry.items[d.id].name, count: -d.count }));
    }

    function smeltInputs(itemName) {
        return SMELTS[itemName] || [];
    }

    function harvestTools(block) {
        return Object.keys(block.harvestTools || {}).map((id) => registry.items[id].name);
    }

    function isFood(name) {
        return Boolean(registry.foodsByName[name]);
    }

    function foodPoints(name) {
        return registry.foodsByName[name]?.foodPoints || 0;
    }

    return {
        isMineable,
        blocksThatDrop,
        mobsThatDrop,
        craftingRecipes,
        recipeIngredients,
        smeltInputs,
        harvestTools,
        fuelValue,
        isFood,
        foodPoints,
        BAD_FOOD,
        FOOD_SOURCES,
        DONT_PROVOKE,
        FLEE_FROM,
        HUNTABLE_MOBS,
    };
}

module.exports = { createKnowledge };
