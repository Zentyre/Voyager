// Water buckets: fill one, place a water source (e.g. to irrigate a new
// field), and pick the water back up.

function installWater(ctx) {
    const { bot, config, learn } = ctx;
    const waterId = () => bot.registry.blocksByName.water.id;

    function isSource(block) {
        return block?.name === "water" && Number(block.getProperties().level ?? 0) === 0;
    }

    function findSource(radius = config.searchRadius) {
        return bot
            // plenty: the nearest water is often under the surface, not usable
            .findBlocks({ matching: waterId(), maxDistance: radius, count: 512 })
            .map((pos) => bot.blockAt(pos))
            .filter(isSource)
            .filter((b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === "air")[0];
    }

    // Make sure we carry a water bucket.
    async function getWaterBucket(seen = new Set()) {
        if (ctx.countItem("water_bucket") > 0) return;
        if (ctx.countItem("bucket") === 0) {
            ctx.say("Making a bucket.");
            ctx.doing("Making a bucket");
            await ctx.obtain("bucket", 1, seen);
        }
        for (let attempt = 0; attempt <= config.maxExploreAttempts; attempt++) {
            ctx.checkStop();
            const source = findSource();
            if (source) {
                ctx.doing("Filling a bucket with water");
                await ctx.act(() => ctx.goTo(source.position, 3, "the water"));
                const bucket = bot.inventory.items().find((i) => i.name === "bucket");
                await bot.equip(bucket, "hand");
                await bot.lookAt(source.position.offset(0.5, 0.9, 0.5), true);
                bot.activateItem();
                await bot.waitForTicks(5);
                if (ctx.countItem("water_bucket") > 0) {
                    learn.remember("block", "water", source.position);
                    return;
                }
                continue;
            }
            ctx.doing("Looking for water");
            await ctx.explore("block", ["water"], () => [findSource()].filter(Boolean));
        }
        throw new Error("couldn't find water to fill a bucket");
    }

    // Replace the block at `pos` (dirt/grass) with a water source.
    async function placeWaterAt(pos) {
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.boundingBox !== "block") throw new Error("nothing solid under that spot");
        ctx.doing(`Placing water at ${ctx.fmt(pos)}`);
        await ctx.act(() => ctx.goTo(pos, 3));
        const block = bot.blockAt(pos);
        if (block && block.name !== "air" && block.name !== "water") await bot.dig(block);
        const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
        if (!bucket) throw new Error("no water bucket");
        await bot.equip(bucket, "hand");
        await bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
        bot.activateItem();
        await bot.waitForTicks(5);
        if (bot.blockAt(pos)?.name !== "water") throw new Error("water didn't place");
        learn.remember("block", "water", pos);
        return pos;
    }

    // Find a flat patch of dirt/grass and put a water source in the middle,
    // leaving room for up to 8 farm plots around it.
    async function makeWaterSource(seen = new Set(), near = bot.entity.position) {
        await getWaterBucket(seen);
        const tillable = new Set(["dirt", "grass_block", "coarse_dirt", "rooted_dirt"]);
        const candidates = bot
            .findBlocks({
                matching: [...tillable].map((n) => bot.registry.blocksByName[n].id),
                maxDistance: 16,
                count: 200,
                point: near,
            })
            .filter((pos) => {
                let ok = 0;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const p = pos.offset(dx, 0, dz);
                        if (tillable.has(bot.blockAt(p)?.name) && bot.blockAt(p.offset(0, 1, 0))?.name === "air") ok++;
                    }
                }
                return ok >= 7;
            });
        if (candidates.length === 0) throw new Error("no flat dirt nearby for a farm");
        ctx.say("Placing water for a farm.");
        return placeWaterAt(candidates[0]);
    }

    // Place water next to us (command).
    async function placeWaterHere() {
        await getWaterBucket();
        const feet = bot.entity.position.floored();
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
            const pos = feet.offset(dx, -1, dz);
            const block = bot.blockAt(pos);
            if (block && ["dirt", "grass_block", "sand", "gravel", "stone"].includes(block.name)) {
                return placeWaterAt(pos);
            }
        }
        throw new Error("nowhere to put water next to me");
    }

    Object.assign(ctx, { getWaterBucket, makeWaterSource, placeWaterHere, findWaterSource: findSource });
}

module.exports = { installWater };
