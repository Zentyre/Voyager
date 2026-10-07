const fs = require("fs");
const express = require("express");
const mineflayer = require("mineflayer");

const skills = require("./lib/skillLoader");
const {
    initCounter,
    getNextTime,
    runCommand,
    setGameRule,
} = require("./lib/utils");
const obs = require("./lib/observation/base");
const OnChat = require("./lib/observation/onChat");
const OnError = require("./lib/observation/onError");
const { Voxels, BlockRecords } = require("./lib/observation/voxels");
const Status = require("./lib/observation/status");
const Inventory = require("./lib/observation/inventory");
const OnSave = require("./lib/observation/onSave");
const Chests = require("./lib/observation/chests");
const { plugin: tool } = require("mineflayer-tool");

let bot = null;

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: false }));

// Whether the server tick loop is frozen with /tick freeze (1.20.3+), which
// stops the world while the agent waits for the language model.
let tickFrozen = false;

// Blocks a normal-player bot picks back up after placing them during a step.
const WORKSTATIONS = ["crafting_table", "furnace"];

app.post("/start", (req, res) => {
    if (bot) onDisconnect("Restarting bot");
    bot = null;
    console.log(req.body);
    tickFrozen = false;
    const auth = req.body.auth || "offline";
    bot = mineflayer.createBot({
        host: req.body.host || "localhost", // minecraft server ip
        port: req.body.port, // minecraft server port
        // for "microsoft" auth this only names the cached login; the in-game
        // name comes from the account
        username: req.body.username || "bot",
        auth,
        profilesFolder: req.body.authCacheDir || undefined,
        onMsaCode: (data) => {
            console.log(
                `[voyager-auth] Sign the bot in to its Microsoft account: open ` +
                    `${data.verification_uri} and enter the code ${data.user_code}`
            );
        },
        // false lets mineflayer detect the server version from its ping
        version: req.body.version || false,
        // online-mode servers may require signed chat; offline bots cannot sign
        disableChatSigning: auth !== "microsoft",
        checkTimeoutInterval: 60 * 60 * 1000,
    });
    // cheats: the bot is an operator and may use commands such as /give and /tp.
    // Without cheats it plays as a normal survival player.
    bot.voyagerCheats = req.body.cheats !== false;
    // whether bot.chat messages from skills are sent to the server's chat;
    // they always reach Voyager's chat log
    bot.voyagerChatToServer =
        req.body.chatToServer ?? bot.voyagerCheats;
    bot.once("error", onConnectionFailed);

    // Event subscriptions
    bot.waitTicks = req.body.waitTicks;
    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.stuckPosList = [];
    bot.iron_pickaxe = false;

    bot.on("kicked", onDisconnect);

    // mounting will cause physicsTick to stop
    bot.on("mount", () => {
        bot.dismount();
    });

    bot.once("spawn", async () => {
        bot.removeListener("error", onConnectionFailed);
        console.log(`Spawned as ${bot.username} (cheats: ${bot.voyagerCheats})`);
        // in case a previous bot left the world frozen
        runCommand(bot, "/tick unfreeze");
        let itemTicks = 1;
        if (req.body.reset === "hard" && bot.voyagerCheats) {
            runCommand(bot, "/clear @s");
            runCommand(bot, "/kill @s");
            const inventory = req.body.inventory ? req.body.inventory : {};
            const equipment = req.body.equipment
                ? req.body.equipment
                : [null, null, null, null, null, null];
            for (let key in inventory) {
                runCommand(bot, `/give @s minecraft:${key} ${inventory[key]}`);
                itemTicks += 1;
            }
            const equipmentNames = [
                "armor.head",
                "armor.chest",
                "armor.legs",
                "armor.feet",
                "weapon.mainhand",
                "weapon.offhand",
            ];
            for (let i = 0; i < 6; i++) {
                if (i === 4) continue;
                if (equipment[i]) {
                    runCommand(
                        bot,
                        `/item replace entity @s ${equipmentNames[i]} with minecraft:${equipment[i]}`
                    );
                    itemTicks += 1;
                }
            }
        }

        if (req.body.position) {
            runCommand(
                bot,
                `/tp @s ${req.body.position.x} ${req.body.position.y} ${req.body.position.z}`
            );
        }

        // if iron_pickaxe is in bot's inventory
        if (
            bot.inventory.items().find((item) => item.name === "iron_pickaxe")
        ) {
            bot.iron_pickaxe = true;
        }

        const { pathfinder } = require("mineflayer-pathfinder");
        const tool = require("mineflayer-tool").plugin;
        const collectBlock = require("mineflayer-collectblock").plugin;
        const pvp = require("mineflayer-pvp").plugin;
        const hawkEyeModule = require("minecrafthawkeye");
        // 1.3.7+ exports the plugin as `default`
        const minecraftHawkEye = hawkEyeModule.default || hawkEyeModule;
        bot.loadPlugin(pathfinder);
        bot.loadPlugin(tool);
        bot.loadPlugin(collectBlock);
        bot.loadPlugin(pvp);
        bot.loadPlugin(minecraftHawkEye);

        // bot.collectBlock.movements.digCost = 0;
        // bot.collectBlock.movements.placeCost = 0;

        obs.inject(bot, [
            OnChat,
            OnError,
            Voxels,
            Status,
            Inventory,
            OnSave,
            Chests,
            BlockRecords,
        ]);
        skills.inject(bot);

        if (req.body.spread && runCommand(bot, "/spreadplayers ~ ~ 0 300 under 80 false @s")) {
            await bot.waitForTicks(bot.waitTicks);
        }

        await bot.waitForTicks(bot.waitTicks * itemTicks);
        res.json(bot.observe());

        initCounter(bot);
        setGameRule(bot, "keepInventory", true);
        setGameRule(bot, "doDaylightCycle", false);
    });

    function onConnectionFailed(e) {
        console.log(e);
        bot = null;
        res.status(400).json({ error: e });
    }
    function onDisconnect(message) {
        if (bot.viewer) {
            bot.viewer.close();
        }
        bot.end();
        console.log(message);
        bot = null;
    }
});

