// Crews: several bots in one process, each in its own worker thread (so each
// gets its own CPU core), with a small coordinator in the main thread.
//
// Working separately: address one bot, "!Miner get iron_ingot 8", and only it
// listens. Working together: unaddressed commands go to the crew, which
// splits gathering jobs between the bots that are free ("!get oak_log 64"
// -> 32 each for two idle bots) or sends the command to everyone or to one
// bot, depending on the command. Bots also:
//   - share everything they learn (places, timings, fighting styles, danger),
//   - claim the block or mob they're going for so others pick a different one,
//   - spread out when exploring.

const path = require("path");
const readline = require("readline");
const { Worker } = require("worker_threads");
const { addresses } = require("./commands");

// How each unaddressed command is handed out.
const SPLIT = new Set(["get", "gather", "craft", "smelt"]); // divide the count
const EVERYONE = new Set([
    "come", "stop", "quit", "status", "queue", "inv", "home", "guard", "bodyguard", "protect",
    "eat", "sleep", "deposit", "give", "drop", "armor", "bow", "forget", "spin", "setchest",
]);
// Everything else (plan, farm, plant, breed, brew, water, bucket, learned,
// help) goes to one bot: an idle one if possible.

const RECONNECT_MS = 15000;

// ---------- main thread ----------

