// Lightweight, LLM-free resource gatherer built on the same Mineflayer stack
// Voyager uses. Give it a list of items, and it finds, mines, and picks them up.
//
//   node gatherer.js                          # uses config.json
//   node gatherer.js oak_log:64 cobblestone:32
//   node gatherer.js --config other.json coal:16

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { plugin: toolPlugin } = require("mineflayer-tool");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");
const { Vec3 } = require("vec3");

const DEFAULTS = {
    host: "localhost",
    port: 25565,
    username: "Gatherer",
    auth: "offline",
    version: false,
    owner: null,
    viewDistance: "tiny",
    searchRadius: 48,
    exploreDistance: 64,
    maxExploreAttempts: 8,
    chest: null,
    returnHome: true,
    quitWhenDone: false,
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

const queue = [...config.tasks];
let current = null; // { item, count, startCount, deposited }
let running = false;
let stopRequested = false;
let home = null;

function log(message) {
    console.log(`[gatherer] ${message}`);
}

function say(message) {
    log(message);
    if (bot.entity) bot.chat(message);
}

bot.once("spawn", () => {
    // Keep path computation cheap: short per-tick budget and a hard timeout.
    const movements = new Movements(bot);
    movements.allowParkour = false;
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 5000;
    bot.pathfinder.tickTimeout = 20;
    bot.collectBlock.movements = movements;
    // We handle chest deposits ourselves so progress stays accurate.
    bot.collectBlock.chestLocations = [];

    home = bot.entity.position.clone();
    log(`Spawned at ${fmt(home)} on ${bot.version}.`);
    if (queue.length > 0) runQueue();
    else log("Nothing queued. Say 'gather <item> [count]' in chat.");
});

bot.on("death", () => {
    log("Died. Pausing; current task will resume after respawn.");
    stopCurrentAction();
});

bot.on("kicked", (reason) => log(`Kicked: ${reason}`));
bot.on("error", (err) => log(`Error: ${err.message}`));
bot.on("end", (reason) => {
    log(`Disconnected (${reason}).`);
    process.exit(0);
});

// ---------- item -> block lookup ----------

// Every block that drops `itemName` when mined (e.g. coal -> coal_ore,
// deepslate_coal_ore; cobblestone -> stone, cobblestone).
function blocksThatDrop(itemName) {
    const item = bot.registry.itemsByName[itemName];
    const blocks = [];
    for (const block of bot.registry.blocksArray) {
        const drops = block.drops || [];
        const dropsItem =
            item &&
            drops.some((d) => (typeof d === "number" ? d : d.drop?.id ?? d.drop) === item.id);
        if (dropsItem || block.name === itemName) blocks.push(block);
    }
    return blocks;
}

function canHarvest(block) {
    if (!block.harvestTools) return true;
    return bot.inventory
        .items()
        .some((i) => block.harvestTools[i.type]);
}

function weakestToolFor(block) {
    const id = Object.keys(block.harvestTools || {})[0];
    return id ? bot.registry.items[id].name : "a tool";
}

function countItem(name) {
    return bot.inventory
        .items()
        .filter((i) => i.name === name)
        .reduce((sum, i) => sum + i.count, 0);
}

function progress(task) {
    return countItem(task.item) - task.startCount + task.deposited;
}

// ---------- main loop ----------

async function runQueue() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
        stopRequested = false;
        const task = queue.shift();
        current = {
            ...task,
            startCount: countItem(task.item),
            deposited: 0,
        };
        try {
            await gather(current);
        } catch (err) {
            say(`Problem gathering ${task.item}: ${err.message}`);
        }
        current = null;
        if (stopRequested) break;
    }
    running = false;

    if (stopRequested) return;
    if (config.chest) await safely(depositAll);
    if (config.returnHome && home) await safely(() => goTo(home, 2));
    say("All gathering tasks done.");
    if (config.quitWhenDone) bot.quit();
}

