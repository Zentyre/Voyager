// Lightweight, LLM-free Minecraft bot built on the same Mineflayer stack
// Voyager uses. Ask for items and it mines, crafts, smelts, farms, or hunts for
// them; it also breeds animals, brews potions, sleeps, handles water, wears
// armor, fights (sword or bow), and can bodyguard a player. It learns from
// experience (statistics, not an LLM) and remembers what it learned.
//
// Run one bot, or a crew of several that can work separately or together
// (list them under "bots" in config.json).
//
//   node gatherer.js                          # uses config.json
//   node gatherer.js oak_log:64 iron_pickaxe:1
//   node gatherer.js --config other.json coal:16
//   node gatherer.js --bot Miner              # just one bot from "bots"
//
// While it runs, http://localhost:3000 shows a dashboard to watch and command the bots.

// Teach the Minecraft libraries about versions newer than they ship (26.3).
require("./lib/compat").registerExtraVersions();

const { loadConfig, botConfigs } = require("./lib/config");

const config = loadConfig(process.argv.slice(2));
let configs;
try {
    configs = botConfigs(config);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

if (configs.length > 1) {
    require("./lib/crew").startCrew(configs);
} else {
    const config = configs[0];
    let reporter = null;
    if (config.dashboard !== false) {
        const handlers = [];
        const hub = require("./lib/dashboard").startDashboard(config.dashboard, {
            names: [config.username],
            onCommand: (target, text) => handlers.forEach((fn) => fn(text)),
        });
        reporter = {
            status: (s) => hub.status(s),
            log: (line) => hub.log(config.username, line),
            onCommand: (fn) => handlers.push(fn),
        };
    }
    require("./lib/bot").startBot(config, null, reporter);
}
