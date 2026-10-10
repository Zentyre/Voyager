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
        placedStations: [], // workbenches used or put down this session: { name, pos }
    };

    // Prefix with the in-game name once logged in (Microsoft accounts have
    // their own names), the config label before that.
    ctx.log = (message) => console.log(`[${bot.username || config.username}] ${message}`);
    // While a job someone asked for by /msg runs, ctx.replyTo is that player
    // and everything the bot says goes to them privately. Asked from the
    // in-game dashboard, it's ctx.QUIET: the log only, nothing in chat.
    ctx.replyTo = null;
    ctx.QUIET = "@dashboard"; // (no player can be called that)
    ctx.sayPublic = (message) => {
        ctx.log(message);
        if (bot.entity && config.chatter !== false) bot.chat(message);
    };
    ctx.say = (message) => (ctx.replyTo ? ctx.tell(ctx.replyTo, message) : ctx.sayPublic(message));

    // Reply to someone privately (/msg) when they asked privately.
    ctx.tell = (player, message) => {
        if (!player) return ctx.say(message);
        ctx.log(message);
        if (player === ctx.QUIET) return;
        if (bot.entity) bot.whisper(player, message);
    };

    ctx.fmt = (pos) => `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`;

    // What the bot is doing right now, for the dashboard: the goals it is
    // working through ("3 diamond" > "iron pickaxe" > "3 iron ingot") and the
    // step under way ("Walking to the furnace"). Each goal level keeps its own
    // step, so finishing a sub-goal shows the parent's step again.
    const levels = [{ goal: null, step: null, since: Date.now() }];
    const top = () => levels[levels.length - 1];
    ctx.within = async (goal, fn) => {
        const level = { goal, step: null, since: Date.now() };
        levels.push(level);
        try {
            return await fn();
        } finally {
            const i = levels.lastIndexOf(level);
            if (i > 0) levels.splice(i, 1);
        }
    };
    ctx.doing = (step) => {
        const level = top();
        if (level.step !== step) level.since = Date.now();
        level.step = step;
    };
    // A step that interrupts another one (walking there, a fight, a snack),
    // after which the earlier step shows again.
    ctx.during = async (step, fn) => {
        const level = top();
        const before = { step: level.step, since: level.since };
        ctx.doing(step);
        try {
            return await fn();
        } finally {
            if (level.step === step) Object.assign(level, before);
        }
    };
    ctx.nowDoing = () => {
        const step = [...levels].reverse().find((l) => l.step);
        return {
            step: step?.step || null,
            goals: levels.map((l) => l.goal).filter(Boolean),
            seconds: Math.round((Date.now() - (step?.since || top().since)) / 1000),
        };
    };
    // Drop leftover steps once a job is over (or was stopped midway).
    ctx.doneDoing = () => {
        levels.length = 1;
        Object.assign(levels[0], { step: null, since: Date.now() });
    };
    ctx.pretty = (name) => String(name).replace(/^minecraft:/, "").replace(/_/g, " ");

    // Includes worn armor and the off-hand, so equipping something
    // doesn't make it look like we lost it. While a furnace, chest or other
    // screen is open, mineflayer only copies its slots back into
    // bot.inventory when it closes, so count what the open screen shows.
    ctx.carried = () => {
        const w = bot.currentWindow;
        return w && w !== bot.inventory ? w.items() : bot.inventory.items();
    };
    ctx.countItem = (name) =>
        [...ctx.carried(), ...ctx.equipped()]
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
    // Workbenches (crafting tables, furnaces, brewing stands): the nearest
    // one it can see within workbenchRange, or one it knows of (it used or
    // put down before, remembered across restarts, or saw on the way) to go
    // back to. Only when there's none does it make a new one. Never one with
    // a creeper it ran from standing by it.
    const STATION = "station";
    // One right by the bot is always fine (a creeper that close and it would
    // be running already). Skipping one says so, once a minute.
    const skipped = new Map(); // position -> when it said so
    const usableStation = (pos, name = null) => {
        if (pos.distanceTo(bot.entity.position) <= 6) return true;
        const lurker = ctx.lurkerNear?.(pos);
        if (!lurker) return true;
        if (name && Date.now() - (skipped.get(String(pos)) || 0) > 60000) {
            skipped.set(String(pos), Date.now());
            ctx.log(`Not using the ${ctx.pretty(name)} at ${ctx.fmt(pos)}: the ${ctx.pretty(lurker.name)} I ran from is near it.`);
        }
        return false;
    };
    ctx.findStation = (name) => {
        const id = bot.registry.blocksByName[name]?.id;
        if (id === undefined) return null;
        const me = bot.entity.position;
        const near = bot
            .findBlocks({ matching: id, maxDistance: config.workbenchRange ?? 64, count: 16 })
            .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
            .find((pos) => usableStation(pos, name));
        return near ? bot.blockAt(near) : null;
    };
    // Ones it knows of out of sight, its own first, nearest first.
    ctx.knownStations = (name) => {
        const me = bot.entity.position;
        const range = config.workbenchRange ?? 64;
        const mine = [
            ...(ctx.learn?.recall(STATION, [name], me, range) || []),
            ...ctx.placedStations.filter((s) => s.name === name && s.pos.distanceTo(me) <= range).map((s) => ({ x: s.pos.x, y: s.pos.y, z: s.pos.z })),
        ];
        const seen = ctx.learn?.recall("block", [name], me, range) || [];
        const out = [];
        for (const s of [...mine, ...seen]) {
            const pos = new Vec3(s.x, s.y, s.z);
            if (out.some((o) => o.equals(pos)) || !usableStation(pos)) continue;
            const block = bot.blockAt(pos);
            if (block && block.name !== name) {
                ctx.forgetStation(name, pos); // loaded, and not there any more
                continue;
            }
            out.push(pos);
        }
        return out;
    };
    ctx.rememberStation = (name, pos) => {
        nearbyCache.delete(name);
        if (!ctx.placedStations.some((s) => s.name === name && s.pos.equals(pos))) ctx.placedStations.push({ name, pos: pos.clone() });
        ctx.learn?.remember(STATION, name, pos);
    };
    ctx.forgetStation = (name, pos) => {
        nearbyCache.delete(name);
        ctx.placedStations = ctx.placedStations.filter((s) => !(s.name === name && s.pos.equals(pos)));
        ctx.learn?.forget(STATION, [name], pos);
        ctx.learn?.forget("block", [name], pos);
    };
    // (asked for every recipe while planning: worked out once every few seconds)
    const nearbyCache = new Map();
    ctx.stationNearby = (name) => {
        const hit = nearbyCache.get(name);
        if (hit && Date.now() - hit.t < 3000) return hit.yes;
        const yes = Boolean(ctx.findStation(name)) || ctx.knownStations(name).length > 0;
        nearbyCache.set(name, { t: Date.now(), yes });
        return yes;
    };

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
        if (bot.targetDigBlock) bot.stopDigging(); // half a block dug is no reason to stay
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

    // `what` names the destination for the dashboard ("the crafting table").
    ctx.goTo = (pos, range = 1, what = null) =>
        ctx.during(`Walking to ${what || ctx.fmt(pos)}`, () =>
            bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range))
        );

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
