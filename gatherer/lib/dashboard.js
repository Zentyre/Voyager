// Web dashboard: a page on this computer (http://localhost:3000 by default)
// that shows every bot live and sends them commands. Built on Node's own
// http module; the page gets updates over Server-Sent Events.
//
// It only listens on this computer, and only answers requests addressed to
// it by a local name, coming from its own page (not another website open in
// the browser sending commands to the bots).
//
// GET /status gives the same as the page sees, as plain JSON (for the in-game
// screen mod, and scripts); POST /command sends one.

const fs = require("fs");
const http = require("http");
const path = require("path");

const PAGE = path.join(__dirname, "..", "dashboard", "index.html");
const LOG_KEEP = 400;
const MAX_SCHEMATIC = 50 * 1024 * 1024;

// `onControl(action, bot)` (manager mode): start/stop bots, update, shut down.
function startDashboard(options, { onCommand, onControl = null, manager = false, names = [] } = {}) {
    const settings = { port: 3000, ...(typeof options === "object" ? options : {}), host: "127.0.0.1" };

    const bots = new Map(); // label -> latest status
    const logs = []; // { t, bot, text }
    const clients = new Set();
    for (const label of names) bots.set(label, { label, name: label, online: false });

    function send(res, event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    function broadcast(event, data) {
        for (const res of clients) send(res, event, data);
    }

    // Addressed to this computer (not a website's own name pointed here), and
    // not sent by another website's page.
    const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
    function fromHere(req) {
        if (!LOCAL.test(req.headers.host || "")) return false;
        const origin = req.headers.origin;
        if (!origin || origin === "null") return !origin;
        try {
            return LOCAL.test(new URL(origin).host);
        } catch (err) {
            return false;
        }
    }

    function itemNames() {
        const version = [...bots.values()].find((b) => b.version)?.version;
        if (!version) return [];
        try {
            return require("minecraft-data")(version).itemsArray.map((i) => i.name).sort();
        } catch (err) {
            return [];
        }
    }

    // Player skins, fetched from Mojang's texture server (where the game gets
    // them) and kept, so the page can draw heads without going online itself.
    const skins = new Map(); // hash -> Promise<Buffer|null>
    function skin(hash) {
        if (!skins.has(hash)) {
            skins.set(
                hash,
                fetch(`https://textures.minecraft.net/texture/${hash}`, { signal: AbortSignal.timeout(8000) })
                    .then((r) => (r.ok ? r.arrayBuffer() : null))
                    .then((buf) => (buf ? Buffer.from(buf) : null))
                    .catch(() => null)
                    .then((buf) => {
                        if (!buf) setTimeout(() => skins.delete(hash), 60000); // try again later
                        return buf;
                    })
            );
        }
        return skins.get(hash);
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (!fromHere(req)) {
            res.writeHead(403, { "content-type": "text/plain" });
            return res.end("The dashboard only answers this computer: open http://localhost:" + settings.port + "/");
        }

        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            return res.end(fs.readFileSync(PAGE));
        }
        if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            send(res, "snapshot", { bots: [...bots.values()], logs: logs.slice(-200), manager: Boolean(onControl) });
            clients.add(res);
            const ping = setInterval(() => res.write(": ping\n\n"), 20000);
            req.on("close", () => {
                clearInterval(ping);
                clients.delete(res);
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/status") {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            return res.end(JSON.stringify({ bots: [...bots.values()], logs: logs.slice(-Math.min(200, Number(url.searchParams.get("logs")) || 30)), manager: Boolean(onControl) }));
        }
        const skinPath = /^\/skin\/([0-9a-f]{16,80})$/.exec(url.pathname);
        if (req.method === "GET" && skinPath) {
            skin(skinPath[1]).then((buf) => {
                if (!buf) {
                    res.writeHead(404, { "content-type": "text/plain" });
                    return res.end("no skin");
                }
                res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
                res.end(buf);
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/schematics") {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            return res.end(JSON.stringify(require("./building").listSchematics()));
        }
        if (req.method === "POST" && url.pathname === "/schematics") {
            // Upload: the file's bytes, its name in ?name=
            const { DIR } = require("./building");
            const { EXTENSIONS } = require("./schematic");
            const name = path.basename(String(url.searchParams.get("name") || "")).replace(/[^\w.\- ]/g, "_");
            const fail = (code, message) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: message }));
            };
            if (!name || !EXTENSIONS.includes(path.extname(name).toLowerCase())) return fail(400, "only .litematic, .schem or .nbt files");
            const chunks = [];
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_SCHEMATIC) {
                    fail(413, "that file is too big");
                    req.destroy();
                } else {
                    chunks.push(chunk);
                }
            });
            req.on("end", () => {
                if (size > MAX_SCHEMATIC) return;
                try {
                    fs.mkdirSync(DIR, { recursive: true });
                    fs.writeFileSync(path.join(DIR, name), Buffer.concat(chunks));
                    addLog("you", `Uploaded schematic ${name}.`);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, name }));
                } catch (err) {
                    fail(500, err.message);
                }
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/items") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify(itemNames()));
        }
        if (req.method === "POST" && url.pathname === "/control" && onControl) {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk;
                if (body.length > 2000) req.destroy();
            });
            req.on("end", () => {
                try {
                    const { action, bot } = JSON.parse(body);
                    const allowed = ["start", "stop", "startAll", "stopAll", "update", "restart", "shutdown"];
                    if (!allowed.includes(action)) throw new Error("unknown action");
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end('{"ok":true}');
                    onControl(action, typeof bot === "string" ? bot : null);
                } catch (err) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/clear-log") {
            logs.length = 0;
            broadcast("clear", {});
            res.writeHead(200, { "content-type": "application/json" });
            return res.end('{"ok":true}');
        }
        if (req.method === "POST" && url.pathname === "/command") {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk;
                if (body.length > 10000) req.destroy();
            });
            req.on("end", () => {
                try {
                    // `quiet` (the in-game dashboard): the bots answer in the log, not in chat.
                    const { target, text, quiet } = JSON.parse(body);
                    if (typeof text !== "string" || !text.trim()) throw new Error("empty command");
                    const who = typeof target === "string" && target ? target : "auto";
                    addLog("you", `${who === "auto" ? "" : `${who}: `}${text.trim()}`);
                    onCommand?.(who, text.trim(), { quiet: quiet === true });
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end('{"ok":true}');
                } catch (err) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            });
            return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
    });

    // The port can be busy for a moment after a restart (the old copy is still
    // closing), so keep trying for a while in manager mode.
    let tries = 0;
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && manager && ++tries <= 20) {
            setTimeout(() => server.listen(settings.port, settings.host), 1000);
            return;
        }
        console.log(
            err.code === "EADDRINUSE"
                ? `[dashboard] Port ${settings.port} is in use (another copy running?). Set "dashboard": { "port": 3001 } in config.json to use another.`
                : `[dashboard] ${err.message}`
        );
        if (manager) {
            console.log("[dashboard] Gatherer seems to be running already; open the dashboard in your browser.");
            process.exit(0);
        }
    });
    server.listen(settings.port, settings.host, () => {
        console.log(`[dashboard] Open http://localhost:${settings.port}/`);
    });

    function addLog(bot, text) {
        const entry = { t: Date.now(), bot, text };
        logs.push(entry);
        if (logs.length > LOG_KEEP) logs.shift();
        broadcast("log", entry);
    }

    return {
        status(status) {
            if (!status?.label) return;
            bots.set(status.label, status);
            broadcast("status", status);
        },
        log: addLog,
    };
}

module.exports = { startDashboard };
