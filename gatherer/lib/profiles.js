// Profiles: what a bot is for, switched while it runs ("profile builder",
// "profile default"). "default" is the bot's own settings from config.json;
// another profile lays its settings on top, and going back takes them off.
//
// Built in: "builder" (builds schematics; see building.js). Add your own as
// profiles/<name>.json:
//   { "description": "...", "settings": { "chatter": false, ... }, "builds": false }
// Each bot remembers its profile across restarts (profiles/active.json).

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "profiles");
const STATE = path.join(DIR, "active.json");
// A profile can't change who or where the bot is.
const FIXED = new Set(["host", "port", "username", "auth", "version", "bots", "owner", "admins", "dashboard", "memoryFile"]);

const BUILT_IN = {
    default: { description: "Gathers, crafts, smelts, farms and fights, with its own settings.", settings: {} },
    builder: {
        description: "Builds schematics: takes materials from chests first, gathers or crafts the rest.",
        builds: true,
        settings: { returnHome: false },
    },
};

function listProfiles() {
    const all = { ...BUILT_IN };
    let files = [];
    try {
        files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "active.json");
    } catch (err) {
        // no profiles folder
    }
    for (const f of files) {
        try {
            const p = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
            all[f.replace(/\.json$/, "").toLowerCase()] = { description: p.description || "", settings: p.settings || {}, builds: Boolean(p.builds) };
        } catch (err) {
            console.log(`[profiles] ${f} isn't valid JSON: ${err.message}`);
        }
    }
    return all;
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE, "utf8"));
    } catch (err) {
        return {};
    }
}

function createProfiles(ctx) {
    const { config } = ctx;
    const label = config.username;
    const original = new Map(); // setting -> the bot's own value, while a profile changes it
    let current = "default";

    function apply(name) {
        const all = listProfiles();
        const key = String(name || "").toLowerCase();
        const profile = all[key];
        if (!profile) throw new Error(`no profile "${name}" (there are: ${Object.keys(all).join(", ")})`);
        for (const [k, v] of original) config[k] = v;
        original.clear();
        for (const [k, v] of Object.entries(profile.settings || {})) {
            if (FIXED.has(k)) continue;
            original.set(k, config[k]);
            const mine = config[k];
            config[k] = v && typeof v === "object" && !Array.isArray(v) && mine && typeof mine === "object" ? { ...mine, ...v } : v;
        }
        current = key;
        try {
            fs.mkdirSync(DIR, { recursive: true });
            const state = readState();
            if (key === "default") delete state[label];
            else state[label] = key;
            fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
        } catch (err) {
            // remembering is a nicety
        }
        return profile;
    }

    // The one it had last time.
    const saved = readState()[label];
    if (saved) {
        try {
            apply(saved);
        } catch (err) {
            console.log(`[${label}] Profile "${saved}" is gone; using the default.`);
        }
    }

    return {
        get name() {
            return current;
        },
        get builds() {
            return Boolean(listProfiles()[current]?.builds);
        },
        apply,
        list: listProfiles,
    };
}

module.exports = { createProfiles, listProfiles };