// `manager`: run from the dashboard (no terminal needed): bots start and stop
// from there, only those in "autoStart" start by themselves, and the program
// keeps running when every bot is stopped.
function startCrew(configs, { manager = false } = {}) {
    const members = configs.map((config) => ({
        config,
        label: config.username, // name in config.json
        name: config.username, // in-game name, learned at login (differs for Microsoft accounts)
        worker: null,
        online: false,
        busy: false,
        quitting: false,
        retries: 0,
        state: "stopped", // stopped | queued | starting | online | reconnecting
        signIn: null, // Microsoft sign-in code waiting to be entered
        reconnectTimer: null,
        reconnectAt: null,
        version: null,
    }));
    const byName = (name) => {
        const n = String(name).toLowerCase();
        return members.find((m) => m.name.toLowerCase() === n || m.label.toLowerCase() === n);
    };
    // Every name a crew member answers to (in-game names and config labels).
    const allNames = () => members.flatMap((m) => [m.name, m.label]);
    const microsoft = members.some((m) => m.config.auth === "microsoft");
    let hub = null;
    const log = (text) => {
        console.log(`[crew] ${text}`);
        hub?.log("crew", text);
    };
    let shuttingDown = false;

    // What the dashboard shows for a bot that isn't online to report itself.
    function report(member) {
        hub?.status({
            label: member.label,
            name: member.name,
            online: false,
            state: member.state,
            signIn: member.signIn,
            reconnectAt: member.reconnectAt,
            version: member.version,
            managed: manager,
        });
    }
    function setState(member, state) {
        member.state = state;
        if (state !== "online") report(member);
    }

    function post(member, msg) {
        if (member.worker) member.worker.postMessage(msg);
    }

    function others(sender, msg) {
        for (const m of members) if (m !== sender) post(m, msg);
    }

    // The leader is the first online bot; it forwards unaddressed chat.
    function electLeader() {
        const leader = members.find((m) => m.online);
        for (const m of members) post(m, { type: "leader", value: m === leader });
    }

    function idle() {
        return members.filter((m) => m.online && !m.busy);
    }

    function online() {
        return members.filter((m) => m.online);
    }

    function dispatch(text, from) {
        const [cmd, ...args] = text.trim().split(/\s+/);
        const word = (cmd || "").toLowerCase();
        if (word === "crew") return crewStatus();

        if (SPLIT.has(word) && args[0]) {
            const team = idle().length ? idle() : online();
            if (!team.length) return log("No bots are online.");
            const total = Math.max(1, parseInt(args[1] || "1", 10) || 1);
            const helpers = team.slice(0, Math.min(total, team.length));
            const base = Math.floor(total / helpers.length);
            let extra = total % helpers.length;
            const plan = helpers.map((m) => {
                const share = base + (extra-- > 0 ? 1 : 0);
                post(m, { type: "command", text: `get ${args[0]} ${share}`, from });
                return `${m.name} ${share}`;
            });
            if (helpers.length > 1) tell(`Splitting ${total} ${args[0]}: ${plan.join(", ")}.`);
            return;
        }
        if (EVERYONE.has(word)) {
            for (const m of online()) post(m, { type: "command", text, from, broadcast: true });
            return;
        }
        const pick = idle()[0] || online()[0];
        if (!pick) return log("No bots are online.");
        post(pick, { type: "command", text, from });
    }

    // Say something in game through the leader (the coordinator has no bot).
    function tell(text) {
        log(text);
        const leader = members.find((m) => m.online);
        if (leader) post(leader, { type: "say", text });
    }

    function crewStatus() {
        tell(
            "Crew: " +
                members
                    .map((m) => `${m.name} (${!m.online ? "offline" : m.busy ? "busy" : "idle"})`)
                    .join(", ")
        );
    }

    function spawn(member) {
        const worker = new Worker(path.join(__dirname, "crew-worker.js"), {
            workerData: { config: member.config, names: members.map((m) => m.name) },
        });
        member.worker = worker;
        member.quitting = false;
        member.reconnectTimer = null;
        member.reconnectAt = null;
        setState(member, "starting");
        // Don't hold up the others forever if a sign-in is never completed.
        setTimeout(() => startedOrGaveUp(member), 20 * 60000);
        worker.on("message", (msg) => {
            switch (msg.type) {
                case "online":
                    member.online = true;
                    member.retries = 0;
                    member.signIn = null;
                    member.state = "online";
                    if (msg.name) member.name = msg.name;
                    for (const m of members) post(m, { type: "members", names: allNames() });
                    electLeader();
                    startedOrGaveUp(member);
                    break;
                case "signin":
                    member.signIn = msg.signIn;
                    report(member);
                    break;
                case "offline":
                    member.online = false;
                    member.quitting = member.quitting || msg.intentional;
                    electLeader();
                    break;
                case "state":
                    member.busy = msg.busy;
                    break;
                case "crewCommand":
                    dispatch(msg.text, msg.from);
                    break;
                case "learn":
                case "claim":
                    others(member, msg);
                    break;
                case "status":
                    member.version = msg.status.version || member.version;
                    if (msg.status.online) hub?.status({ ...msg.status, state: "online", managed: manager });
                    break;
                case "log":
                    hub?.log(member.label, msg.line);
                    break;
            }
        });
        worker.on("error", (err) => log(`${member.name} crashed: ${err.stack || err.message}`));
        worker.on("exit", () => {
            startedOrGaveUp(member);
            member.worker = null;
            member.online = false;
            member.signIn = null;
            electLeader();
            const again = !shuttingDown && !member.quitting && member.config.reconnect !== false;
            if (again) {
                const delay = Math.min(RECONNECT_MS * 2 ** member.retries++, 5 * 60000);
                log(`${member.name} left; reconnecting in ${Math.round(delay / 1000)}s.`);
                member.reconnectAt = Date.now() + delay;
                member.reconnectTimer = setTimeout(() => spawn(member), delay);
                setState(member, "reconnecting");
            } else {
                setState(member, "stopped");
                if (!manager && members.every((m) => !m.worker && !m.reconnectTimer)) {
                    log("All bots have left.");
                    process.exit(0);
                }
            }
        });
    }

    // Bring bots in one after another: each starts once the previous one is
    // online (or gave up), at least 3 s apart. With Microsoft accounts this
    // also means sign-in codes appear one at a time.
    const waiting = [];
    let starting = null;
    function queueStart(list) {
        for (const m of list) {
            if (m.worker || m.reconnectTimer || waiting.includes(m)) continue;
            m.retries = 0;
            waiting.push(m);
            setState(m, "queued");
        }
        pump();
    }
    function pump() {
        if (starting || !waiting.length || shuttingDown) return;
        starting = waiting.shift();
        spawn(starting);
    }
    function startedOrGaveUp(member) {
        if (member !== starting) return;
        starting = null;
        setTimeout(pump, 3000);
    }

    function stopBot(member) {
        const queued = waiting.indexOf(member);
        if (queued >= 0) waiting.splice(queued, 1);
        if (member.reconnectTimer) {
            clearTimeout(member.reconnectTimer);
            member.reconnectTimer = null;
            member.reconnectAt = null;
        }
        if (!member.worker) return setState(member, "stopped");
        member.quitting = true;
        post(member, { type: "quit" });
        // Not logged in yet (e.g. waiting for a sign-in)? End it anyway.
        const worker = member.worker;
        setTimeout(() => member.worker === worker && worker.terminate(), 5000);
    }

    function shutdown(then) {
        shuttingDown = true;
        log("Saving and disconnecting everyone...");
        for (const m of members) stopBot(m);
        setTimeout(() => (then ? then() : process.exit(0)), 3500);
    }

    // Dashboard buttons: start/stop bots, update, shut down.
    function control(action, target) {
        const member = target ? byName(target) : null;
        switch (action) {
            case "start":
                if (member) queueStart([member]);
                break;
            case "stop":
                if (member) stopBot(member);
                break;
            case "startAll":
                queueStart(members);
                break;
            case "stopAll":
                for (const m of members) stopBot(m);
                break;
            case "update":
                require("./updater").update((line) => hub?.log("updater", line));
                break;
            case "restart": {
                // The new copy starts these again; otherwise only "autoStart"
                // bots came back and the rest sat there stopped.
                const running = members.filter((m) => m.state !== "stopped").map((m) => m.label);
                hub?.log("updater", `Restarting${running.length ? ` (bringing back ${running.join(", ")})` : ""}...`);
                shutdown(() =>
                    require("./updater")
                        .restart(running)
                        .catch((err) => {
                            // Couldn't start the new copy: keep this one going, and say why.
                            shuttingDown = false;
                            hub?.log("updater", `Couldn't restart (${err.message}). Still running; bringing the bots back. Close Gatherer and open Start Dashboard.vbs to load the update.`);
                            queueStart(members.filter((m) => running.includes(m.label)));
                        })
                );
                break;
            }
            case "shutdown":
                hub?.log("crew", "Shutting down.");
                shutdown();
                break;
        }
    }

    const settings = configs[0].dashboard;
    if (settings !== false) {
        hub = require("./dashboard").startDashboard(settings, {
            names: members.map((m) => m.label),
            manager,
            onControl: manager ? control : null,
            onCommand: (target, text) => {
                if (target === "auto") return consoleCommand(text);
                consoleCommand(`${target} ${text.replace(/^[!.]/, "")}`);
            },
        });
        for (const m of members) report(m);
    }

    if (manager) {
        const auto = configs[0].autoStart;
        // Bots that were running before a dashboard Restart.
        const resume = (process.env.GATHERER_RESUME || "").split(",").filter(Boolean);
        delete process.env.GATHERER_RESUME;
        const wanted = [...(Array.isArray(auto) ? auto : []), ...resume];
        const list = auto === true ? members : members.filter((m) => wanted.some((n) => byName(n) === m));
        if (list.length) queueStart(list);
        log(`Ready. ${list.length ? `Starting ${list.map((m) => m.label).join(", ")}; s` : "S"}tart the others from the dashboard.`);
    } else {
        queueStart(members);
        log(`Starting ${members.length} bots: ${members.map((m) => m.label).join(", ")}.`);
    }
    if (microsoft) log("Microsoft accounts: each bot that hasn't signed in before will show a code to enter, one at a time.");

    // Terminal and dashboard: "<botname> cmd", "all cmd", "crew", or a crew command.
    function consoleCommand(line) {
        const text = line.trim().replace(/^[!.]/, "");
        if (!text) return;
        const [first, ...rest] = text.split(/\s+/);
        const target = byName(first);
        if (target && addresses(first, rest)) return post(target, { type: "command", text: rest.join(" "), from: null });
        if (first.toLowerCase() === "all") {
            for (const m of online()) post(m, { type: "command", text: rest.join(" "), from: null, broadcast: true });
            return;
        }
        dispatch(text, null);
    }
    readline.createInterface({ input: process.stdin }).on("line", consoleCommand);

    process.on("SIGINT", () => shutdown());
}

