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
    commandPrefix: "!",
    viewDistance: "normal",
    searchRadius: 110,
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
    useBow: true,
    bowRange: 24,
    guardRadius: 12,
    followDistance: 3,
    guardAgainstPlayers: false,
    farm: true,
    farmSize: 9,
    farmWaitMinutes: 30,
    placeWater: true,
    keepAnimals: 2,
    autoSleep: true,
    bringBed: false,
    learn: true,
    memoryFile: null, // default: memory/<username>.json
    memoryRange: 400,
    returnHome: true,
    quitWhenDone: false,
    chatter: true,
    reconnect: true, // crew mode: rejoin after being kicked or disconnected
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

// Finish one bot's settings (fills in its memory file).
function finishBotConfig(config) {
    const c = { ...config };
    delete c.bots;
    if (!c.memoryFile) c.memoryFile = path.join("memory", `${c.username}.json`);
    return c;
}

// One settings object per bot: just the main config, or one per crew member
// (shared settings + that member's overrides).
function botConfigs(config) {
    if (!Array.isArray(config.bots) || config.bots.length === 0) return [finishBotConfig(config)];
    return config.bots.map((member, i) =>
        finishBotConfig({
            ...config,
            tasks: [], // crew tasks go in each member's own "tasks"
            ...member,
            username: member.username || `${config.username}${i + 1}`,
        })
    );
}

module.exports = { DEFAULTS, loadConfig, botConfigs, parseTask };
