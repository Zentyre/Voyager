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

// How each unaddressed command is handed out.
const SPLIT = new Set(["get", "gather", "craft", "smelt"]); // divide the count
const EVERYONE = new Set([
    "come", "stop", "quit", "status", "queue", "inv", "home", "guard", "bodyguard", "protect",
    "eat", "sleep", "deposit", "give", "drop", "armor", "bow", "forget",
]);
// Everything else (plan, farm, plant, breed, brew, water, bucket, learned,
// help) goes to one bot: an idle one if possible.

const RECONNECT_MS = 15000;

// ---------- main thread ----------

function startCrew(configs) {
    const members = configs.map((config) => ({
        config,
        name: config.username,
        worker: null,
        online: false,
        busy: false,
        quitting: false,
        retries: 0,
    }));
    const byName = (name) => members.find((m) => m.name.toLowerCase() === String(name).toLowerCase());
    const log = (text) => console.log(`[crew] ${text}`);
    let shuttingDown = false;

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
        worker.on("message", (msg) => {
            switch (msg.type) {
                case "online":
                    member.online = true;
                    member.retries = 0;
                    electLeader();
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
            }
        });
        worker.on("error", (err) => log(`${member.name} crashed: ${err.stack || err.message}`));
        worker.on("exit", () => {
            member.worker = null;
            member.online = false;
            electLeader();
            const again = !shuttingDown && !member.quitting && member.config.reconnect !== false;
            if (again) {
                const delay = Math.min(RECONNECT_MS * 2 ** member.retries++, 5 * 60000);
                log(`${member.name} left; reconnecting in ${Math.round(delay / 1000)}s.`);
                setTimeout(() => spawn(member), delay);
            } else if (members.every((m) => !m.worker)) {
                log("All bots have left.");
                process.exit(0);
            }
        });
    }

    // Stagger logins a little; servers dislike many joins at once.
    members.forEach((m, i) => setTimeout(() => spawn(m), i * 3000));
    log(`Starting ${members.length} bots: ${members.map((m) => m.name).join(", ")}.`);

    // Terminal: "<botname> cmd", "all cmd", "crew", or a crew command.
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const text = line.trim().replace(/^!/, "");
        if (!text) return;
        const [first, ...rest] = text.split(/\s+/);
        const target = byName(first);
        if (target) return post(target, { type: "command", text: rest.join(" "), from: null });
        if (first.toLowerCase() === "all") {
            for (const m of online()) post(m, { type: "command", text: rest.join(" "), from: null, broadcast: true });
            return;
        }
        dispatch(text, null);
    });

    process.on("SIGINT", () => {
        shuttingDown = true;
        log("Saving and disconnecting everyone...");
        for (const m of members) post(m, { type: "quit" });
        setTimeout(() => process.exit(0), 3000);
    });
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
        online: () => port.postMessage({ type: "online" }),
        offline: (intentional) => port.postMessage({ type: "offline", intentional }),
        setBusy: (busy) => port.postMessage({ type: "state", busy }),

        // Mark something (a block, a mob, an explore direction) as ours for a while.
        claim(key, ms = 60000) {
            const until = Date.now() + ms;
            claims.set(key, { owner: me, until });
            port.postMessage({ type: "claim", key, owner: me, until });
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