app.post("/step", async (req, res) => {
    // import useful package
    let response_sent = false;
    function otherError(err) {
        console.log("Uncaught Error");
        bot.emit("error", handleError(err));
        bot.waitForTicks(bot.waitTicks).then(() => {
            if (!response_sent) {
                response_sent = true;
                res.json(bot.observe());
            }
        });
    }

    process.on("uncaughtException", otherError);

    const mcData = require("minecraft-data")(bot.version);
    mcData.itemsByName["leather_cap"] = mcData.itemsByName["leather_helmet"];
    mcData.itemsByName["leather_tunic"] =
        mcData.itemsByName["leather_chestplate"];
    mcData.itemsByName["leather_pants"] =
        mcData.itemsByName["leather_leggings"];
    mcData.itemsByName["leather_boots"] = mcData.itemsByName["leather_boots"];
    mcData.itemsByName["lapis_lazuli_ore"] = mcData.itemsByName["lapis_ore"];
    mcData.blocksByName["lapis_lazuli_ore"] = mcData.blocksByName["lapis_ore"];
    const {
        Movements,
        goals: {
            Goal,
            GoalBlock,
            GoalNear,
            GoalXZ,
            GoalNearXZ,
            GoalY,
            GoalGetToBlock,
            GoalLookAtBlock,
            GoalBreakBlock,
            GoalCompositeAny,
            GoalCompositeAll,
            GoalInvert,
            GoalFollow,
            GoalPlaceBlock,
        },
        pathfinder,
        Move,
        ComputedPath,
        PartiallyComputedPath,
        XZCoordinates,
        XYZCoordinates,
        SafeBlock,
        GoalPlaceBlockOptions,
    } = require("mineflayer-pathfinder");
    const { Vec3 } = require("vec3");

    // Set up pathfinder
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.stuckPosList = [];

    function onTick() {
        bot.globalTickCounter++;
        if (bot.pathfinder.isMoving()) {
            bot.stuckTickCounter++;
            if (bot.stuckTickCounter >= 100) {
                onStuck(1.5);
                bot.stuckTickCounter = 0;
            }
        }
    }

    bot.on("physicsTick", onTick);

    // initialize fail count
    let _craftItemFailCount = 0;
    let _killMobFailCount = 0;
    let _mineBlockFailCount = 0;
    let _placeItemFailCount = 0;
    let _smeltItemFailCount = 0;

    // Retrieve array form post bod
    const code = req.body.code;
    const programs = req.body.programs;
    bot.cumulativeObs = [];
    await bot.waitForTicks(bot.waitTicks);
    const workstationsBefore = findWorkstations();
    const r = await evaluateCode(code, programs);
    process.off("uncaughtException", otherError);
    if (r !== "success") {
        bot.emit("error", handleError(r));
    }
    if (bot.voyagerCheats) {
        await returnItems();
        setRespawnPoint();
    } else {
        await pickUpOwnWorkstations(workstationsBefore);
    }
    // wait for last message
    await bot.waitForTicks(bot.waitTicks);
    if (!response_sent) {
        response_sent = true;
        res.json(bot.observe());
    }
    bot.removeListener("physicsTick", onTick);

    async function evaluateCode(code, programs) {
        // Echo the code produced for players to see it. Don't echo when the bot code is already producing dialog or it will double echo
        try {
            await eval("(async () => {" + programs + "\n" + code + "})()");
            return "success";
        } catch (err) {
            return err;
        }
    }

    function onStuck(posThreshold) {
        const currentPos = bot.entity.position;
        bot.stuckPosList.push(currentPos);

        // Check if the list is full
        if (bot.stuckPosList.length === 5) {
            const oldestPos = bot.stuckPosList[0];
            const posDifference = currentPos.distanceTo(oldestPos);

            if (posDifference < posThreshold) {
                if (bot.voyagerCheats) teleportBot();
                else nudgeBot();
            }

            // Remove the oldest time from the list
            bot.stuckPosList.shift();
        }
    }

    function teleportBot() {
        const blocks = bot.findBlocks({
            matching: (block) => block.name === "air",
            maxDistance: 1,
            count: 27,
        });

        if (blocks.length > 0) {
            // console.log(blocks.length);
            const randomIndex = Math.floor(Math.random() * blocks.length);
            const block = blocks[randomIndex];
            runCommand(bot, `/tp @s ${block.x} ${block.y} ${block.z}`);
        } else {
            runCommand(bot, "/tp @s ~ ~1.25 ~");
        }
    }

    // Get unstuck without commands: jump forward in a random direction.
    async function nudgeBot() {
        await bot.look(Math.random() * 2 * Math.PI, 0, true);
        bot.setControlState("jump", true);
        bot.setControlState("forward", true);
        await bot.waitForTicks(10);
        bot.setControlState("jump", false);
        bot.setControlState("forward", false);
    }

    function findWorkstations() {
        const ids = WORKSTATIONS.map((name) => mcData.blocksByName[name].id);
        return new Set(
            bot
                .findBlocks({ matching: ids, maxDistance: 32, count: 256 })
                .map((p) => p.toString())
        );
    }

    // Normal-player version of returnItems: mine back the crafting tables and
    // furnaces that appeared during this step (so the bot placed them) and
    // collect the drops, so the bot keeps them like a player would. Blocks
    // that were already there, such as other players', are left alone.
    async function pickUpOwnWorkstations(before) {
        const placed = [...findWorkstations()].filter((p) => !before.has(p));
        for (const key of placed) {
            const [x, y, z] = key.slice(1, -1).split(", ").map(Number);
            const block = bot.blockAt(new Vec3(x, y, z));
            if (!block || !WORKSTATIONS.includes(block.name)) continue;
            let timer;
            try {
                await Promise.race([
                    bot.collectBlock.collect(block, { ignoreNoPath: true }),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error("timeout")), 30000);
                    }),
                ]);
            } catch (err) {
                bot.collectBlock.cancelTask?.();
                bot.pathfinder.stop();
                console.log(`Could not pick up ${block.name} at ${key}: ${err.message}`);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    // Respawn near where the bot is working instead of at world spawn. This
    // replaces the Better Respawn mod that older versions of Voyager needed.
    function setRespawnPoint() {
        const entity = bot.entity;
        if (!entity || bot.health <= 0 || !entity.onGround) return;
        if (entity.isInLava || entity.isInWater) return;
        const p = entity.position.floored();
        runCommand(bot, `/spawnpoint @s ${p.x} ${p.y} ${p.z}`);
    }

    function returnItems() {
        setGameRule(bot, "doTileDrops", false);
        const crafting_table = bot.findBlock({
            matching: mcData.blocksByName.crafting_table.id,
            maxDistance: 128,
        });
        if (crafting_table) {
            runCommand(
                bot,
                `/setblock ${crafting_table.position.x} ${crafting_table.position.y} ${crafting_table.position.z} air destroy`
            );
            runCommand(bot, "/give @s crafting_table");
        }
        const furnace = bot.findBlock({
            matching: mcData.blocksByName.furnace.id,
            maxDistance: 128,
        });
        if (furnace) {
            runCommand(
                bot,
                `/setblock ${furnace.position.x} ${furnace.position.y} ${furnace.position.z} air destroy`
            );
            runCommand(bot, "/give @s furnace");
        }
        if (bot.inventoryUsed() >= 32) {
            // if chest is not in bot's inventory
            if (!bot.inventory.items().find((item) => item.name === "chest")) {
                runCommand(bot, "/give @s chest");
            }
        }
        // if iron_pickaxe not in bot's inventory and bot.iron_pickaxe
        if (
            bot.iron_pickaxe &&
            !bot.inventory.items().find((item) => item.name === "iron_pickaxe")
        ) {
            runCommand(bot, "/give @s iron_pickaxe");
        }
        setGameRule(bot, "doTileDrops", true);
    }

    function handleError(err) {
        let stack = err.stack;
        if (!stack) {
            return err;
        }
        console.log(stack);
        const final_line = stack.split("\n")[1];
        const regex = /<anonymous>:(\d+):\d+\)/;

        const programs_length = programs.split("\n").length;
        let match_line = null;
        for (const line of stack.split("\n")) {
            const match = regex.exec(line);
            if (match) {
                const line_num = parseInt(match[1]);
                if (line_num >= programs_length) {
                    match_line = line_num - programs_length;
                    break;
                }
            }
        }
        if (!match_line) {
            return err.message;
        }
        let f_line = final_line.match(
            /\((?<file>.*):(?<line>\d+):(?<pos>\d+)\)/
        );
        if (f_line && f_line.groups && fs.existsSync(f_line.groups.file)) {
            const { file, line, pos } = f_line.groups;
            const f = fs.readFileSync(file, "utf8").split("\n");
            // let filename = file.match(/(?<=node_modules\\)(.*)/)[1];
            let source = file + `:${line}\n${f[line - 1].trim()}\n `;

            const code_source =
                "at " +
                code.split("\n")[match_line - 1].trim() +
                " in your code";
            return source + err.message + "\n" + code_source;
        } else if (
            f_line &&
            f_line.groups &&
            f_line.groups.file.includes("<anonymous>")
        ) {
            const { file, line, pos } = f_line.groups;
            let source =
                "Your code" +
                `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
            let code_source = "";
            if (line < programs_length) {
                source =
                    "In your program code: " +
                    programs.split("\n")[line - 1].trim() +
                    "\n";
                code_source = `at line ${match_line}:${code
                    .split("\n")
                    [match_line - 1].trim()} in your code`;
            }
            return source + err.message + "\n" + code_source;
        }
        return err.message;
    }
});

app.post("/stop", (req, res) => {
    if (bot) bot.end();
    res.json({
        message: "Bot stopped",
    });
});

// Freeze or resume the server tick loop. Vanilla /tick (1.20.3+) replaces the
// Multiplayer Server Pause mod that older versions of Voyager needed.
function setTickFrozen(frozen, res) {
    if (!bot) {
        res.status(400).json({ error: "Bot not spawned" });
        return;
    }
    // a normal player cannot freeze the world; the bot just waits
    if (tickFrozen !== frozen && runCommand(bot, frozen ? "/tick freeze" : "/tick unfreeze")) {
        tickFrozen = frozen;
    }
    res.json({ message: "Success", paused: tickFrozen });
}

app.post("/pause", (req, res) => setTickFrozen(true, res));
app.post("/unpause", (req, res) => setTickFrozen(false, res));

// Server listening to PORT 3000

const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
