// One bot: connects, sets up every module, runs its task queue and handles
// commands. Used on its own (single bot) or once per crew member, each in its
// own worker thread (see crew.js).

const path = require("path");
const readline = require("readline");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const { plugin: toolPlugin } = require("mineflayer-tool");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");

const { createContext } = require("./context");
const { createKnowledge } = require("./knowledge");
const { createPlanner } = require("./planner");
const { installActions } = require("./actions");
const { installSurvival } = require("./survival");
const { installFarming } = require("./farming");
const { installCombat } = require("./combat");
const { installAnimals } = require("./animals");
const { installWater } = require("./water");
const { installBrewing } = require("./brewing");
const { createLearning } = require("./learning");
const { installArchery } = require("./archery");
const { installBodyguard } = require("./bodyguard");

const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"];
const GEAR = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(bow|shield|arrow|spectral_arrow|tipped_arrow|bucket|water_bucket)$/;

// The server's Minecraft version, if the bot can speak it; otherwise the
// newest version it can (which works when the server runs ViaVersion +
// ViaBackwards, plugins that let older clients join newer servers).
async function pickVersion(config) {
    const mcData = require("minecraft-data");
    const newest = mineflayer.latestSupportedVersion;
    let server;
    try {
        server = await require("minecraft-protocol").ping({ host: config.host, port: config.port });
    } catch (err) {
        return false; // can't ping; let mineflayer try on its own
    }
    const name = (String(server?.version?.name || "").match(/\d+\.\d+(\.\d+)?/) || [])[0];
    const known = name && mcData(name);
    if (known?.protocol) return false; // supported: auto-detect works
    console.log(
        `[${config.username}] This server runs Minecraft ${name || server?.version?.name}, but the bot's ` +
            `Minecraft library only supports up to ${newest} so far. Connecting as ${newest}: that works if ` +
            `the server has the ViaVersion and ViaBackwards plugins. Without them it will say "Outdated client".`
    );
    return newest;
}

function startBot(config, crew = null) {
    if (!config.version) {
        pickVersion(config).then((version) => createBot({ ...config, version }, crew));
        return;
    }
    return createBot(config, crew);
}

