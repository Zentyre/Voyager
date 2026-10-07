// Lightweight, LLM-free Minecraft bot built on the same Mineflayer stack
// Voyager uses. Ask for items and it mines, crafts, smelts, farms, or hunts for
// them; it also breeds animals, brews potions, sleeps, handles water, wears
// armor, fights, and eats. It learns from experience (statistics, not an LLM)
// and remembers what it learned between runs.
//
//   node gatherer.js                          # uses config.json
//   node gatherer.js oak_log:64 iron_pickaxe:1
//   node gatherer.js --config other.json coal:16

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const { plugin: toolPlugin } = require("mineflayer-tool");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");

const { createContext } = require("./lib/context");
const { createKnowledge } = require("./lib/knowledge");
const { createPlanner } = require("./lib/planner");
const { installActions } = require("./lib/actions");
const { installSurvival } = require("./lib/survival");
const { installFarming } = require("./lib/farming");
const { installCombat } = require("./lib/combat");
const { installAnimals } = require("./lib/animals");
const { installWater } = require("./lib/water");
const { installBrewing } = require("./lib/brewing");
const { createLearning } = require("./lib/learning");

const DEFAULTS = {
    host: "localhost",
    port: 25565,
    username: "Gatherer",
    auth: "offline",
    version: false,
    owner: "Zentyre",
    commandPrefix: "!",
    viewDistance: "tiny",
    searchRadius: 48,
    stationRadius: 24,
    exploreDistance: 64,
    maxExploreAttempts: 8,
    chest: null,
    protectRadius: 0,
    extraMineable: [],
    hunt: true,
    defend: true,
    defendRadius: 8,
    fleeHealth: 6,
    eatBelow: 14,
    findFoodBelow: 8,
    autoArmor: true,
    useShield: true,
    farm: true,
    farmSize: 9,
    farmWaitMinutes: 30,
    placeWater: true,
    keepAnimals: 2,
    autoSleep: true,
    bringBed: false,
    learn: true,
    memoryFile: "memory.json",
    memoryRange: 400,
    returnHome: true,
    quitWhenDone: false,
    chatter: true,
    tasks: [],
};

// ---------- config ----------

function loadConfig(argv) {
    let configPath = path.join(__dirname, "config.json");
    const cliTasks = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--config") {
            configPath = path.resolve(argv[++i]);
        } else {
            cliTasks.push(parseTask(argv[i]));
        }
    }
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } else {
        console.log(`No ${configPath} found, using defaults.`);
    }
    const config = { ...DEFAULTS, ...fileConfig };
    if (cliTasks.length > 0) config.tasks = cliTasks;
    return config;
}

function parseTask(text) {
    const [item, count] = text.split(":");
    return { item: item.trim(), count: count ? parseInt(count, 10) : 1 };
}

const config = loadConfig(process.argv.slice(2));

// ---------- bot ----------

const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version || undefined,
    viewDistance: config.viewDistance,
    // Skip chat signing; it costs CPU and is not needed for a bot.
    disableChatSigning: true,
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectBlockPlugin);

const ctx = createContext(bot, config);
ctx.queue.push(...config.tasks);
const { log, say } = ctx;

bot.once("spawn", () => {
    ctx.kb = createKnowledge(bot, config);
    ctx.learn = createLearning(ctx);
    ctx.planner = createPlanner(ctx);
    installActions(ctx);
    installCombat(ctx);
    installSurvival(ctx);
    installFarming(ctx);
    installAnimals(ctx);
    installWater(ctx);
    installBrewing(ctx);

    // Keep path computation cheap: short per-tick budget and a hard timeout.
    const movements = new Movements(bot);
    movements.allowParkour = false;
    // Never dig through farms, chests, beds, doors, etc. on the way somewhere.
    for (const id of ctx.kb.neverBreakIds()) movements.blocksCantBreak.add(id);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 5000;
    bot.pathfinder.tickTimeout = 20;
    bot.collectBlock.movements = movements;
    // We handle chest deposits ourselves so progress stays accurate.
    bot.collectBlock.chestLocations = [];

    ctx.home = bot.entity.position.clone();
    ctx.equipArmor().catch(() => {});
    log(`Spawned at ${ctx.fmt(ctx.home)} on ${bot.version}.`);
    if (ctx.queue.length > 0) runQueue();
    else log(`Nothing queued. Say '${config.commandPrefix}get <item> [count]' in chat.`);
});

bot.on("death", () => {
    log("Died. Will carry on after respawning.");
    ctx.stopCurrentAction();
});

bot.on("wake", () => log("Woke up."));

bot.on("kicked", (reason) => log(`Kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`));
bot.on("error", (err) => log(`Error: ${err.message}`));
bot.on("end", (reason) => {
    log(`Disconnected (${reason}).`);
    ctx.learn?.save();
    process.exit(0);
});
process.on("SIGINT", () => {
    ctx.learn?.save();
    process.exit(0);
});

// ---------- task queue ----------

