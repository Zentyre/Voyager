// Settings: defaults, config.json, command-line tasks, and per-bot settings
// for crews.

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
    host: "localhost",
    port: 25565,
    username: "Gatherer",
    auth: "offline",
    version: false,
    owner: "Zentyre",
    admins: [], // more players whose chat commands the bots obey, besides the owner
    commandPrefix: "!",
    viewDistance: "normal",
    searchRadius: 110,
    stationRadius: 24,
    workbenchRange: 64, // go back to a crafting table / furnace it knows of within this, rather than make one
    exploreDistance: 64,
    maxExploreAttempts: 8,
    chest: null,
    protectRadius: 0,
    extraMineable: [],
    hunt: true,
    defend: true,
    defendRadius: 8,
    sprintJump: true, // jump while sprinting on straight runs: faster, uses a little more food
    attackReach: 5, // melee reach, eyes to the mob's hitbox (a player gets 3; servers accept up to 6)
    fleeHealth: 6,
    eatBelow: 14,
    findFoodBelow: 8,
    autoArmor: true,
    useShield: true,
    useBow: true,
    bowRange: 24,
    guardRadius: 12,
    followDistance: 3,
    guardAgainstPlayers: false,
    farm: true,
    farmSize: 9,
    farmWaitMinutes: 30,
    placeWater: true,
    autoSleep: true,
    bringBed: false,
    learn: true,
    memoryFile: null, // default: memory/<username>.json
    memoryRange: 400,
    returnHome: true,
    quitWhenDone: false,
    chatter: true,
    reconnect: true, // crew mode: rejoin after being kicked or disconnected
    dashboard: { port: 3000 }, // web page (on this computer only) to watch and command the bots; false to turn off
    deathWhisper: true, // /msg the owner where a bot died
    autoStart: [], // with Start Dashboard.vbs: bots to start right away (names, or true for all)
    // builder profile: chests to take materials from (besides any within
    // chestRadius of the build and of home), and "clear" to dig out anything
    // in the way (by default only natural ground and plants)
    build: { chests: [], chestRadius: 24, maxChests: 16, clear: false },
    tasks: [],
    bots: [], // crew mode: [{ "username": "Miner" }, { "username": "Farmer", ... }]
};

function parseTask(text) {
    const [item, count] = text.split(":");
    return { item: item.trim(), count: count ? parseInt(count, 10) : 1 };
}

function loadConfig(argv) {
    let configPath = path.join(__dirname, "..", "config.json");
    const cliTasks = [];
    const only = [];
    let manager = false; // run from the dashboard (Start Dashboard.vbs)
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--config") {
            configPath = path.resolve(argv[++i]);
        } else if (argv[i] === "--manager") {
            manager = true;
        } else if (argv[i] === "--bot") {
            only.push(...argv[++i].split(",").map((n) => n.trim()).filter(Boolean));
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
    if (only.length > 0) config.only = only;
    if (manager) config.manager = true;
    return config;
}

// Finish one bot's settings (fills in its memory file).
function finishBotConfig(config) {
    const c = { ...config };
    delete c.bots;
    // "owner": ["Zentyre", "Friend"] works too: the first is the owner, the rest admins.
    const owners = Array.isArray(c.owner) ? c.owner.filter(Boolean) : [];
    if (Array.isArray(c.owner)) c.owner = owners[0] || null;
    const admins = typeof c.admins === "string" ? [c.admins] : Array.isArray(c.admins) ? c.admins : [];
    c.admins = [...owners.slice(1), ...admins].filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim());
    if (!c.memoryFile) c.memoryFile = path.join("memory", `${c.username}.json`);
    return c;
}

// One settings object per bot: just the main config, or one per crew member
// (shared settings + that member's overrides). "--bot Name" keeps only the
// named members.
function botConfigs(config) {
    const { only, ...shared } = config;
    if (!Array.isArray(shared.bots) || shared.bots.length === 0) return [finishBotConfig(shared)];
    let configs = shared.bots.map((member, i) =>
        finishBotConfig({
            ...shared,
            tasks: [], // crew tasks go in each member's own "tasks"
            ...member,
            username: member.username || `${shared.username}${i + 1}`,
        })
    );
    if (only) {
        const wanted = only.map((n) => n.toLowerCase());
        const missing = only.filter((n) => !configs.some((c) => c.username.toLowerCase() === n.toLowerCase()));
        if (missing.length > 0) {
            const names = configs.map((c) => c.username).join(", ");
            throw new Error(`No bot named ${missing.join(", ")} in config.json. Bots there: ${names}.`);
        }
        configs = configs.filter((c) => wanted.includes(c.username.toLowerCase()));
    }
    return configs;
}

module.exports = { DEFAULTS, loadConfig, botConfigs, parseTask };
