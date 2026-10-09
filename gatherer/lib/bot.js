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
const { installBuilding } = require("./building");
const { installSwimming } = require("./swimming");
const { installClimbing } = require("./climbing");
const { installSpin } = require("./spin");
const { createProfiles } = require("./profiles");
const { loginStorage } = require("./accounts");
const { savedChest, saveChest } = require("./chests");
const { Vec3 } = require("vec3");
const { patchBot } = require("./compat");
const { installModSupport } = require("./mods");
const { addresses } = require("./commands");

// bot.findBlocks skips chunk sections whose palette lacks the block, but a
// section made of one block (all air, say) has no palette, so it checked all
// 4096 positions of each one: searching for something not nearby froze the bot
// for over a second. Give those sections a one-entry palette.
try {
    const { SingleValueContainer } = require("prismarine-chunk/src/pc/common/PaletteContainer");
    if (!("palette" in SingleValueContainer.prototype)) {
        Object.defineProperty(SingleValueContainer.prototype, "palette", {
            get() {
                return [this.value];
            },
        });
    }
} catch (err) {
    // a newer prismarine-chunk laid out differently: searches are just slower
}

const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"];
const WORKBENCHES = ["crafting_table", "furnace", "brewing_stand", "smoker", "blast_furnace"];

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

// `reporter` (optional) receives this bot's status and log lines for the
// dashboard: { status(snapshot), log(line), onCommand(fn) }.
function startBot(config, crew = null, reporter = null) {
    if (!config.version) {
        pickVersion(config).then((version) => createBot({ ...config, version }, crew, reporter));
        return;
    }
    return createBot(config, crew, reporter);
}

