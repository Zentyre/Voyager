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
    "short_grass", "tall_grass", "fern",
]);

// Block drops missing from minecraft-data (random drops it leaves out).
const EXTRA_BLOCK_DROPS = {
    short_grass: ["wheat_seeds"],
    tall_grass: ["wheat_seeds"],
    fern: ["wheat_seeds"],
    gravel: ["flint"], // 10% chance per block
};

// Farmable crops: the crop block, what to plant, and what harvesting gives.
const CROPS = [
    { block: "wheat", seed: "wheat_seeds", produces: ["wheat", "wheat_seeds"] },
    { block: "carrots", seed: "carrot", produces: ["carrot"] },
    { block: "potatoes", seed: "potato", produces: ["potato"] },
    { block: "beetroots", seed: "beetroot_seeds", produces: ["beetroot", "beetroot_seeds"] },
];
const HOES = ["wooden_hoe", "stone_hoe", "iron_hoe", "golden_hoe", "diamond_hoe", "netherite_hoe"];

// Blocks the pathfinder must never dig through on its way somewhere.
const NEVER_BREAK = [
    "farmland", "wheat", "carrots", "potatoes", "beetroots", "melon_stem", "pumpkin_stem",
    "chest", "trapped_chest", "barrel", "ender_chest", "furnace", "blast_furnace", "smoker",
    "crafting_table", "white_bed", "red_bed", "oak_door", "spruce_door", "birch_door",
    "glass", "glass_pane", "torch", "wall_torch", "lantern", "bookshelf", "enchanting_table",
    "anvil", "brewing_stand", "beacon", "spawner",
];
// Things players build with, by pattern (every color and wood type).
const NEVER_BREAK_PATTERNS = [
    /_bed$/, /_door$/, /_trapdoor$/, /_fence$/, /_fence_gate$/, /_wall$/, /_carpet$/,
    /_stained_glass(_pane)?$/, /_sign$/, /_banner$/, /_shulker_box$/, /^shulker_box$/, /lantern$/, /torch$/,
    /_chest$/, /_bars$/, /^(ladder|scaffolding|lectern|jukebox|note_block|bell|campfire|soul_campfire|composter|hopper|dropper|dispenser)$/,
];
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

// What each farm animal eats to breed.
const BREED_FOOD = {
    cow: ["wheat"],
    mooshroom: ["wheat"],
    sheep: ["wheat"],
    goat: ["wheat"],
    pig: ["carrot", "potato", "beetroot"],
    chicken: ["wheat_seeds", "beetroot_seeds", "melon_seeds", "pumpkin_seeds"],
    rabbit: ["carrot", "golden_carrot", "dandelion"],
};

// Brewing: each potion is made by adding `ingredient` to `base`.
const POTIONS = {
    awkward: { base: "water", ingredient: "nether_wart" },
    healing: { base: "awkward", ingredient: "glistering_melon_slice" },
    swiftness: { base: "awkward", ingredient: "sugar" },
    strength: { base: "awkward", ingredient: "blaze_powder" },
    night_vision: { base: "awkward", ingredient: "golden_carrot" },
    fire_resistance: { base: "awkward", ingredient: "magma_cream" },
    regeneration: { base: "awkward", ingredient: "ghast_tear" },
    water_breathing: { base: "awkward", ingredient: "pufferfish" },
    leaping: { base: "awkward", ingredient: "rabbit_foot" },
    slow_falling: { base: "awkward", ingredient: "phantom_membrane" },
    poison: { base: "awkward", ingredient: "spider_eye" },
    turtle_master: { base: "awkward", ingredient: "turtle_helmet" },
    weakness: { base: "water", ingredient: "fermented_spider_eye" },
    invisibility: { base: "night_vision", ingredient: "fermented_spider_eye" },
    harming: { base: "healing", ingredient: "fermented_spider_eye" },
    slowness: { base: "swiftness", ingredient: "fermented_spider_eye" },
};
const POTION_MODIFIERS = { long: "redstone", strong: "glowstone_dust", splash: "gunpowder", lingering: "dragon_breath" };

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
const FOOD_SOURCES = ["beef", "porkchop", "mutton", "chicken", "rabbit", "bread", "carrot"];

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
                ((block.drops || []).some(
                    (d) => (typeof d === "number" ? d : d.drop?.id ?? d.drop) === item.id
                ) ||
                    (EXTRA_BLOCK_DROPS[block.name] || []).includes(itemName))
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

    function cropFor(itemName) {
        if (config.farm === false) return null;
        return CROPS.find((crop) => crop.produces.includes(itemName)) || null;
    }

    function cropMaxAge(blockName) {
        const age = registry.blocksByName[blockName].states.find((s) => s.name === "age");
        return age.num_values - 1;
    }

    function isMatureCrop(block) {
        return Number(block.getProperties().age) >= cropMaxAge(block.name);
    }

    function neverBreakIds() {
        return registry.blocksArray
            .filter((b) => NEVER_BREAK.includes(b.name) || NEVER_BREAK_PATTERNS.some((p) => p.test(b.name)))
            .map((b) => b.id);
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
        cropFor,
        cropMaxAge,
        isMatureCrop,
        neverBreakIds,
        CROPS,
        HOES,
        BREED_FOOD,
        POTIONS,
        POTION_MODIFIERS,
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
