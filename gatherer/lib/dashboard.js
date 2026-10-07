// Web dashboard: a page on this computer (http://localhost:3000 by default)
// that shows every bot live and sends them commands. Built on Node's own
// http module; the page gets updates over Server-Sent Events.
//
// It only listens on this computer unless "dashboard.host" is changed. Then a
// token is required (printed at startup), since anyone who can open the page
// can command the bots.

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const PAGE = path.join(__dirname, "..", "dashboard", "index.html");
const LOG_KEEP = 400;

// `onControl(action, bot)` (manager mode): start/stop bots, update, shut down.
function startDashboard(options, { onCommand, onControl = null, manager = false, names = [] } = {}) {
    const settings = { port: 3000, host: "127.0.0.1", ...(typeof options === "object" ? options : {}) };
    const local = ["127.0.0.1", "localhost", "::1"].includes(settings.host);
    const token = local ? null : settings.token || crypto.randomBytes(9).toString("base64url");

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

    function authorized(req, url) {
        if (!token) return true;
        if (url.searchParams.get("token") === token) return true;
        if (req.headers["x-token"] === token) return true;
        return (req.headers.cookie || "").split(/;\s*/).includes(`gatherer_token=${token}`);
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

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (!authorized(req, url)) {
            res.writeHead(403, { "content-type": "text/plain" });
            return res.end("Open the link printed in the console (it includes the access token).");
        }
        const headers = token ? { "set-cookie": `gatherer_token=${token}; Path=/; SameSite=Strict; HttpOnly` } : {};

        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            return res.end(fs.readFileSync(PAGE));
        }
        if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            send(res, "snapshot", { bots: [...bots.values()], logs: logs.slice(-200), manager: Boolean(onControl) });
            clients.add(res);
            const ping = setInterval(() => res.write(": ping\n\n"), 20000);
            req.on("close", () => {
                clearInterval(ping);
                clients.delete(res);
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
        if (req.method === "POST" && url.pathname === "/command") {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk;
                if (body.length > 10000) req.destroy();
            });
            req.on("end", () => {
                try {
                    const { target, text } = JSON.parse(body);
                    if (typeof text !== "string" || !text.trim()) throw new Error("empty command");
                    const who = typeof target === "string" && target ? target : "auto";
                    addLog("you", `${who === "auto" ? "" : `${who}: `}${text.trim()}`);
                    onCommand?.(who, text.trim());
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
        const host = local ? "localhost" : settings.host === "0.0.0.0" ? "<this computer's IP>" : settings.host;
        console.log(`[dashboard] Open http://${host}:${settings.port}/${token ? `?token=${token}` : ""}`);
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
