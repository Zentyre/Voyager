// Shared state and small helpers used by every module.

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

class Stopped extends Error {
    constructor() {
        super("stopped");
    }
}
// Thrown when inventory changed under us (e.g. after a chest deposit) and the
// current task should re-plan from the top.
class Retry extends Error {
    constructor() {
        super("retry");
    }
}

function createContext(bot, config) {
    const ctx = {
        bot,
        config,
        Stopped,
        Retry,
        Vec3,
        deaths: 0,
        stopRequested: false,
        interrupts: 0, // bumped whenever an action is cut short (e.g. by a mob)
        current: null,
        queue: [],
        home: null,
        placedStations: [], // crafting tables / furnaces we put down
    };

    // Prefix with the in-game name once logged in (Microsoft accounts have
    // their own names), the config label before that.
    ctx.log = (message) => console.log(`[${bot.username || config.username}] ${message}`);
    // While a job someone asked for by /msg runs, ctx.replyTo is that player
    // and everything the bot says goes to them privately.
    ctx.replyTo = null;
    ctx.sayPublic = (message) => {
        ctx.log(message);
        if (bot.entity && config.chatter !== false) bot.chat(message);
    };
    ctx.say = (message) => (ctx.replyTo ? ctx.tell(ctx.replyTo, message) : ctx.sayPublic(message));

    // Reply to someone privately (/msg) when they asked privately.
    ctx.tell = (player, message) => {
        if (!player) return ctx.say(message);
        ctx.log(message);
        if (bot.entity) bot.whisper(player, message);
    };

    ctx.fmt = (pos) => `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`;

    // Includes worn armor and the off-hand, so equipping something
    // doesn't make it look like we lost it.
    ctx.countItem = (name) =>
        [...bot.inventory.items(), ...ctx.equipped()]
            .filter((i) => i.name === name)
            .reduce((sum, i) => sum + i.count, 0);

    ctx.equipped = () =>
        ["head", "torso", "legs", "feet", "off-hand"]
            .map((slot) => bot.inventory.slots[bot.getEquipmentDestSlot(slot)])
            .filter(Boolean);

    ctx.canHarvest = (block) =>
        !block.harvestTools ||
        bot.inventory.items().some((i) => block.harvestTools[i.type]);

    // A crafting table / furnace nearby, or one we placed earlier within reach
    // of a short walk.
    ctx.findStation = (name) => {
        const id = bot.registry.blocksByName[name].id;
        const near = bot.findBlock({ matching: id, maxDistance: config.stationRadius });
        if (near) return near;
        const me = bot.entity.position;
        const placed = ctx.placedStations
            .filter((pos) => pos.distanceTo(me) <= config.stationRadius * 3)
            .map((pos) => bot.blockAt(pos))
            .filter((block) => block?.type === id)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
        return placed[0] || null;
    };
    ctx.stationNearby = (name) => Boolean(ctx.findStation(name));

    ctx.fuelInInventory = (exclude) =>
        bot.inventory
            .items()
            .filter((i) => i.name !== exclude)
            .reduce((sum, i) => sum + ctx.kb.fuelValue(i.name) * i.count, 0);

    ctx.checkStop = () => {
        if (ctx.stopRequested) throw new Stopped();
    };

    ctx.stopCurrentAction = () => {
        ctx.interrupts++;
        bot.pathfinder.setGoal(null);
        // cancelTask waits for the collection to wind down; don't stack waits
        if (!ctx.cancelling) {
            ctx.cancelling = true;
            bot.collectBlock
                .cancelTask()
                .catch(() => {})
                .finally(() => (ctx.cancelling = false));
        }
        bot.clearControlStates();
    };

    ctx.goTo = (pos, range = 1) =>
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));

    ctx.withTimeout = (promise, ms) => {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    bot.pathfinder.setGoal(null);
                    reject(new Error("timed out"));
                }, ms);
            }),
        ]).finally(() => clearTimeout(timer));
    };

    ctx.safely = async (fn) => {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof Stopped) throw err;
            ctx.log(err.message);
        }
    };

    // Run an action; if a mob or hunger interrupted it, deal with that and retry.
    ctx.act = async (fn, retries = 5) => {
        for (let attempt = 0; ; attempt++) {
            ctx.checkStop();
            await ctx.guard();
            const before = ctx.interrupts;
            try {
                return await fn();
            } catch (err) {
                ctx.checkStop();
                if (ctx.interrupts === before || attempt >= retries) throw err;
            }
        }
    };

    ctx.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    return ctx;
}

module.exports = { createContext };