function progress(task) {
    return ctx.countItem(task.item) - task.startCount + task.deposited;
}

async function runQueue() {
    if (ctx.busy) return;
    ctx.busy = true;
    try {
        if (ctx.idleWork) await ctx.idleWork; // e.g. finishing a meal
        while (ctx.queue.length > 0) {
            const task = ctx.queue.shift();
            ctx.current = { ...task, startCount: ctx.countItem(task.item), deposited: 0 };
            try {
                await runTask(ctx.current);
            } catch (err) {
                if (err instanceof ctx.Stopped) return;
                say(`Couldn't get ${task.item}: ${err.message}`);
            } finally {
                ctx.current = null;
            }
        }
        if (config.chest) await ctx.safely(ctx.depositAll);
        if (config.returnHome && ctx.home) await ctx.safely(() => ctx.goTo(ctx.home, 2));
        say("All tasks done.");
        if (config.quitWhenDone) bot.quit();
    } catch (err) {
        if (!(err instanceof ctx.Stopped)) log(err.message);
    } finally {
        ctx.busy = false;
        ctx.stopRequested = false;
    }
}

// The pathfinder places dirt/cobblestone to climb and bridge. Don't let it
// spend the items we were asked to collect.
function updateScaffolding() {
    const wanted = new Set([ctx.current, ...ctx.queue].filter(Boolean).map((t) => t.item));
    bot.pathfinder.movements.scafoldingBlocks = ["dirt", "cobblestone", "netherrack", "cobbled_deepslate"]
        .filter((name) => !wanted.has(name))
        .map((name) => bot.registry.itemsByName[name].id);
}

async function runTask(task) {
    updateScaffolding();
    say(`Getting ${task.count} ${task.item}.`);
    while (progress(task) < task.count) {
        ctx.checkStop();
        const need = task.count - progress(task);
        try {
            await ctx.obtain(task.item, ctx.countItem(task.item) + need);
        } catch (err) {
            if (!(err instanceof ctx.Retry)) throw err;
        }
    }
    say(`Got ${task.count} ${task.item}.`);
}

function statusText() {
    const vitals = `Health ${Math.round(bot.health)}/20, food ${bot.food}/20.`;
    if (!ctx.current) return `Idle. ${ctx.queue.length} task(s) queued. ${vitals}`;
    const t = ctx.current;
    return `Getting ${t.item}: ${Math.min(progress(t), t.count)}/${t.count}. ${ctx.queue.length} more queued. ${vitals}`;
}

// For one-off jobs outside the queue (farming, walking somewhere).
async function runExclusive(label, fn) {
    if (ctx.busy) return say(`I'm busy. Say ${config.commandPrefix}stop first.`);
    ctx.busy = true;
    try {
        await fn();
    } catch (err) {
        if (!(err instanceof ctx.Stopped)) say(`Couldn't ${label}: ${err.message}`);
    } finally {
        ctx.busy = false;
        ctx.stopRequested = false;
    }
}

const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"];

// ---------- commands (chat or terminal, plain text, no LLM) ----------

const HELP = "Commands: " + [
    "get <item> [count]", "plan <item>", "farm", "plant <crop> [plots]", "breed <animal> [pairs]",
    "brew <potion> [count] [long|strong|splash]", "sleep", "water", "bucket", "armor [material]",
    "learned", "forget", "stop", "status", "queue", "inv", "eat", "come", "deposit", "home", "quit",
]
    .map((c) => config.commandPrefix + c)
    .join(" | ");