async function gather(task) {
    const sources = blocksThatDrop(task.item);
    if (sources.length === 0) {
        say(`I don't know any block that drops ${task.item}.`);
        return;
    }
    const harvestable = sources.filter(canHarvest);
    if (harvestable.length === 0) {
        say(`I need a ${weakestToolFor(sources[0])} (or better) to get ${task.item}.`);
        return;
    }
    const ids = harvestable.map((b) => b.id);
    say(`Gathering ${task.count} ${task.item}.`);

    let exploreAttempts = 0;
    let failedDigs = 0;
    const skipped = new Set(); // blocks we could not reach or break
    while (!stopRequested && progress(task) < task.count) {
        if (bot.inventory.emptySlotCount() < 2) {
            if (!config.chest) {
                say("Inventory is full and no chest is configured. Stopping.");
                return;
            }
            await depositAll();
            continue;
        }

        const positions = bot
            .findBlocks({
                matching: ids,
                maxDistance: config.searchRadius,
                count: 64,
            })
            .filter((p) => !skipped.has(p.toString()));
        if (positions.length === 0) {
            if (++exploreAttempts > config.maxExploreAttempts) {
                say(`Couldn't find any more ${task.item} nearby. Moving on.`);
                return;
            }
            log(`No ${task.item} source in range, exploring (${exploreAttempts}/${config.maxExploreAttempts}).`);
            await explore();
            continue;
        }
        exploreAttempts = 0;

        const block = bot.blockAt(positions[0]);
        let failure = null;
        try {
            await bot.collectBlock.collect(block, { ignoreNoPath: true });
        } catch (err) {
            failure = err.message;
        }
        if (stopRequested) return;
        // collectBlock swallows path errors, so check whether the block is gone.
        if (!failure && bot.blockAt(block.position)?.type === block.type) {
            failure = "unreachable";
        }
        if (failure) {
            skipped.add(block.position.toString());
            log(`Skipping ${block.name} at ${fmt(block.position)}: ${failure}`);
            if (++failedDigs > 10) {
                say(`Too many failures getting ${task.item}. Moving on.`);
                return;
            }
        } else {
            failedDigs = 0;
        }
        log(`${task.item}: ${Math.min(progress(task), task.count)}/${task.count}`);
    }
    if (!stopRequested) say(`Finished gathering ${task.count} ${task.item}.`);
}

async function explore() {
    const angle = Math.random() * Math.PI * 2;
    const pos = bot.entity.position;
    const x = Math.floor(pos.x + Math.cos(angle) * config.exploreDistance);
    const z = Math.floor(pos.z + Math.sin(angle) * config.exploreDistance);
    await safely(() =>
        withTimeout(bot.pathfinder.goto(new goals.GoalXZ(x, z)), 60000)
    );
}

async function depositAll() {
    const chestPos = new Vec3(config.chest.x, config.chest.y, config.chest.z);
    await goTo(chestPos, 2);
    const chestBlock = bot.blockAt(chestPos);
    if (!chestBlock || !chestBlock.name.includes("chest")) {
        say(`No chest at ${fmt(chestPos)}.`);
        return;
    }
    const chest = await bot.openContainer(chestBlock);
    try {
        const wanted = new Set(
            [current, ...queue, ...config.tasks].filter(Boolean).map((t) => t.item)
        );
        for (const item of bot.inventory.items()) {
            if (!wanted.has(item.name)) continue;
            try {
                await chest.deposit(item.type, null, item.count);
                if (current && item.name === current.item) {
                    current.deposited += item.count;
                }
            } catch (err) {
                say(`Chest is full: ${err.message}`);
                break;
            }
        }
    } finally {
        chest.close();
    }
    log("Deposited items in chest.");
}

// ---------- helpers ----------

function goTo(pos, range = 1) {
    return bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
}

function withTimeout(promise, ms) {
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
}

async function safely(fn) {
    try {
        await fn();
    } catch (err) {
        log(err.message);
    }
}

function stopCurrentAction() {
    bot.pathfinder.setGoal(null);
    bot.collectBlock.cancelTask().catch(() => {});
}

function fmt(pos) {
    return `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`;
}

function statusText() {
    if (!current) return `Idle. ${queue.length} task(s) queued.`;
    return `Gathering ${current.item}: ${Math.min(progress(current), current.count)}/${current.count}. ${queue.length} more queued.`;
}

// ---------- commands (chat or terminal, plain text, no LLM) ----------

const HELP =
    "Commands: gather <item> [count] | stop | status | queue | come | deposit | home | quit";

async function handleCommand(text, fromPlayer) {
    const [cmd, ...args] = text.trim().split(/\s+/);
    switch ((cmd || "").toLowerCase()) {
        case "gather": {
            if (!args[0]) return say("Usage: gather <item> [count]");
            queue.push({ item: args[0], count: parseInt(args[1] || "1", 10) });
            say(`Queued ${args[1] || 1} ${args[0]}.`);
            runQueue();
            break;
        }
        case "stop":
            stopRequested = true;
            queue.length = 0;
            stopCurrentAction();
            say("Stopped and cleared the queue.");
            break;
        case "status":
            say(statusText());
            break;
        case "queue":
            say(queue.length ? queue.map((t) => `${t.item}x${t.count}`).join(", ") : "Queue is empty.");
            break;
        case "come": {
            const player = fromPlayer && bot.players[fromPlayer]?.entity;
            if (!player) return say("I can't see you.");
            await safely(() => goTo(player.position, 2));
            break;
        }
        case "deposit":
            if (!config.chest) return say("No chest configured.");
            await safely(depositAll);
            break;
        case "home":
            if (home) await safely(() => goTo(home, 2));
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

bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (config.owner && username !== config.owner) return;
    handleCommand(message, username);
});

readline
    .createInterface({ input: process.stdin })
    .on("line", (line) => handleCommand(line, null));
