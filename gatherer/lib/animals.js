// Animal husbandry: tell babies and named pets apart, breed pairs, and keep a
// few adults of each kind alive when hunting.

const LOVE_COOLDOWN_MS = 5 * 60 * 1000;

function installAnimals(ctx) {
    const { bot, config, kb, planner, learn } = ctx;
    const fedAt = new Map(); // entity id -> time we fed it

    function metadataIndex(entity, key, fallback) {
        const keys = bot.registry.entitiesByName[entity.name]?.metadataKeys;
        const i = keys ? keys.indexOf(key) : -1;
        return i >= 0 ? i : fallback;
    }

    function isBaby(entity) {
        return Boolean(entity.metadata?.[metadataIndex(entity, "baby", 16)]);
    }

    // Has a name tag: almost certainly someone's pet.
    function isNamed(entity) {
        return Boolean(entity.metadata?.[metadataIndex(entity, "custom_name", 2)]);
    }

    function adults(name, radius = config.searchRadius) {
        const me = bot.entity.position;
        return Object.values(bot.entities).filter(
            (e) => e.name === name && !isBaby(e) && !isNamed(e) && e.position.distanceTo(me) <= radius
        );
    }

    function babies(name, radius = config.searchRadius) {
        const me = bot.entity.position;
        return Object.values(bot.entities).filter(
            (e) => e.name === name && isBaby(e) && e.position.distanceTo(me) <= radius
        ).length;
    }

    // Babies drop nothing; a name tag means it's someone's pet.
    function huntable(entity) {
        return !isBaby(entity) && !isNamed(entity);
    }

    async function feed(entity, foodName) {
        const food = bot.inventory.items().find((i) => i.name === foodName);
        if (!food) return false;
        await ctx.act(() => ctx.withTimeout(ctx.goTo(entity.position, 2), 15000));
        if (!entity.isValid) return false;
        await bot.equip(food, "hand");
        await bot.lookAt(entity.position.offset(0, (entity.height || 1) * 0.5, 0), true);
        await bot.activateEntity(entity);
        fedAt.set(entity.id, Date.now());
        return true;
    }

    // Breed `pairs` pairs of `animal` nearby.
    async function breed(animal, pairs = 1, seen = new Set()) {
        const foods = kb.BREED_FOOD[animal];
        if (!foods) throw new Error(`I don't know how to breed ${animal}`);
        const needed = pairs * 2;
        let food = foods.find((f) => ctx.countItem(f) >= needed);
        if (!food) {
            const choice = planner.cheapestOf(foods);
            if (!choice || choice.cost === Infinity) throw new Error(`can't get ${foods.join(" or ")} to feed ${animal}`);
            food = choice.name;
            await ctx.obtain(food, needed, seen);
        }

        const done = learn.begin("breed", animal, pairs);
        let bred = 0;
        let searches = 0;
        try {
            while (bred < pairs) {
                ctx.checkStop();
                await ctx.guard();
                const ready = adults(animal).filter((e) => Date.now() - (fedAt.get(e.id) || 0) > LOVE_COOLDOWN_MS);
                if (ready.length < 2) {
                    if (++searches > config.maxExploreAttempts) throw new Error(`couldn't find two adult ${animal}`);
                    await ctx.explore("mob", [animal]);
                    continue;
                }
                const me = bot.entity.position;
                const first = ready.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
                const second = ready
                    .filter((e) => e !== first)
                    .sort((a, b) => a.position.distanceTo(first.position) - b.position.distanceTo(first.position))[0];
                const babiesBefore = babies(animal);
                if (!(await feed(first, food)) || !(await feed(second, food))) continue;
                await ctx.wait(4000);
                if (babies(animal) > babiesBefore) learn.count("bred");
                bred++;
            }
            done(true);
        } catch (err) {
            done(err instanceof ctx.Stopped || err instanceof ctx.Retry ? null : false);
            throw err;
        }
        ctx.say(`Bred ${bred} pair${bred === 1 ? "" : "s"} of ${animal}.`);
    }

    Object.assign(ctx, { isBaby, isNamed, huntable, breed, adultAnimals: adults });
}

module.exports = { installAnimals };
