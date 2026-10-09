// Farming: harvest ripe crops and replant, start a new field next to water,
// and wait for it to grow (using bone meal if we have any).

const { Vec3 } = require("vec3");

const TILLABLE = new Set(["dirt", "grass_block", "dirt_path", "coarse_dirt", "rooted_dirt"]);
const UP = new Vec3(0, 1, 0);
// Plants that sit on soil and break in one hit.
const PLANTS = /^(short_grass|tall_grass|fern|large_fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z]+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|pink_petals|wildflowers|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|snow)$/;

function installFarming(ctx) {
    const { bot, config, kb, planner } = ctx;

    function blockId(name) {
        return bot.registry.blocksByName[name].id;
    }

    function cropPositions(crop, radius = config.searchRadius) {
        return bot.findBlocks({ matching: blockId(crop.block), maxDistance: radius, count: 256 });
    }

    function byDistance(a, b) {
        const me = bot.entity.position;
        return a.distanceTo(me) - b.distanceTo(me);
    }

    function ripeCrops(crop) {
        return cropPositions(crop)
            .map((pos) => bot.blockAt(pos))
            .filter((block) => block && kb.isMatureCrop(block))
            .sort((a, b) => byDistance(a.position, b.position));
    }

    function hasHoe() {
        return bot.inventory.items().some((i) => kb.HOES.includes(i.name));
    }

    // Harvest ripe crops (all kinds, or just `crops`) and replant them.
    async function harvest(crops = kb.CROPS, limit = Infinity) {
        let harvested = 0;
        for (const crop of crops) {
            for (const block of ripeCrops(crop)) {
                if (harvested >= limit) return harvested;
                if (ctx.crew?.claimedByOther(`crop:${block.position}`)) continue;
                ctx.crew?.claim(`crop:${block.position}`, 30000);
                ctx.checkStop();
                await ctx.guard();
                ctx.doing(`Harvesting ${ctx.pretty(crop.block)} at ${ctx.fmt(block.position)}`);
                await ctx.act(() => ctx.goTo(block.position, 2, `the ripe ${ctx.pretty(crop.block)}`));
                const current = bot.blockAt(block.position);
                if (current?.type !== block.type || !kb.isMatureCrop(current)) continue;
                try {
                    await bot.dig(current);
                } catch (err) {
                    ctx.log(`Couldn't harvest ${crop.block}: ${err.message}`);
                    continue;
                }
                harvested++;
                ctx.learn.count("harvested");
                await ctx.wait(250); // let drops spawn
                await ctx.pickUpDrops(null, 4);
                await replant(block.position, crop);
            }
        }
        return harvested;
    }

    async function replant(pos, crop) {
        const soil = bot.blockAt(pos.offset(0, -1, 0));
        if (soil?.name !== "farmland" || bot.blockAt(pos)?.name !== "air") return false;
        const seed = bot.inventory.items().find((i) => i.name === crop.seed);
        if (!seed) return false;
        try {
            ctx.doing(`Planting ${ctx.pretty(crop.seed)} at ${ctx.fmt(pos)}`);
            await ctx.act(() => ctx.goTo(pos, 2));
            await bot.equip(seed, "hand");
            await bot.placeBlock(soil, UP);
            return true;
        } catch (err) {
            ctx.log(`Couldn't plant ${crop.seed}: ${err.message}`);
            return false;
        }
    }

    // Enough light for a crop in the space above `soil`: daylight (sky light
    // 9+, so it grows by day) or a torch or lamp (block light 9+). Seeds
    // can't even be planted in the dark, so water in a cave is no use.
    function lit(soil) {
        const above = bot.blockAt(soil.offset(0, 1, 0));
        return Boolean(above) && Math.max(above.skyLight ?? 0, above.light ?? 0) >= 9;
    }
    ctx.litForCrops = lit;

    // Room to till: a hoe only works with nothing on top, but grass and
    // flowers on top just need knocking off first.
    function clearAbove(pos) {
        const above = bot.blockAt(pos.offset(0, 1, 0));
        return above?.name === "air" || PLANTS.test(above?.name || "");
    }

    // Empty farmland first; then soil level with water within 4 blocks (it
    // stays wet); then soil one block above that water, the usual pond bank:
    // crops grow there too, only slower. It used to take only the first two,
    // so beside an ordinary pond there was "no room for a farm". Only spots
    // with light enough for crops (not a pool in a cave).
    function farmSpots(count) {
        const spots = bot
            .findBlocks({ matching: blockId("farmland"), maxDistance: config.searchRadius, count: 128 })
            .filter((pos) => bot.blockAt(pos.offset(0, 1, 0))?.name === "air" && lit(pos))
            .sort(byDistance);
        const seen = new Set(spots.map(String));
        // The water's surface: plenty of blocks, since most water is under it.
        // Water out in the light first (a pool in a cave, nearer, would crowd
        // it out); every spot is checked for light anyway.
        const surface = bot
            .findBlocks({ matching: blockId("water"), maxDistance: config.searchRadius, count: 1024 })
            .filter((pos) => bot.blockAt(pos.offset(0, 1, 0))?.name !== "water")
            .sort(byDistance);
        const waters = [...surface.filter(lit), ...surface.filter((pos) => !lit(pos))].slice(0, 48);
        if (surface[0] && !lit(surface[0])) {
            ctx.log(`The nearest water, at ${ctx.fmt(surface[0])}, is too dark for crops; looking for a spot with daylight or torchlight.`);
        }
        const wet = [];
        const dry = [];
        for (const water of waters) {
            for (let dx = -4; dx <= 4; dx++) {
                for (let dz = -4; dz <= 4; dz++) {
                    for (const [dy, list] of [[0, wet], [1, dry]]) {
                        const pos = water.offset(dx, dy, dz);
                        if (seen.has(String(pos))) continue;
                        const block = bot.blockAt(pos);
                        if (block && TILLABLE.has(block.name) && clearAbove(pos) && lit(pos)) {
                            seen.add(String(pos));
                            list.push(pos);
                        }
                    }
                }
            }
            if (spots.length + wet.length >= count) break;
        }
        return [...spots, ...wet.sort(byDistance), ...dry.sort(byDistance)].slice(0, count);
    }

    // Till the soil at `pos` (knocking off grass on top first). Returns
    // whether it is farmland now.
    async function till(pos) {
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (above && above.name !== "air" && PLANTS.test(above.name)) {
            await bot.dig(above, true).catch(() => {});
            await bot.waitForTicks(2);
        }
        let soil = bot.blockAt(pos);
        if (!TILLABLE.has(soil?.name)) return soil?.name === "farmland";
        const hoe = bot.inventory.items().find((i) => kb.HOES.includes(i.name));
        if (!hoe) throw new Error("no hoe");
        await bot.equip(hoe, "hand");
        // Click the top face, where a player would.
        await bot.lookAt(pos.offset(0.5, 1, 0.5), true);
        await bot.activateBlock(soil, UP, new Vec3(0.5, 1, 0.5));
        for (let i = 0; i < 10 && bot.blockAt(pos)?.name !== "farmland"; i++) await bot.waitForTicks(1);
        soil = bot.blockAt(pos);
        if (soil?.name !== "farmland") {
            const top = bot.blockAt(pos.offset(0, 1, 0))?.name;
            ctx.log(`Couldn't till the ${soil?.name} at ${ctx.fmt(pos)} (above it: ${top}).`);
            return false;
        }
        return true;
    }

    // Till and plant up to `count` plots of `crop`.
    async function plant(crop, count = config.farmSize, seen = new Set()) {
        if (!hasHoe()) {
            const hoe = planner.cheapestOf(kb.HOES);
            if (!hoe || hoe.cost === Infinity) throw new Error("can't make a hoe");
            ctx.say(`Making a ${hoe.name} for farming.`);
            ctx.doing(`Making a ${ctx.pretty(hoe.name)}`);
            await ctx.obtain(hoe.name, 1, seen);
        }
        if (ctx.countItem(crop.seed) === 0) {
            ctx.doing(`Getting ${ctx.pretty(crop.seed)} to plant`);
            await ctx.obtain(crop.seed, Math.min(count, 4), seen);
        }
        let spots = farmSpots(count);
        if (spots.length === 0) {
            if (config.placeWater === false) throw new Error("no water nearby to start a farm next to");
            ctx.doing("Making a water source for the farm");
            await ctx.makeWaterSource(seen);
            spots = farmSpots(count);
            if (spots.length === 0) throw new Error("no room for a farm around the water");
        }

        let planted = 0;
        for (const pos of spots) {
            if (ctx.countItem(crop.seed) === 0) break;
            ctx.checkStop();
            await ctx.guard();
            ctx.doing(`Tilling the soil at ${ctx.fmt(pos)} (${planted}/${spots.length} planted)`);
            await ctx.act(() => ctx.goTo(pos, 2));
            if (!(await till(pos))) continue;
            if (await replant(pos.offset(0, 1, 0), crop)) planted++;
        }
        ctx.say(`Planted ${planted} ${crop.block}.`);
        return planted;
    }

    async function useBoneMeal(crop) {
        const growing = cropPositions(crop, 16)
            .map((pos) => bot.blockAt(pos))
            .filter((block) => block && !kb.isMatureCrop(block))
            .sort((a, b) => byDistance(a.position, b.position));
        for (const block of growing) {
            const meal = bot.inventory.items().find((i) => i.name === "bone_meal");
            if (!meal) return;
            ctx.doing(`Using bone meal on the ${ctx.pretty(crop.block)}`);
            await ctx.act(() => ctx.goTo(block.position, 2));
            await bot.equip(meal, "hand");
            await bot.activateBlock(block).catch(() => {});
        }
    }

    // Wait while staying alert to mobs.
    async function waitAlert(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            ctx.checkStop();
            if (ctx.threatNearby()) await ctx.guard();
            await ctx.wait(1000);
        }
    }

    // Grow and harvest until the inventory holds `target` of `item`.
    async function farmFor(item, target, crop, seen) {
        const deadline = Date.now() + config.farmWaitMinutes * 60000;
        let planted = false;
        let lastNote = 0;
        while (ctx.countItem(item) < target) {
            ctx.checkStop();
            await ctx.guard();
            await harvest([crop]);
            if (ctx.countItem(item) >= target) break;

            const growing = cropPositions(crop);
            const need = target - ctx.countItem(item);
            if (!planted && growing.length < Math.min(config.farmSize, need)) {
                planted = true;
                await plant(crop, config.farmSize, seen);
                continue;
            }
            if (growing.length === 0) throw new Error(`nothing planted to grow ${item}`);
            if (Date.now() > deadline) throw new Error(`${crop.block} didn't grow within ${config.farmWaitMinutes} minutes`);

            await useBoneMeal(crop);
            // Stay close so the chunk keeps loading and crops keep growing.
            const nearest = growing.sort(byDistance)[0];
            if (nearest.distanceTo(bot.entity.position) > 16) {
                await ctx.act(() => ctx.goTo(nearest, 3));
            }
            ctx.doing(`Waiting for ${growing.length} ${ctx.pretty(crop.block)} to grow`);
            if (Date.now() - lastNote > 60000) {
                ctx.say(`Waiting for ${growing.length} ${crop.block} to grow.`);
                lastNote = Date.now();
            }
            await waitAlert(15000);
        }
    }

    Object.assign(ctx, { harvestCrops: harvest, plantCrop: plant, farmFor });
}

module.exports = { installFarming };