// ---------- worker side ----------

// What a bot running in a worker thread uses to talk to the crew.
function createCrewClient(port, { config, names }) {
    const me = config.username;
    const memberNames = new Set(names.map((n) => n.toLowerCase()));
    const claims = new Map(); // key -> { owner, until }
    const handlers = { command: [], say: [], quit: [], learn: [] };
    let leader = false;

    port.on("message", (msg) => {
        switch (msg.type) {
            case "leader":
                leader = msg.value;
                break;
            case "members":
                memberNames.clear();
                for (const n of msg.names) memberNames.add(n.toLowerCase());
                break;
            case "claim":
                claims.set(msg.key, { owner: msg.owner, until: msg.until });
                break;
            case "command":
                handlers.command.forEach((fn) => fn(msg));
                break;
            case "say":
                handlers.say.forEach((fn) => fn(msg.text));
                break;
            case "learn":
                handlers.learn.forEach((fn) => fn(msg));
                break;
            case "quit":
                handlers.quit.forEach((fn) => fn());
                break;
        }
    });

    return {
        name: me,
        members: () => memberNames,
        isLeader: () => leader,
        send: (msg) => port.postMessage(msg),
        online: (name) => port.postMessage({ type: "online", name }),
        offline: (intentional) => port.postMessage({ type: "offline", intentional }),
        setBusy: (busy) => port.postMessage({ type: "state", busy }),

        // Mark something (a block, a mob, an explore direction) as ours for a while.
        claim(key, ms = 60000) {
            const until = Date.now() + ms;
            claims.set(key, { owner: me, until });
            port.postMessage({ type: "claim", key, owner: me, until });
        },
        // Who holds a claim starting with `prefix` (themselves included).
        holders(prefix) {
            const now = Date.now();
            return [...claims].filter(([k, c]) => k.startsWith(prefix) && c.until > now).map(([, c]) => c.owner);
        },
        claimedByOther(key) {
            const c = claims.get(key);
            if (!c) return false;
            if (c.until < Date.now()) {
                claims.delete(key);
                return false;
            }
            return c.owner !== me;
        },

        onCommand: (fn) => handlers.command.push(fn),
        onSay: (fn) => handlers.say.push(fn),
        onQuit: (fn) => handlers.quit.push(fn),
        onLearn: (fn) => handlers.learn.push(fn),
    };
}

module.exports = { startCrew, createCrewClient };