function createBot(config, crew, reporter) {
    const microsoft = config.auth === "microsoft";
    // The unload chest: one set in game ("setchest") wins over config.json's.
    const configChest = config.chest;
    if (savedChest(config.username)) config.chest = savedChest(config.username);
    const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        // With Microsoft accounts this is just a label for the saved login;
        // the in-game name comes from the account itself.
        username: config.username,
        auth: config.auth,
        version: config.version || undefined,
        viewDistance: config.viewDistance,
        // Hang up after this long without a keep-alive. compat.js disconnects
        // sooner if the server sends nothing at all for a minute.
        checkTimeoutInterval: 10 * 60 * 1000,
        // Online-mode servers usually require signed chat; offline ones don't,
        // so skip the signing work there.
        disableChatSigning: !microsoft,
        // Saved logins live in gatherer/accounts/ (git-ignored, keep private),
        // kept and refreshed carefully so they last (see accounts.js).
        profilesFolder: microsoft ? loginStorage(path.resolve(__dirname, "..", "accounts"), (m) => console.log(m)) : path.resolve(__dirname, "..", "accounts"),
        onMsaCode: (data) => {
            const text =
                `Sign in the Minecraft account for bot "${config.username}": open ${data.verification_uri} ` +
                `and enter code ${data.user_code} (expires in ${Math.round(data.expires_in / 60)} min).`;
            console.log(`\n===== ${text} =====\n`);
            reporter?.signIn?.({
                uri: data.verification_uri,
                code: data.user_code,
                expiresAt: Date.now() + data.expires_in * 1000,
            });
        },
    });

    patchBot(bot); // packet changes in Minecraft 26.2/26.3
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(collectBlockPlugin);

    const ctx = createContext(bot, config);
    ctx.crew = crew;
    ctx.queue.push(...config.tasks);
    if (reporter) {
        const print = ctx.log;
        ctx.log = (message) => {
            print(message);
            reporter.log(message);
        };
    }
    const { log, say } = ctx;
    if (bot.registry) installModSupport(bot, log);
    else bot.once("inject_allowed", () => installModSupport(bot, log));

    bot.once("spawn", () => {
        ctx.kb = createKnowledge(bot, config);
        ctx.learn = createLearning(ctx);
        ctx.planner = createPlanner(ctx);
        installActions(ctx);
        installCombat(ctx);
        installSurvival(ctx);
        installSwimming(ctx);
        installFarming(ctx);
        installAnimals(ctx);
        installWater(ctx);
        installBrewing(ctx);
        installArchery(ctx);
        installBodyguard(ctx);
        installBuilding(ctx);
        installSpin(ctx);
        ctx.profiles = createProfiles(ctx);
        if (ctx.profiles.name !== "default") log(`Profile: ${ctx.profiles.name}.`);

        // Keep path computation bounded: per-tick budget and a hard timeout.
        const movements = new Movements(bot);
        movements.allowParkour = false;
        // Swimming is slow and uses air: walk round or bridge a lake when it's not far.
        movements.liquidCost = 3;
        // Never dig through farms, chests, beds, doors, etc. on the way somewhere.
        for (const id of ctx.kb.neverBreakIds()) movements.blocksCantBreak.add(id);
        const modded = bot.registry.blocksByName.modded_block;
        if (modded) movements.blocksCantBreak.add(modded.id);
        // A fence or wall with carpet on top can be jumped onto and walked over
        // like a full block. The pathfinder took carpet for air and a fence for
        // too tall to climb, so it dug through instead.
        const getBlock = movements.getBlock.bind(movements);
        movements.getBlock = (pos, dx, dy, dz) => {
            const b = getBlock(pos, dx, dy, dz);
            if (pos && movements.fences.has(b.type)) {
                const above = bot.blockAt(b.position.offset(0, 1, 0), false);
                if (above && movements.carpets.has(above.type)) {
                    b.physical = true;
                    b.height = pos.y + dy + 1;
                }
            }
            return b;
        };
        // Nor tunnel under a fence or wall (it tried, a block or two down):
        // that opens a pen as much as breaking it.
        const safeToBreak = movements.safeToBreak.bind(movements);
        movements.safeToBreak = (block) => {
            for (let dy = 1; dy <= 3; dy++) {
                const above = bot.blockAt(block.position.offset(0, dy, 0), false);
                if (above && movements.fences.has(above.type)) return false;
            }
            return safeToBreak(block);
        };
        installClimbing(ctx, movements);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.thinkTimeout = 10000;
        bot.pathfinder.tickTimeout = 30;
        bot.collectBlock.movements = movements;
        // We handle chest deposits ourselves so progress stays accurate.
        bot.collectBlock.chestLocations = [];

        ctx.home = bot.entity.position.clone();
        ctx.equipArmor().catch(() => {});
        log(`Spawned at ${ctx.fmt(ctx.home)} on ${bot.version}${bot.username !== config.username ? ` as ${bot.username}` : ""}.`);
        if (config.chest) log(`Unloading into the chest at ${config.chest.x} ${config.chest.y} ${config.chest.z}${config.chest !== configChest ? " (set with setchest)" : ""}.`);
        if (crew) crew.online(bot.username);
        if (ctx.queue.length > 0) runQueue();
        else if (!crew) log(`Nothing queued. Say '${config.commandPrefix}get <item> [count]' in chat.`);
    });

    // The death message ("... was slain by Zombie") comes in its own packet.
    let deathMessage = null;
    bot._client.on("death_combat_event", (packet) => {
        if (packet.playerId !== bot.entity?.id) return;
        try {
            deathMessage = require("prismarine-chat")(bot.registry).fromNotch(packet.message).toString();
        } catch (err) {
            deathMessage = null;
        }
    });
    bot.on("death", () => {
        ctx.stopCurrentAction();
        const where = bot.entity?.position ? ctx.fmt(bot.entity.position) : null;
        const dimension = String(bot.game?.dimension || "").replace(/^minecraft:/, "").replace(/_/g, " ");
        setTimeout(() => {
            const cause = deathMessage ? ` (${deathMessage})` : "";
            log(`Died${where ? ` at ${where}` : ""}${cause}. Will carry on after respawning.`);
            if (config.owner && config.deathWhisper !== false && where) {
                bot.whisper(config.owner, `I died at ${where}${dimension ? ` in the ${dimension}` : ""}${cause}.`);
            }
            deathMessage = null;
        }, 300);
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
        let replyTo = null; // whoever /msg'd the last task gets the wrap-up privately
        setBusy(true);
        try {
            if (ctx.idleWork) await ctx.idleWork; // e.g. finishing a meal
            while (ctx.queue.length > 0) {
                const task = ctx.queue.shift();
                replyTo = task.replyTo || null;
                ctx.replyTo = replyTo; // a task asked for by /msg reports by /msg
                ctx.current = { ...task, startCount: ctx.countItem(task.item), deposited: 0 };
                ctx.ahead = needsAhead();
                try {
                    await runTask(ctx.current);
                } catch (err) {
                    if (err instanceof ctx.Stopped) return;
                    ctx.tell(task.replyTo, `Couldn't get ${task.item}: ${err.message}`);
                } finally {
                    ctx.current = null;
                    ctx.ahead = null;
                }
            }
            if (config.chest) await ctx.safely(ctx.depositAll);
            if (config.returnHome && ctx.home) await ctx.safely(() => ctx.goTo(ctx.home, 2, "home"));
            ctx.tell(replyTo, "All tasks done.");
            if (config.quitWhenDone) bot.quit();
        } catch (err) {
            if (!(err instanceof ctx.Stopped)) log(err.message);
        } finally {
            ctx.replyTo = null;
            ctx.doneDoing();
            setBusy(false);
            ctx.stopRequested = false;
        }
    }

    // What the tasks still waiting will need, all the way down (item -> count),
    // so gathering for this one can get theirs on the same trip. Not a task's
    // own item: "get 2 oak_log" wants 2 new ones, whatever is in the bag.
    function needsAhead() {
        const total = new Map();
        for (const t of ctx.queue) {
            try {
                const needs = ctx.planner.requirements(t.item, t.count + ctx.countItem(t.item));
                for (const [item, n] of needs) if (item !== t.item) total.set(item, (total.get(item) || 0) + n);
            } catch (err) {
                // can't plan that one yet; it'll get its own trip
            }
        }
        return total;
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
        ctx.tell(task.replyTo, `Getting ${task.count} ${task.item}.`);
        while (progress(task) < task.count) {
            ctx.checkStop();
            const need = task.count - progress(task);
            try {
                await ctx.obtain(task.item, ctx.countItem(task.item) + need);
            } catch (err) {
                if (!(err instanceof ctx.Retry)) throw err;
            }
        }
        ctx.tell(task.replyTo, `Got ${task.count} ${task.item}.`);
    }

    // A skin is "http://textures.minecraft.net/texture/<hash>"; the dashboard
    // fetches it by the hash.
    const skinHash = (player) => /\/texture\/([0-9a-f]{16,})$/.exec(player?.skinData?.url || "")?.[1] || null;
    const floorPos = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

    // Everyone else on the server: the player list, and where they are if
    // this bot can see them.
    function playerList() {
        return Object.values(bot.players)
            .filter((p) => p.username && p.username !== bot.username)
            .map((p) => ({
                name: p.username,
                ping: p.ping ?? null,
                skin: skinHash(p),
                pos: p.entity?.position ? floorPos(p.entity.position) : null,
            }));
    }

    // Everything the dashboard shows about this bot.
    function snapshot() {
        const e = bot.entity;
        const counts = {};
        if (e) for (const i of ctx.carried()) counts[i.name] = (counts[i.name] || 0) + i.count;
        const t = ctx.current;
        return {
            label: config.username,
            name: bot.username || config.username,
            online: Boolean(e),
            version: bot.version,
            health: e ? Math.round(bot.health) : null,
            food: e ? bot.food : null,
            position: e ? { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) } : null,
            dimension: String(bot.game?.dimension || "").replace(/^minecraft:/, ""),
            yaw: e ? bot.entity.yaw : null,
            skin: skinHash(bot.players?.[bot.username]),
            xp: e ? bot.experience?.level ?? null : null,
            weather: bot.thunderState > 0 ? "thunder" : bot.isRaining ? "rain" : "clear",
            day: bot.time?.day ?? null,
            home: ctx.home ? floorPos(ctx.home) : null,
            workbenches: e && ctx.learn ? ctx.learn.recall("station", WORKBENCHES, e.position, 256).slice(0, 12).map(({ name, x, y, z }) => ({ name, x, y, z })) : [],
            stats: ctx.learn ? (({ kills = 0, deaths = 0 }) => ({ kills, deaths }))(ctx.learn.stats()) : null,
            players: e ? playerList() : [],
            profile: ctx.profiles?.name || "default",
            profiles: ctx.profiles ? Object.keys(ctx.profiles.list()) : ["default"],
            builder: Boolean(ctx.profiles?.builds),
            build: ctx.buildStatus ? ctx.buildStatus() : null,
            gameMode: bot.game?.gameMode,
            time: bot.time?.timeOfDay,
            busy: Boolean(ctx.busy),
            ward: ctx.ward || null,
            doing: e ? ctx.nowDoing() : null,
            task: t ? { item: t.item, count: t.count, done: Math.max(0, Math.min(progress(t), t.count)) } : null,
            queue: ctx.queue.map((q) => ({ item: q.item, count: q.count })),
            held: bot.heldItem?.name || null,
            armor: ctx.equipped ? ctx.equipped().map((i) => i.name) : [],
            inventory: Object.entries(counts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count),
            freeSlots: e ? bot.inventory.emptySlotCount() : null,
        };
    }

    if (reporter) {
        // A status that can't be put together (mid-login, say) skips a beat;
        // it must never take the bot down.
        const timer = setInterval(() => {
            try {
                reporter.status(snapshot());
            } catch (err) {
                // next second
            }
        }, 1000);
        bot.once("end", () => {
            clearInterval(timer);
            try {
                reporter.status({ ...snapshot(), online: false });
            } catch (err) {
                reporter.status({ label: config.username, name: bot.username || config.username, online: false });
            }
        });
    }

    function statusText() {
        const vitals = `Health ${Math.round(bot.health)}/20, food ${bot.food}/20.`;
        if (ctx.ward) return `Guarding ${ctx.ward}. ${vitals} Arrows: ${ctx.arrowCount()}.`;
        if (!ctx.current) return `Idle. ${ctx.queue.length} task(s) queued. ${vitals}`;
        const t = ctx.current;
        const step = ctx.nowDoing().step;
        return `Getting ${t.item}: ${Math.min(progress(t), t.count)}/${t.count}${step ? ` (${step[0].toLowerCase()}${step.slice(1)})` : ""}. ${ctx.queue.length} more queued. ${vitals}`;
    }

    // For one-off jobs outside the queue (farming, walking somewhere).
    // `replyTo`: a player who asked by /msg; everything said meanwhile goes to them.
    // `goal`: what the dashboard shows it working on ("Planting 9 carrot").
    async function runActivity(label, fn, replyTo = null, goal = null) {
        if (ctx.busy) return ctx.tell(replyTo, `I'm busy. Say ${config.commandPrefix}stop first.`);
        setBusy(true);
        ctx.replyTo = replyTo;
        try {
            await ctx.within(goal || label[0].toUpperCase() + label.slice(1), fn);
        } catch (err) {
            if (!(err instanceof ctx.Stopped)) say(`Couldn't ${label}: ${err.message}`);
        } finally {
            ctx.replyTo = null;
            ctx.doneDoing();
            setBusy(false);
            ctx.stopRequested = false;
        }
    }

    // ---------- the unload chest ----------

    const UNLOAD_INTO = /^(chest|trapped_chest|barrel)$/;
    const containerIds = () => bot.registry.blocksArray.filter((b) => UNLOAD_INTO.test(b.name)).map((b) => b.id);

    // The chest (or barrel) a player is looking at, from where they stand.
    function chestLookedAt(player) {
        if (!player?.position) return null;
        const yaw = player.headYaw ?? player.yaw, pitch = player.pitch ?? 0;
        const eye = player.position.offset(0, 1.62, 0);
        const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
        const block = bot.world.raycast(eye, dir, 6);
        return block && UNLOAD_INTO.test(block.name) ? block.position : null;
    }

    function nearestChest(point) {
        if (!point) return null;
        return bot.findBlocks({ matching: containerIds(), maxDistance: 5, count: 1, point })[0] || null;
    }

    // Hand things over: walk to the player and throw them. "all" is
    // everything it has: bag, hotbar, the armor it's wearing and the
    // off-hand too. A named item comes from the bag first, then off its body.
    const everything = () => bot.inventory.slots.slice(1, 46).filter(Boolean); // crafting grid, armor, bag, hotbar, off-hand
    const onBody = (item) => item.slot < 9 || item.slot === 45;
    async function give(player, what, count) {
        await ctx.goTo(player.position, 2, player.username);
        ctx.doing(`Handing ${what === "all" ? "everything" : ctx.pretty(what)} to ${player.username}`);
        await bot.lookAt(player.position.offset(0, 1.6, 0), true);
        let left = count;
        const given = {};
        ctx.handingOver = true; // don't put armor or a shield back on meanwhile
        try {
            // A few passes, in case something moved slots while throwing.
            for (let pass = 0; pass < 3 && left > 0; pass++) {
                const items = everything()
                    .filter((i) => what === "all" || i.name === what)
                    .sort((a, b) => onBody(a) - onBody(b));
                if (!items.length) break;
                for (const item of items) {
                    if (left <= 0) break;
                    if (bot.inventory.slots[item.slot] !== item) continue; // already gone or moved
                    const n = Math.min(item.count, left);
                    await throwSome(item, n);
                    given[item.name] = (given[item.name] || 0) + n;
                    left -= n;
                }
            }
        } finally {
            ctx.handingOver = false;
        }
        return given;
    }

    // Throw `n` of the stack in `item`'s slot (worn armor and the off-hand
    // too, which bot.toss doesn't look in).
    async function throwSome(item, n) {
        if (n >= item.count) return bot.tossStack(item);
        if (!onBody(item)) return bot.toss(item.type, null, n);
        // Part of an off-hand stack: pick it up, drop one at a time, put the rest back.
        await bot.clickWindow(item.slot, 0, 0);
        for (let i = 0; i < n; i++) await bot.clickWindow(-999, 1, 0);
        await bot.clickWindow(item.slot, 0, 0);
    }

    // ---------- building (builder profile) ----------

    // build                         what it's building
    // build list                    the schematics it has
    // build materials [name]        what a build needs, has and finds in chests
    // build <name> [x y z | here] [rotate 90|180|270] [clear]
    // build resume                  carry on with the last one
    // Without coordinates it builds where the player who asked is standing
    // (its lowest north-west corner there), or where the bot is.
    async function buildCommand(args, { say, runExclusive, requester, fromPlayer }) {
        const sub = (args[0] || "").toLowerCase();
        if (!sub) {
            const s = ctx.buildStatus();
            return say(s ? `${s.name}: ${s.done}/${s.total} blocks placed (${s.state}).` : `Not building anything. Schematics: ${ctx.listSchematics().join(", ") || "none (put them in the schematics folder)"}.`);
        }
        if (sub === "list") {
            const files = ctx.listSchematics();
            return say(files.length ? `Schematics: ${files.join(", ")}.` : "No schematics. Put .litematic, .schem or .nbt files in the schematics folder, or upload one on the dashboard.");
        }
        if (sub === "stop") {
            ctx.queue.length = 0;
            if (ctx.busy) ctx.stopRequested = true;
            ctx.stopCurrentAction();
            return say("Stopped building.");
        }
        if (!ctx.profiles.builds) return say(`I'm on the ${ctx.profiles.name} profile. Say ${config.commandPrefix}profile builder first.`);

        let options;
        if (sub === "resume") {
            options = ctx.lastBuild();
            if (!options) return say("Nothing to resume.");
        } else {
            const rest = sub === "materials" ? args.slice(1) : args;
            const file = rest[0];
            if (!file) {
                if (sub !== "materials") return;
                const list = await ctx.buildMaterials();
                if (!list) return say("Not building anything; say which schematic.");
                return say(materialsText(list));
            }
            const words = rest.slice(1).map((w) => w.toLowerCase());
            const nums = words.map(Number).filter((n) => Number.isFinite(n));
            const rotAt = words.findIndex((w) => /^rot(ate)?$/.test(w));
            const turns = rotAt >= 0 ? Math.round((Number(words[rotAt + 1]) || 0) / 90) : 0;
            const coords = rotAt >= 0 ? words.slice(0, rotAt).map(Number).filter(Number.isFinite) : nums;
            let origin;
            if (coords.length >= 3) origin = new ctx.Vec3(Math.floor(coords[0]), Math.floor(coords[1]), Math.floor(coords[2]));
            else if (words.includes("here") || !requester || !bot.players[requester]?.entity) origin = bot.entity.position.floored();
            else origin = bot.players[requester].entity.position.floored();
            options = { file, origin, turns, clear: words.includes("clear") };
            if (sub === "materials") {
                // it looks in the chests nearby, so it's a job of its own
                return runExclusive("check the materials", async () => say(materialsText(await ctx.buildMaterials(options))), "Checking materials");
            }
        }
        await runExclusive("build", () => ctx.buildSchematic(options), `Building ${String(options.file).replace(/\.[^.]+$/, "")}`);
    }

    function materialsText(list) {
        if (!list.length) return "Nothing left to place.";
        const short = list.filter((m) => m.have + m.chests < m.need);
        const top = list.slice(0, 8).map((m) => `${m.need} ${m.item}${m.have + m.chests ? ` (have ${m.have}${m.chests ? ` +${m.chests} in chests` : ""})` : ""}`);
        return `Needs: ${top.join(", ")}${list.length > 8 ? ` and ${list.length - 8} more kinds` : ""}.${short.length ? ` To gather: ${short.length} kinds.` : ""}`;
    }

    // ---------- commands (chat or terminal, plain text, no LLM) ----------

    const HELP = "Commands: " + [
        "get <item> [count]", "plan <item>", "farm", "plant <crop> [plots]", "breed <animal> [pairs]",
        "brew <potion> [count] [long|strong|splash]", "sleep", "water", "bucket", "armor [material]",
        "guard [player]", "spin [player] [radius]", "setchest [x y z|clear]", "bow [arrows]", "give [item|all] [count]",
        "learned", "forget", "stop", "status", "queue", "inv", "eat", "come", "deposit", "home", "say <text>", "quit",
        "profile [name]", "build <schematic> [x y z] [rotate 90|180|270] [clear]", "build list|materials|resume",
    ]
        .map((c) => config.commandPrefix + c)
        .join(" | ") + (crew ? ` | crew: ${config.commandPrefix}<botname> <cmd>, ${config.commandPrefix}all <cmd>, ${config.commandPrefix}crew` : "");

    // `broadcast` is true when the whole crew got this command: then a bot
    // with nothing to contribute stays quiet instead of everyone saying so.
    async function handleCommand(text, fromPlayer, { broadcast = false, whisper = false } = {}) {
        if (!ctx.planner) return; // not spawned yet
        // Asked by /msg: answer by /msg.
        const privately = whisper && fromPlayer;
        // Asked in public chat: answer in public, even while a private job runs.
        const say = privately ? (message) => ctx.tell(fromPlayer, message) : fromPlayer ? ctx.sayPublic : ctx.say;
        // Activities started by /msg report by /msg the whole time they run.
        const runExclusive = (label, fn, goal = null) => runActivity(label, fn, privately ? fromPlayer : null, goal);
        // come/give/guard act on whoever asked; from the dashboard or terminal, the owner.
        const requester = fromPlayer || config.owner || null;
        const cantSee = () => (fromPlayer ? "I can't see you." : `I can't see ${requester || "the owner"}.`);
        const chatOut = (line) => (privately ? bot.whisper(fromPlayer, line) : bot.chat(line));
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
                ctx.queue.push({ item, count, replyTo: privately ? fromPlayer : null });
                say(`Queued ${count} ${item}.`);
                runQueue();
                break;
            }
            case "plan": {
                const item = args[0];
                if (!item || !bot.registry.itemsByName[item]) return say(`Usage: ${config.commandPrefix}plan <item>`);
                const lines = ctx.planner.explain(item);
                lines.forEach((line) => log(line));
                if (fromPlayer) lines.slice(0, 5).forEach((line) => chatOut(line.trim()));
                break;
            }
            case "farm":
                // Harvest and replant every ripe crop nearby.
                await runExclusive("farm", async () => {
                    const n = await ctx.harvestCrops();
                    say(n ? `Harvested and replanted ${n} crops.` : "No ripe crops nearby.");
                }, "Farming");
                break;
            case "plant": {
                const name = args[0];
                const crop = ctx.kb.CROPS.find(
                    (c) => c.block === name || c.seed === name || c.produces.includes(name)
                );
                if (!crop) return say(`Usage: ${config.commandPrefix}plant <wheat|carrot|potato|beetroot> [plots]`);
                const plots = parseInt(args[1] || String(config.farmSize), 10);
                await runExclusive("plant", () => ctx.plantCrop(crop, plots), `Planting ${plots} ${ctx.pretty(crop.block)}`);
                break;
            }
            case "breed": {
                const animal = args[0];
                if (!animal || !ctx.kb.BREED_FOOD[animal]) {
                    return say(`Usage: ${config.commandPrefix}breed <${Object.keys(ctx.kb.BREED_FOOD).join("|")}> [pairs]`);
                }
                const pairs = parseInt(args[1] || "1", 10);
                await runExclusive("breed", () => ctx.breed(animal, pairs), `Breeding ${pairs} pair${pairs === 1 ? "" : "s"} of ${ctx.pretty(animal)}s`);
                break;
            }
            case "brew": {
                const potion = args[0];
                if (!potion || !ctx.kb.POTIONS[potion]) {
                    return say(`Usage: ${config.commandPrefix}brew <potion> [count] [long|strong|splash]. Potions: ${ctx.potionNames().join(", ")}`);
                }
                const count = parseInt(args[1] || "3", 10);
                await runExclusive("brew", () => ctx.brew(potion, count, args[2] || null), `Brewing ${count} ${args[2] ? args[2] + " " : ""}${ctx.pretty(potion)}`);
                break;
            }
            case "sleep":
                await runExclusive("sleep", () => ctx.sleep({ getBed: true }), "Going to sleep");
                break;
            case "water":
                await runExclusive("place water", async () => {
                    const pos = await ctx.placeWaterHere();
                    say(`Placed water at ${ctx.fmt(pos)}.`);
                }, "Placing water");
                break;
            case "bucket":
                await runExclusive("fill a bucket", async () => {
                    await ctx.getWaterBucket();
                    say("Got a water bucket.");
                }, "Filling a bucket");
                break;
            case "learned":
            case "memory": {
                const lines = ctx.learn.summary();
                lines.forEach((line) => log(line));
                if (fromPlayer) lines.slice(0, 4).forEach((line) => chatOut(line.slice(0, 250)));
                break;
            }
            case "forget":
                ctx.learn.reset();
                say("Forgot everything I learned on this server.");
                break;
            case "guard":
            case "bodyguard":
            case "protect": {
                // Player names are case-sensitive in the game; match them however they were typed.
                const typed = (args[0] || requester || "").replace(/[^A-Za-z0-9_]/g, "");
                if (!typed) return say(`Usage: ${config.commandPrefix}guard <player>`);
                const name = Object.keys(bot.players).find((n) => n.toLowerCase() === typed.toLowerCase()) || typed;
                if (name === bot.username) return say("I can't guard myself.");
                await runExclusive("guard", () => ctx.bodyguard(name), `Guarding ${name}`);
                break;
            }
            case "spin": {
                // spin [player] [radius] | spin stop
                if ((args[0] || "").toLowerCase() === "stop") {
                    if (ctx.busy) ctx.stopRequested = true;
                    ctx.stopCurrentAction();
                    break;
                }
                const words = args.filter((a) => !/^\d+(\.\d+)?$/.test(a));
                const radius = Math.min(16, Math.max(2, parseFloat(args.find((a) => /^\d+(\.\d+)?$/.test(a)) || "3")));
                const typed = (words[0] || requester || "").replace(/[^A-Za-z0-9_]/g, "");
                if (!typed) return say(`Usage: ${config.commandPrefix}spin [player] [radius]`);
                const name = Object.keys(bot.players).find((n) => n.toLowerCase() === typed.toLowerCase()) || typed;
                if (name === bot.username) return say("I can't spin round myself.");
                await runExclusive("spin", () => ctx.spin(name, radius), `Spinning round ${name}`);
                break;
            }
            case "setchest": {
                // setchest            the chest the player is looking at (or the nearest one to them)
                // setchest x y z      that one
                // setchest clear      back to config.json's
                const sub = (args[0] || "").toLowerCase();
                if (["clear", "off", "reset", "none"].includes(sub)) {
                    saveChest(config.username, null);
                    config.chest = configChest;
                    return say(configChest ? `Back to the chest in config.json, at ${configChest.x} ${configChest.y} ${configChest.z}.` : "I've no chest to unload into now.");
                }
                const numbers = args.slice(0, 3).map(Number);
                const player = requester ? bot.players[requester]?.entity : null;
                const pos =
                    args.length >= 3 && numbers.every(Number.isFinite)
                        ? new Vec3(...numbers).floored()
                        : chestLookedAt(player) || nearestChest(player?.position) || (!player && nearestChest(bot.entity.position));
                if (!pos) {
                    if (broadcast) return;
                    return say(`I can't tell which chest you mean. Look at it (from within 5 blocks) and say ${config.commandPrefix}setchest, or give its x y z.`);
                }
                const block = bot.blockAt(pos);
                if (block && !UNLOAD_INTO.test(block.name)) return say(`That's ${ctx.pretty(block.name)} at ${ctx.fmt(pos)}, not a chest or barrel.`);
                config.chest = { x: pos.x, y: pos.y, z: pos.z };
                saveChest(config.username, config.chest);
                say(`I'll unload into the ${block ? ctx.pretty(block.name) : "chest"} at ${ctx.fmt(pos)}${block ? "" : " (I can't see that spot from here)"}.`);
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
                const player = requester && bot.players[requester]?.entity;
                if (!player) return broadcast ? undefined : say(cantSee());
                const what = args[0] || "all";
                const count = args[1] ? parseInt(args[1], 10) : Infinity;
                const has = everything().some((i) => what === "all" || i.name === what);
                if (!has) return broadcast ? undefined : say(`I don't have ${what === "all" ? "anything to give" : `any ${what}`}.`);
                await runExclusive("give", async () => {
                    const given = await give(player, what, count);
                    const list = Object.entries(given).map(([n, c]) => `${c} ${n}`).join(", ");
                    say(list ? `Here you go: ${list}.` : "Nothing to give.");
                }, `Giving ${what === "all" ? "everything" : ctx.pretty(what)} to ${requester}`);
                break;
            }
            case "stop":
                ctx.queue.length = 0;
                if (ctx.busy) ctx.stopRequested = true;
                ctx.stopCurrentAction();
                if (bot.isSleeping) bot.wake().catch(() => {});
                say("Stopped and cleared the queue.");
                break;
            case "profile": {
                const all = ctx.profiles.list();
                if (!args[0]) {
                    say(`Profile: ${ctx.profiles.name}. Others: ${Object.keys(all).filter((n) => n !== ctx.profiles.name).join(", ")}. Say ${config.commandPrefix}profile <name> to switch.`);
                    break;
                }
                if (ctx.busy) return say(`I'm busy. Say ${config.commandPrefix}stop first.`);
                try {
                    const p = ctx.profiles.apply(args[0]);
                    say(`Profile: ${ctx.profiles.name}. ${p.description}`);
                } catch (err) {
                    say(`Couldn't switch: ${err.message}.`);
                }
                break;
            }
            case "build":
                await buildCommand(args, { say, runExclusive, requester, fromPlayer });
                break;
            case "say":
                if (args.length) bot.chat(args.join(" "));
                break;
            case "status":
                say(statusText());
                break;
            case "queue":
                say(ctx.queue.length ? ctx.queue.map((t) => `${t.item}x${t.count}`).join(", ") : "Queue is empty.");
                break;
            case "inv": {
                const items = ctx.carried().map((i) => `${i.name}x${i.count}`);
                say(items.length ? items.join(", ") : "Inventory is empty.");
                break;
            }
            case "eat":
                await ctx.safely(ctx.eat);
                break;
            case "come": {
                const player = requester && bot.players[requester]?.entity;
                if (!player) return broadcast ? undefined : say(cantSee());
                await runExclusive("come", () => ctx.goTo(player.position, 2, requester), `Coming to ${requester}`);
                break;
            }
            case "deposit": {
                // deposit                 everything but its tools, weapons, armor and food
                // deposit all             everything in its bag
                // deposit <item> [count]  that
                if (!config.chest) return broadcast ? undefined : say(`No chest set. Look at one and say ${config.commandPrefix}setchest.`);
                const what = !args[0] ? "spare" : args[0].toLowerCase() === "all" ? "all" : args[0];
                const count = args[1] ? parseInt(args[1], 10) : Infinity;
                if (!["spare", "all"].includes(what) && !bot.registry.itemsByName[what]) return say(`There's no item called ${what}.`);
                if (!["spare", "all"].includes(what) && ctx.countItem(what) === 0) return broadcast ? undefined : say(`I don't have any ${what}.`);
                await runExclusive("deposit", async () => {
                    const moved = await ctx.depositAll(what, count > 0 ? count : Infinity);
                    const list = Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(", ");
                    say(list ? `Put ${list} in the chest.` : "Nothing went in the chest.");
                }, "Putting things in the chest");
                break;
            }
            case "home":
                if (ctx.home) await ctx.safely(() => ctx.goTo(ctx.home, 2, "home"));
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
        const me = word === bot.username.toLowerCase() || word === config.username.toLowerCase();
        if ((word === "all" || me) && addresses(word, rest)) return rest.join(" ");
        if (!crew) return text;
        if (crew.members().has(word) && addresses(word, rest)) return null; // for another crew member
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

    // The owner and the admins; with neither set, anyone. Minecraft names
    // ignore case, so "zentyre" and "Zentyre" are the same player.
    const commanders = new Set([config.owner, ...(config.admins || [])].filter(Boolean).map((n) => n.toLowerCase()));
    function fromOwner(username) {
        if (username === bot.username || crew?.members().has(username.toLowerCase())) return false;
        return commanders.size === 0 || commanders.has(username.toLowerCase());
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
        const me = [bot.username, config.username].some((n) => n.toLowerCase() === first?.toLowerCase());
        run(me && addresses(first, rest) ? rest.join(" ") : text, username, { whisper: true });
    });

    // Commands from the dashboard (single bot; in a crew they come through the coordinator).
    if (!crew && reporter?.onCommand) {
        reporter.onCommand((text) => {
            const mine = route(stripPrefix(text.trim()) ?? text, null);
            if (mine !== null) run(mine, null);
        });
    }

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
