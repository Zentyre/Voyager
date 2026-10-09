// Saved Microsoft logins (gatherer/accounts/), kept for as long as Microsoft
// allows: each refresh hands out a new refresh token good for about 90 days,
// so a bot that signs in at least that often never asks again (unless the
// password changes or the login is removed from the Microsoft account).
//
// prismarine-auth does the signing in; this is the storage it keeps the
// tokens in, done more carefully than its own:
//
// - Its files were written in place, and one it couldn't read (cut short by
//   the program stopping or restarting mid-write) was wiped, losing the
//   refresh token: the next start asked to sign in again. Files are now
//   written whole (to a temporary file, then renamed over), the last good
//   one is kept as a backup, and nothing is ever wiped.
// - It read the 24 h Microsoft token as lasting 86 s (seconds taken for
//   milliseconds), so every start refreshed it, and if that one request
//   failed (no network yet just after the PC starts, a Microsoft hiccup), it
//   asked to sign in again straight away. Expiry is now read right, and an
//   expired token is refreshed here first, retrying for a few minutes;
//   only Microsoft saying the login is no longer valid means signing in.
//
// Same file names as before, so logins already saved keep working.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIVE_TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const LIVE_CLIENT_ID = "00000000441cc96b"; // the title prismarine-auth signs in as (Minecraft, Nintendo Switch)
const LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const RETRY_FOR_MS = 5 * 60 * 1000;

// prismarine-auth's own file name: first 6 hex of sha1(label).
function fileFor(folder, label, cacheName) {
    const hash = crypto.createHash("sha1").update(label ?? "", "binary").digest("hex").slice(0, 6);
    return path.join(folder, `${hash}_${cacheName}-cache.json`);
}

function readJson(file) {
    try {
        const text = fs.readFileSync(file, "utf8");
        return text.trim() ? JSON.parse(text) : null;
    } catch (err) {
        return null;
    }
}

// Write whole or not at all; keep the previous good copy as .bak.
function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    if (readJson(file)) {
        try {
            fs.copyFileSync(file, `${file}.bak`);
        } catch (err) {
            // the backup is a nicety
        }
    }
    fs.renameSync(tmp, file);
}

// The Microsoft (live) token, with its lifetime in milliseconds, which is how
// prismarine-auth reads it (Microsoft gives seconds).
function normalizeLive(data) {
    const t = data?.token;
    if (t && Number.isFinite(t.expires_in) && !t.expiresInMs) {
        data = { ...data, token: { ...t, expires_in: t.expires_in * 1000, expiresInMs: true } };
    }
    return data;
}

class SafeCache {
    constructor(file, cacheName, label, log) {
        this.file = file;
        this.cacheName = cacheName;
        this.label = label;
        this.log = log;
        this.cache = undefined;
        this.refreshing = null;
    }

    load() {
        let data = readJson(this.file);
        if (!data && fs.existsSync(this.file)) {
            const backup = readJson(`${this.file}.bak`);
            this.log(`The saved login file ${path.basename(this.file)} is damaged; ${backup ? "using its backup" : "there's no backup of it"}.`);
            try {
                fs.copyFileSync(this.file, `${this.file}.damaged`);
            } catch (err) {
                // keep going
            }
            data = backup;
        }
        data = data || {};
        return this.cacheName === "live" ? normalizeLive(data) : data;
    }

    async getCached() {
        if (this.cache === undefined) this.cache = this.load();
        if (this.cacheName === "live") await this.refreshIfExpired();
        return this.cache;
    }

    async setCached(cached) {
        if (this.cacheName === "live") {
            // A refresh answer without a new refresh token: keep the old one.
            const old = this.cache?.token?.refresh_token;
            if (old && cached?.token && !cached.token.refresh_token) cached = { ...cached, token: { ...cached.token, refresh_token: old } };
            cached = normalizeLive(cached);
        }
        this.cache = cached;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            writeJson(this.file, this.cache);
        } catch (err) {
            this.log(`Couldn't save the login (${err.message}).`);
        }
    }

    async setCachedPartial(cached) {
        if (this.cache === undefined) this.cache = this.load();
        await this.setCached({ ...this.cache, ...cached });
    }

    // Only when asked to sign in from scratch; the old file stays as .bak.
    async reset() {
        await this.setCached({});
        return this.cache;
    }

    // An expired Microsoft token with a refresh token: refresh it here,
    // patiently, so a passing failure doesn't mean signing in again.
    refreshIfExpired() {
        const t = this.cache?.token;
        if (!t?.refresh_token || !t.obtainedOn || t.obtainedOn + t.expires_in - Date.now() > 60000) return null;
        if (!this.refreshing) this.refreshing = this.refresh(t.refresh_token).finally(() => (this.refreshing = null));
        return this.refreshing;
    }

    async refresh(refreshToken) {
        const start = Date.now();
        for (let attempt = 0; ; attempt++) {
            let problem;
            try {
                const res = await fetch(SafeCache.tokenUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ scope: LIVE_SCOPE, client_id: LIVE_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
                });
                const body = await res.json().catch(() => ({}));
                if (res.ok && body.access_token) {
                    // Microsoft may or may not send a new refresh token; keep the old one if not.
                    await this.setCachedPartial({ token: { refresh_token: refreshToken, ...body, obtainedOn: Date.now() } });
                    if (attempt > 0) this.log("Refreshed the saved login.");
                    return;
                }
                if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    // Microsoft says no: the login really is over (password changed, removed, unused too long).
                    this.log(`Microsoft no longer accepts the saved login (${body.error_description || body.error || `HTTP ${res.status}`}); it will ask to sign in again.`);
                    return;
                }
                problem = `HTTP ${res.status}`;
            } catch (err) {
                problem = err.cause?.code || err.message; // no network, DNS, timeout
            }
            if (Date.now() - start > RETRY_FOR_MS) {
                this.log(`Still couldn't reach Microsoft to refresh the saved login (${problem}); it may ask to sign in.`);
                return;
            }
            const wait = Math.min(60, 5 * 2 ** attempt);
            this.log(`Couldn't reach Microsoft to refresh the saved login (${problem}); trying again in ${wait} s.`);
            await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        }
    }
}

SafeCache.tokenUrl = LIVE_TOKEN_URL;

// What to give mineflayer as `profilesFolder` (prismarine-auth takes a function).
function loginStorage(folder, log = console.log) {
    const caches = new Map();
    return ({ cacheName, username }) => {
        const file = fileFor(folder, username, cacheName);
        if (!caches.has(file)) caches.set(file, new SafeCache(file, cacheName, username, (m) => log(`[${username}] ${m}`)));
        return caches.get(file);
    };
}

module.exports = { loginStorage, fileFor, SafeCache };