async function handleCommand(text, fromPlayer) {
    if (!ctx.planner) return; // not spawned yet
    const [cmd, ...args] = text.trim().split(/\s+/);
    switch ((cmd || "").toLowerCase()) {
        case "get":
        case "gather":
        case "craft":
        case "smelt": {
            const item = args[0];
            if (!item) return say(`Usage: ${config.commandPrefix}get <item> [count]`);
            if (!bot.registry.itemsByName[item]) return say(`There's no item called ${item}.`);
            const count = parseInt(args[1] || "1", 10);
            ctx.queue.push({ item, count });
            say(`Queued ${count} ${item}.`);
            runQueue();
            break;
        }
        case "plan": {
            const item = args[0];
            if (!item || !bot.registry.itemsByName[item]) return say(`Usage: ${config.commandPrefix}plan <item>`);
            const lines = ctx.planner.explain(item);
            lines.forEach((line) => log(line));
            if (fromPlayer) lines.slice(0, 5).forEach((line) => bot.chat(line.trim()));
            break;
        }
        case "farm":
            // Harvest and replant every ripe crop nearby.
            await runExclusive("farm", async () => {
                const n = await ctx.harvestCrops();
                say(n ? `Harvested and replanted ${n} crops.` : "No ripe crops nearby.");
            });
            break;
        case "plant": {
            const name = args[0];
            const crop = ctx.kb.CROPS.find(
                (c) => c.block === name || c.seed === name || c.produces.includes(name)
            );
            if (!crop) return say(`Usage: ${config.commandPrefix}plant <wheat|carrot|potato|beetroot> [plots]`);
            const plots = parseInt(args[1] || String(config.farmSize), 10);
            await runExclusive("plant", () => ctx.plantCrop(crop, plots));
            break;
        }
        case "breed": {
            const animal = args[0];
            if (!animal || !ctx.kb.BREED_FOOD[animal]) {
                return say(`Usage: ${config.commandPrefix}breed <${Object.keys(ctx.kb.BREED_FOOD).join("|")}> [pairs]`);
            }
            const pairs = parseInt(args[1] || "1", 10);
            await runExclusive("breed", () => ctx.breed(animal, pairs));
            break;
        }
        case "brew": {
            const potion = args[0];
            if (!potion || !ctx.kb.POTIONS[potion]) {
                return say(`Usage: ${config.commandPrefix}brew <potion> [count] [long|strong|splash]. Potions: ${ctx.potionNames().join(", ")}`);
            }
            const count = parseInt(args[1] || "3", 10);
            await runExclusive("brew", () => ctx.brew(potion, count, args[2] || null));
            break;
        }
        case "sleep":
            await runExclusive("sleep", () => ctx.sleep({ getBed: true }));
            break;
        case "water":
            await runExclusive("place water", async () => {
                const pos = await ctx.placeWaterHere();
                say(`Placed water at ${ctx.fmt(pos)}.`);
            });
            break;
        case "bucket":
            await runExclusive("fill a bucket", async () => {
                await ctx.getWaterBucket();
                say("Got a water bucket.");
            });
            break;
        case "learned":
        case "memory": {
            const lines = ctx.learn.summary();
            lines.forEach((line) => log(line));
            if (fromPlayer) lines.slice(0, 4).forEach((line) => bot.chat(line.slice(0, 250)));
            break;
        }
        case "forget":
            ctx.learn.reset();
            say("Forgot everything I learned on this server.");
            break;
        case "armor": {
            const material = args[0];
            if (!material) {
                await ctx.safely(ctx.equipArmor);
                const worn = ctx.equipped().map((i) => i.name);
                say(worn.length ? `Wearing ${worn.join(", ")}.` : "No armor to wear.");
                break;
            }
            const pieces = ARMOR_PIECES.map((p) => `${material}_${p}`).filter(
                (name) => bot.registry.itemsByName[name] && ctx.countItem(name) === 0
            );
            if (pieces.length === 0) return say(`Already have ${material} armor, or no such material.`);
            for (const item of pieces) ctx.queue.push({ item, count: 1 });
            say(`Queued ${pieces.join(", ")}. I'll put them on as I get them.`);
            runQueue();
            break;
        }
        case "stop":
            ctx.queue.length = 0;
            if (ctx.busy) ctx.stopRequested = true;
            ctx.stopCurrentAction();
            if (bot.isSleeping) bot.wake().catch(() => {});
            say("Stopped and cleared the queue.");
            break;
        case "status":
            say(statusText());
            break;
        case "queue":
            say(ctx.queue.length ? ctx.queue.map((t) => `${t.item}x${t.count}`).join(", ") : "Queue is empty.");
            break;
        case "inv": {
            const items = bot.inventory.items().map((i) => `${i.name}x${i.count}`);
            say(items.length ? items.join(", ") : "Inventory is empty.");
            break;
        }
        case "eat":
            await ctx.safely(ctx.eat);
            break;
        case "come": {
            const player = fromPlayer && bot.players[fromPlayer]?.entity;
            if (!player) return say("I can't see you.");
            await runExclusive("come", () => ctx.goTo(player.position, 2));
            break;
        }
        case "deposit":
            if (!config.chest) return say("No chest configured.");
            await ctx.safely(ctx.depositAll);
            break;
        case "home":
            if (ctx.home) await ctx.safely(() => ctx.goTo(ctx.home, 2));
            break;
        case "quit":
            bot.quit();
            break;
        case "help":
            say(HELP);
            break;
        default:
            if (!fromPlayer) log(HELP);
    }
}

// Chat commands need the prefix (e.g. "!get oak_log 16"); whispers and the
// terminal accept them with or without it.
function stripPrefix(text) {
    const prefix = config.commandPrefix || "";
    return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

function fromOwner(username) {
    return username !== bot.username && (!config.owner || username === config.owner);
}

bot.on("chat", (username, message) => {
    if (!fromOwner(username)) return;
    const command = config.commandPrefix ? stripPrefix(message.trim()) : message;
    if (command === null) return;
    handleCommand(command, username).catch((err) => log(err.message));
});

bot.on("whisper", (username, message) => {
    if (!fromOwner(username)) return;
    handleCommand(stripPrefix(message.trim()) ?? message, username).catch((err) => log(err.message));
});

readline
    .createInterface({ input: process.stdin })
    .on("line", (line) =>
        handleCommand(stripPrefix(line.trim()) ?? line, null).catch((err) => log(err.message))
    );
