let gameTimeCounter = 0;
let gameTimeList = [];
const initCounter = (bot) => {
    gameTimeList = [];
    for (let i = 0; i < 13000; i += 1000) {
        gameTimeList.push(i);
    }
    for (let i = 13000; i < 24000; i += 2000) {
        gameTimeList.push(i);
    }
    const timeOfDay = bot.time.timeOfDay;
    for (let i = 0; i < gameTimeList.length; i++) {
        if (gameTimeList[i] > timeOfDay) {
            gameTimeCounter = i - 1;
            break;
        }
    }
};

const getNextTime = () => {
    gameTimeCounter++;
    if (gameTimeCounter >= gameTimeList.length) {
        gameTimeCounter = 0;
    }
    return gameTimeList[gameTimeCounter];
};

// 1.21.11 renamed every game rule to snake_case. Callers use the old
// camelCase names; this maps them for newer servers.
const GAMERULE_RENAMES = {
    keepInventory: "keep_inventory",
    doDaylightCycle: "advance_time",
    doTileDrops: "block_drops",
    doMobSpawning: "spawn_mobs",
};

const gameruleName = (bot, name) => {
    if (bot.registry.version[">="]("1.21.11") && GAMERULE_RENAMES[name]) {
        return GAMERULE_RENAMES[name];
    }
    return name;
};

// Send an operator command. In normal-player mode (bot.voyagerCheats false)
// the bot has no operator rights, so nothing is sent and false is returned.
// Uses the raw chat sender so the command is not echoed into the chat log.
const runCommand = (bot, command) => {
    if (!bot.voyagerCheats) return false;
    (bot._chat || bot.chat)(command);
    return true;
};

const setGameRule = (bot, name, value) =>
    runCommand(bot, `/gamerule ${gameruleName(bot, name)} ${value}`);

module.exports = {
    initCounter,
    getNextTime,
    gameruleName,
    runCommand,
    setGameRule,
};
