// Farming: harvest ripe crops and replant, start a new field next to water,
// and wait for it to grow (using bone meal if we have any).

const { Vec3 } = require("vec3");

const TILLABLE = new Set(["dirt", "grass_block", "dirt_path", "coarse_dirt", "rooted_dirt"]);
const UP = new Vec3(0, 1, 0);

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
                ctx.checkStop();
                await ctx.guard();
                await ctx.act(() => ctx.goTo(block.position, 2));
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
            await ctx.act(() => ctx.goTo(pos, 2));
            await bot.equip(seed, "hand");
            await bot.placeBlock(soil, UP);
            return true;
        } catch (err) {
            ctx.log(`Couldn't plant ${crop.seed}: ${err.message}`);
            return false;
        }
    }

    // Empty farmland first, then dirt within 4 blocks of water (so it stays hydrated).
    function farmSpots(count) {
        const isFree = (pos) => bot.blockAt(pos.offset(0, 1, 0))?.name === "air";
        const spots = bot
            .findBlocks({ matching: blockId("farmland"), maxDistance: config.searchRadius, count: 128 })
            .filter(isFree)
            .sort(byDistance);

        const waters = bot
            .findBlocks({ matching: blockId("water"), maxDistance: config.searchRadius, count: 64 })
            .sort(byDistance);
        const seen = new Set(spots.map(String));
        for (const water of waters) {
            if (spots.length >= count) break;
            const near = [];
            for (let dx = -4; dx <= 4; dx++) {
                for (let dz = -4; dz <= 4; dz++) {
                    const pos = water.offset(dx, 0, dz);
                    if (seen.has(String(pos))) continue;
                    const block = bot.blockAt(pos);
                    if (block && TILLABLE.has(block.name) && isFree(pos)) near.push(pos);
                }
            }
            near.sort((a, b) => a.distanceTo(water) - b.distanceTo(water));
            for (const pos of near) {
                seen.add(String(pos));
                spots.push(pos);
            }
        }
        return spots.slice(0, count);
    }

    // Till and plant up to `count` plots of `crop`.
    async function plant(crop, count = config.farmSize, seen = new Set()) {
        if (!hasHoe()) {
            const hoe = planner.cheapestOf(kb.HOES);
            if (!hoe || hoe.cost === Infinity) throw new Error("can't make a hoe");
            ctx.say(`Making a ${hoe.name} for farming.`);
            await ctx.obtain(hoe.name, 1, seen);
        }
        if (ctx.countItem(crop.seed) === 0) {
            await ctx.obtain(crop.seed, Math.min(count, 4), seen);
        }
        let spots = farmSpots(count);
        if (spots.length === 0) {
            if (config.placeWater === false) throw new Error("no water nearby to start a farm next to");
            await ctx.makeWaterSource(seen);
            spots = farmSpots(count);
            if (spots.length === 0) throw new Error("no room for a farm around the water");
        }

        let planted = 0;
        for (const pos of spots) {
            if (ctx.countItem(crop.seed) === 0) break;
            ctx.checkStop();
            await ctx.guard();
            await ctx.act(() => ctx.goTo(pos, 2));
            let soil = bot.blockAt(pos);
            if (TILLABLE.has(soil?.name)) {
                const hoe = bot.inventory.items().find((i) => kb.HOES.includes(i.name));
                await bot.equip(hoe, "hand");
                await bot.activateBlock(soil);
                await bot.waitForTicks(4);
                soil = bot.blockAt(pos);
            }
            if (soil?.name !== "farmland") continue;
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