function createBot(config, crew) {
    const microsoft = config.auth === "microsoft";
    const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        // With Microsoft accounts this is just a label for the saved login;
        // the in-game name comes from the account itself.
        username: config.username,
        auth: config.auth,
        version: config.version || undefined,
        viewDistance: config.viewDistance,
        // Online-mode servers usually require signed chat; offline ones don't,
        // so skip the signing work there.
        disableChatSigning: !microsoft,
        // Saved logins live in gatherer/accounts/ (git-ignored, keep private).
        profilesFolder: path.resolve(__dirname, "..", "accounts"),
        onMsaCode: (data) => {
            const text =
                `Sign in the Minecraft account for bot "${config.username}": open ${data.verification_uri} ` +
                `and enter code ${data.user_code} (expires in ${Math.round(data.expires_in / 60)} min).`;
            console.log(`\n===== ${text} =====\n`);
        },
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(collectBlockPlugin);

    const ctx = createContext(bot, config);
    ctx.crew = crew;
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
        installArchery(ctx);
        installBodyguard(ctx);

        // Keep path computation bounded: per-tick budget and a hard timeout.
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
        log(`Spawned at ${ctx.fmt(ctx.home)} on ${bot.version}${bot.username !== config.username ? ` as ${bot.username}` : ""}.`);
        if (crew) crew.online(bot.username);
        if (ctx.queue.length > 0) runQueue();
        else if (!crew) log(`Nothing queued. Say '${config.commandPrefix}get <item> [count]' in chat.`);
    });

    bot.on("death", () => {
        log("Died. Will carry on after respawning.");
        ctx.stopCurrentAction();
    });

    bot.on("wake", () => log("Woke up."));
    bot.on("kicked", (reason) => {
        const text = typeof reason === "string" ? reason : JSON.stringify(reason);
        log(`Kicked: ${text}`);
        if (/outdated|incompatible|version/i.test(text)) {
            log(
                `The server doesn't accept this bot's Minecraft version (${bot.version}). Install the ViaVersion ` +
                    `and ViaBackwards plugins on the server, or set "version" in config.json to the server's version once supported.`
            );
        }
    });
    bot.on("error", (err) => log(`Error: ${err.message}`));
    bot.on("end", (reason) => {
        log(`Disconnected (${reason}).`);
        if (/session|authenticat|token/i.test(String(reason))) {
            log("This looks like a login problem. Delete this bot's files in gatherer/accounts/ and sign in again.");
        }
        ctx.learn?.save();
        if (crew) crew.offline(reason === "disconnect.quitting");
        process.exit(0); // in a worker thread this ends just this bot
    });
    if (!crew) {
        process.on("SIGINT", () => {
            ctx.learn?.save();
            process.exit(0);
        });
    }

    // ---------- task queue ----------

    function setBusy(busy) {
        ctx.busy = busy;
        if (crew) crew.setBusy(busy);
    }

    function progress(task) {
        return ctx.countItem(task.item) - task.startCount + task.deposited;
    }

    async function runQueue() {
        if (ctx.busy) return;
        setBusy(true);
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
            setBusy(false);
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
        if (ctx.ward) return `Guarding ${ctx.ward}. ${vitals} Arrows: ${ctx.arrowCount()}.`;
        if (!ctx.current) return `Idle. ${ctx.queue.length} task(s) queued. ${vitals}`;
        const t = ctx.current;
        return `Getting ${t.item}: ${Math.min(progress(t), t.count)}/${t.count}. ${ctx.queue.length} more queued. ${vitals}`;
    }

    // For one-off jobs outside the queue (farming, walking somewhere).
    async function runExclusive(label, fn) {
        if (ctx.busy) return say(`I'm busy. Say ${config.commandPrefix}stop first.`);
        setBusy(true);
        try {
            await fn();
        } catch (err) {
            if (!(err instanceof ctx.Stopped)) say(`Couldn't ${label}: ${err.message}`);
        } finally {
            setBusy(false);
            ctx.stopRequested = false;
        }
    }

    // Walk to a player and drop items for them.
    async function give(player, what, count) {
        await ctx.goTo(player.position, 2);
        await bot.lookAt(player.position.offset(0, 1.6, 0), true);
        const items = bot.inventory
            .items()
            .filter((i) => (what && what !== "all" ? i.name === what : !GEAR.test(i.name)));
        let left = count;
        const given = {};
        for (const item of items) {
            if (left <= 0) break;
            const n = Math.min(item.count, left);
            await bot.toss(item.type, null, n);
            given[item.name] = (given[item.name] || 0) + n;
            left -= n;
        }
        return given;
    }

    // ---------- commands (chat or terminal, plain text, no LLM) ----------

    const HELP = "Commands: " + [
        "get <item> [count]", "plan <item>", "farm", "plant <crop> [plots]", "breed <animal> [pairs]",
        "brew <potion> [count] [long|strong|splash]", "sleep", "water", "bucket", "armor [material]",
        "guard [player]", "bow [arrows]", "give [item|all] [count]",
        "learned", "forget", "stop", "status", "queue", "inv", "eat", "come", "deposit", "home", "quit",
    ]
        .map((c) => config.commandPrefix + c)
        .join(" | ") + (crew ? ` | crew: ${config.commandPrefix}<botname> <cmd>, ${config.commandPrefix}all <cmd>, ${config.commandPrefix}crew` : "");

    // `broadcast` is true when the whole crew got this command: then a bot
    // with nothing to contribute stays quiet instead of everyone saying so.
    async function handleCommand(text, fromPlayer, { broadcast = false } = {}) {
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
                if (!(count > 0)) return;
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
            case "guard":
            case "bodyguard":
            case "protect": {
                const name = args[0] || fromPlayer;
                if (!name) return say(`Usage: ${config.commandPrefix}guard <player>`);
                if (name === bot.username) return say("I can't guard myself.");
                await runExclusive("guard", () => ctx.bodyguard(name));
                break;
            }
            case "bow": {
                // Get a bow and some arrows, then it uses them in fights.
                const arrows = parseInt(args[0] || "16", 10);
                const needBow = ctx.countItem("bow") === 0;
                const missing = arrows - ctx.arrowCount();
                if (!needBow && missing <= 0) return say(`I already have a bow and ${ctx.arrowCount()} arrows.`);
                if (needBow) ctx.queue.push({ item: "bow", count: 1 });
                if (missing > 0) ctx.queue.push({ item: "arrow", count: missing });
                say(`Getting ${needBow ? "a bow and " : ""}${Math.max(0, missing)} arrows.`);
                runQueue();
                break;
            }
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
            case "give":
            case "drop": {
                const player = fromPlayer && bot.players[fromPlayer]?.entity;
                if (!player) return broadcast ? undefined : say("I can't see you.");
                const what = args[0] || "all";
                const count = args[1] ? parseInt(args[1], 10) : Infinity;
                const has = what === "all" ? bot.inventory.items().some((i) => !GEAR.test(i.name)) : ctx.countItem(what) > 0;
                if (!has) return broadcast ? undefined : say(`I don't have any ${what === "all" ? "items to give" : what}.`);
                await runExclusive("give", async () => {
                    const given = await give(player, what, count);
                    const list = Object.entries(given).map(([n, c]) => `${c} ${n}`).join(", ");
                    say(list ? `Here you go: ${list}.` : "Nothing to give.");
                });
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
                if (!player) return broadcast ? undefined : say("I can't see you.");
                await runExclusive("come", () => ctx.goTo(player.position, 2));
                break;
            }
            case "deposit":
                if (!config.chest) return broadcast ? undefined : say("No chest configured.");
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

    // Who is a command for? "<myname> cmd" and "all cmd" are for me;
    // "<othername> cmd" is not; anything else goes to the crew (in crew mode)
    // or to me (single bot). Returns the command text for me, or null.
    function route(text, fromPlayer) {
        const [first, ...rest] = text.trim().split(/\s+/);
        const word = (first || "").toLowerCase();
        if (word === "all" || word === bot.username.toLowerCase() || word === config.username.toLowerCase()) {
            return rest.join(" ");
        }
        if (!crew) return text;
        if (crew.members().has(word)) return null; // for another crew member
        // Unaddressed: the crew leader passes it to the coordinator, which
        // splits it up or picks who does it.
        if (crew.isLeader()) crew.send({ type: "crewCommand", text, from: fromPlayer });
        return null;
    }

    // Chat commands need the prefix (e.g. "!get oak_log 16"); whispers and the
    // terminal accept them with or without it.
    function stripPrefix(text) {
        const prefix = config.commandPrefix || "";
        return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : null;
    }

    function fromOwner(username) {
        if (username === bot.username || crew?.members().has(username.toLowerCase())) return false;
        return !config.owner || username === config.owner;
    }

    function run(text, from, opts) {
        handleCommand(text, from, opts).catch((err) => log(err.message));
    }

    bot.on("chat", (username, message) => {
        if (!fromOwner(username)) return;
        const command = config.commandPrefix ? stripPrefix(message.trim()) : message;
        if (command === null) return;
        const mine = route(command, username);
        if (mine !== null) run(mine, username);
    });

    // A whisper is always meant for this bot.
    bot.on("whisper", (username, message) => {
        if (!fromOwner(username)) return;
        const text = stripPrefix(message.trim()) ?? message;
        const [first, ...rest] = text.trim().split(/\s+/);
        run(first?.toLowerCase() === bot.username.toLowerCase() ? rest.join(" ") : text, username);
    });

    if (crew) {
        // Commands handed out by the crew coordinator.
        crew.onCommand(({ text, from, broadcast }) => run(text, from, { broadcast }));
        crew.onSay((text) => say(text));
        crew.onQuit(() => {
            ctx.learn?.save();
            bot.quit();
        });
    } else {
        readline
            .createInterface({ input: process.stdin })
            .on("line", (line) => {
                const text = stripPrefix(line.trim()) ?? line;
                const mine = route(text, null);
                if (mine !== null) run(mine, null);
            });
    }

    return { bot, ctx };
}

module.exports = { startBot, pickVersion };
