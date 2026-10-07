// Self-improvement without a language model. The bot keeps statistics about
// its own experience and feeds them back into its decisions:
//
//   - Method costs: how long each way of getting an item really takes, and how
//     often it fails, so the planner prefers what has worked before.
//   - Places: where it has seen ores, trees, water, beds, animals, etc., so it
//     can go back instead of wandering at random.
//   - Bandits: for choices with several options (which way to explore, which
//     fighting style to use against a mob) it keeps a score per option and
//     picks with UCB1: mostly the best so far, sometimes trying the others.
//   - Danger: where it got hurt or died, so it avoids exploring there.
//   - Unreachable blocks: spots the pathfinder could not reach, skipped later.
//
// Everything is saved to a JSON file per server, so learning carries over.

const fs = require("fs");
const path = require("path");

// Default seconds per item for each method, used before anything is learned.
const DEFAULT_SECONDS = { mine: 10, craft: 2, smelt: 12, hunt: 30, farm: 60, breed: 30, brew: 60 };
const EMA = 0.3; // weight of the newest sample
const DANGER_HALF_LIFE_MS = 24 * 3600 * 1000;
const UNREACHABLE_MS = 6 * 3600 * 1000;
const MAX_PLACES_PER_NAME = 60;

// Blocks worth remembering when seen in passing.
const WORTH_REMEMBERING = /_ore$|_log$|^(sand|red_sand|clay|gravel|sugar_cane|pumpkin|melon|bamboo|obsidian|ancient_debris)$|_bed$|^(chest|crafting_table|furnace|brewing_stand)$/;

function createLearning(ctx) {
    const { bot, config } = ctx;
    const file = path.resolve(__dirname, "..", config.memoryFile);
    const worldKey = `${config.host}:${config.port}`;
    let all = {};
    try {
        all = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        all = {};
    }
    const mem = (all[worldKey] = all[worldKey] || {});
    for (const key of ["methods", "places", "bandits", "unreachable", "stats", "values"]) mem[key] = mem[key] || {};
    mem.danger = mem.danger || [];
    let dirty = false;

    function dimension() {
        return String(bot.game?.dimension || "overworld").replace("minecraft:", "");
    }

    // ---------- method timing ----------

    const stack = [];

    // Call when starting to get `units` of `item` by `type`. Returns a function
    // to call when done: true = success, false = failure, null = don't record.
    function begin(type, item, units) {
        const frame = { start: Date.now(), child: 0 };
        stack.push(frame);
        return (success) => {
            stack.splice(stack.indexOf(frame), 1);
            const elapsed = Date.now() - frame.start;
            if (stack.length) stack[stack.length - 1].child += elapsed;
            if (success === null || config.learn === false) return;
            const key = `${type}:${item}`;
            const m = (mem.methods[key] = mem.methods[key] || { n: 0, ok: 0, secondsPerUnit: null });
            m.n++;
            if (success) {
                m.ok++;
                // Only time spent on this step itself, not on its ingredients.
                const perUnit = Math.max(0, elapsed - frame.child) / 1000 / Math.max(1, units);
                m.secondsPerUnit = m.secondsPerUnit === null ? perUnit : m.secondsPerUnit * (1 - EMA) + perUnit * EMA;
            }
            dirty = true;
        };
    }

    // Multiplier for the planner's base cost of a method, plus a failure penalty.
    function costAdjust(type, item, base) {
        const m = mem.methods[`${type}:${item}`];
        if (!m || config.learn === false) return base;
        const successRate = (m.ok + 1) / (m.n + 1); // 1.0 until something fails
        let factor = 1;
        if (m.secondsPerUnit !== null && m.ok >= 2) {
            factor = Math.min(5, Math.max(0.3, m.secondsPerUnit / (DEFAULT_SECONDS[type] || 10)));
        }
        return base * factor + (1 - successRate) * 10;
    }

    // ---------- places ----------

    function chunkKey(pos) {
        return `${dimension()}:${Math.floor(pos.x / 16)}:${Math.floor(pos.z / 16)}`;
    }

    function remember(kind, name, pos, count = 1) {
        if (config.learn === false) return;
        const byKind = (mem.places[kind] = mem.places[kind] || {});
        const byName = (byKind[name] = byKind[name] || {});
        const key = chunkKey(pos);
        const entry = byName[key] || { x: 0, y: 0, z: 0, count: 0 };
        Object.assign(entry, { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), t: Date.now() });
        entry.count = Math.max(entry.count, count);
        byName[key] = entry;
        const keys = Object.keys(byName);
        if (keys.length > MAX_PLACES_PER_NAME) {
            keys.sort((a, b) => byName[a].t - byName[b].t);
            delete byName[keys[0]];
        }
        dirty = true;
    }

    // Remembered spots for any of `names`, nearest first.
    function recall(kind, names, from, maxDistance = config.memoryRange) {
        if (config.learn === false || !from) return [];
        const dim = dimension() + ":";
        const out = [];
        for (const name of names) {
            for (const [key, e] of Object.entries(mem.places[kind]?.[name] || {})) {
                if (!key.startsWith(dim)) continue;
                const d = Math.hypot(e.x - from.x, e.z - from.z);
                if (d <= maxDistance) out.push({ name, key, x: e.x, y: e.y, z: e.z, distance: d });
            }
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    // Went there and it's gone: drop those entries.
    function forget(kind, names, pos) {
        const key = chunkKey(pos);
        for (const name of names) {
            if (mem.places[kind]?.[name]?.[key]) {
                delete mem.places[kind][name][key];
                dirty = true;
            }
        }
    }

    // Glance around and note anything useful. Cheap enough to run every ~45s.
    function scan() {
        if (!bot.entity || config.learn === false) return;
        const ids = bot.registry.blocksArray.filter((b) => WORTH_REMEMBERING.test(b.name)).map((b) => b.id);
        const seen = new Map();
        for (const pos of bot.findBlocks({ matching: ids, maxDistance: config.searchRadius, count: 300 })) {
            const name = bot.blockAt(pos)?.name;
            if (!name) continue;
            const key = name + "|" + chunkKey(pos);
            const s = seen.get(key) || { name, pos, count: 0 };
            s.count++;
            seen.set(key, s);
        }
        const waterId = bot.registry.blocksByName.water.id;
        for (const pos of bot.findBlocks({ matching: waterId, maxDistance: config.searchRadius, count: 8 })) {
            seen.set("water|" + chunkKey(pos), { name: "water", pos, count: 1 });
        }
        for (const s of seen.values()) remember("block", s.name, s.pos, s.count);
        for (const e of Object.values(bot.entities)) {
            if (e.type === "mob" || e.type === "animal" || e.type === "hostile" || e.type === "passive") {
                if (e.position.distanceTo(bot.entity.position) <= config.searchRadius) remember("mob", e.name, e.position);
            }
        }
    }

    // ---------- bandits (UCB1) ----------

    function choose(context, arms) {
        if (config.learn === false) return arms[0];
        const b = (mem.bandits[context] = mem.bandits[context] || {});
        const untried = arms.filter((a) => !b[a]?.n);
        if (untried.length) return untried[Math.floor(Math.random() * untried.length)];
        const total = arms.reduce((sum, a) => sum + b[a].n, 0);
        let best = arms[0];
        let bestScore = -Infinity;
        for (const a of arms) {
            const score = b[a].sum / b[a].n + Math.sqrt((2 * Math.log(total)) / b[a].n);
            if (score > bestScore) {
                bestScore = score;
                best = a;
            }
        }
        return best;
    }

    function reward(context, arm, value) {
        if (config.learn === false) return;
        const b = (mem.bandits[context] = mem.bandits[context] || {});
        const s = (b[arm] = b[arm] || { n: 0, sum: 0 });
        s.n++;
        s.sum += Math.max(0, Math.min(1, value));
        dirty = true;
    }

    function bestArm(context) {
        const b = mem.bandits[context];
        if (!b) return null;
        const arms = Object.entries(b).filter(([, s]) => s.n > 0);
        if (!arms.length) return null;
        const [arm, s] = arms.sort((x, y) => y[1].sum / y[1].n - x[1].sum / x[1].n)[0];
        return { arm, mean: s.sum / s.n, n: arms.reduce((t, [, v]) => t + v.n, 0) };
    }

    // ---------- danger ----------

    function addDanger(pos, weight) {
        if (config.learn === false) return;
        mem.danger.push({ x: Math.floor(pos.x), z: Math.floor(pos.z), dim: dimension(), w: weight, t: Date.now() });
        if (mem.danger.length > 300) mem.danger.shift();
        dirty = true;
    }

    function dangerAt(pos, radius = 24) {
        const now = Date.now();
        const dim = dimension();
        return mem.danger
            .filter((d) => d.dim === dim && Math.hypot(d.x - pos.x, d.z - pos.z) <= radius)
            .reduce((sum, d) => sum + d.w * Math.pow(0.5, (now - d.t) / DANGER_HALF_LIFE_MS), 0);
    }

    // ---------- unreachable spots ----------

    function markUnreachable(pos) {
        mem.unreachable[`${dimension()}:${pos.x},${pos.y},${pos.z}`] = Date.now();
        dirty = true;
    }

    function isUnreachable(pos) {
        const t = mem.unreachable[`${dimension()}:${pos.x},${pos.y},${pos.z}`];
        return Boolean(t && Date.now() - t < UNREACHABLE_MS);
    }

    // ---------- learned numbers (e.g. aim correction) ----------

    function value(key, fallback) {
        return config.learn === false ? fallback : mem.values[key] ?? fallback;
    }

    // Running average: move `key` a step of size `alpha` towards `sample`.
    function ema(key, sample, alpha = 0.2) {
        if (config.learn === false) return;
        const old = mem.values[key];
        mem.values[key] = old === undefined ? sample : old * (1 - alpha) + sample * alpha;
        dirty = true;
    }

    // ---------- counters, saving, summary ----------

    function count(name, by = 1) {
        mem.stats[name] = (mem.stats[name] || 0) + by;
        dirty = true;
    }

    function save() {
        if (!dirty || config.learn === false) return;
        const now = Date.now();
        for (const [k, t] of Object.entries(mem.unreachable)) if (now - t > UNREACHABLE_MS) delete mem.unreachable[k];
        try {
            fs.writeFileSync(file + ".tmp", JSON.stringify(all));
            fs.renameSync(file + ".tmp", file);
            dirty = false;
        } catch (err) {
            ctx.log(`Couldn't save memory: ${err.message}`);
        }
    }

    function reset() {
        for (const key of ["methods", "places", "bandits", "unreachable", "stats", "values"]) mem[key] = {};
        mem.danger = [];
        dirty = true;
        save();
    }

    function summary() {
        const lines = [];
        const places = Object.entries(mem.places.block || {})
            .map(([name, spots]) => [name, Object.keys(spots).length])
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1]);
        lines.push(
            `Remembers ${places.reduce((s, [, n]) => s + n, 0)} resource spots` +
                (places.length ? `: ${places.slice(0, 6).map(([name, n]) => `${name} ×${n}`).join(", ")}` : ".")
        );
        const methods = Object.entries(mem.methods)
            .filter(([, m]) => m.n > 0)
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, 6)
            .map(([key, m]) => {
                const speed = m.secondsPerUnit === null ? "" : ` ${m.secondsPerUnit.toFixed(1)}s each,`;
                return `${key.replace(":", " ")}:${speed} ${Math.round((100 * m.ok) / m.n)}% ok (${m.n})`;
            });
        if (methods.length) lines.push(`Methods: ${methods.join("; ")}`);
        const fights = Object.keys(mem.bandits)
            .filter((k) => k.startsWith("combat:"))
            .map((k) => [k.slice(7), bestArm(k)])
            .filter(([, best]) => best)
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, 6)
            .map(([mob, best]) => `${mob.replace(":", " with ")}: ${best.arm} (${Math.round(best.mean * 100)}%, ${best.n} fights)`);
        if (fights.length) lines.push(`Best fighting style: ${fights.join("; ")}`);
        const shots = mem.stats.arrowsShot || 0;
        if (shots) {
            const bands = [0, 1, 2, 3, 4]
                .filter((b) => mem.values[`aim:${b}`] !== undefined)
                .map((b) => `${b * 10}-${b * 10 + 10}m ${mem.values[`aim:${b}`] > 0 ? "+" : ""}${mem.values[`aim:${b}`].toFixed(2)}`);
            lines.push(
                `Archery: ${shots} arrows, ${Math.round((100 * (mem.stats.arrowHits || 0)) / shots)}% hit` +
                    (bands.length ? `; learned aim correction ${bands.join(", ")}` : "")
            );
        }
        lines.push(
            `Kills ${mem.stats.kills || 0}, deaths ${mem.stats.deaths || 0}, ` +
                `danger spots ${mem.danger.length}, crops harvested ${mem.stats.harvested || 0}, ` +
                `animals bred ${mem.stats.bred || 0}, potions ${mem.stats.potions || 0}.`
        );
        return lines;
    }

    const saveTimer = setInterval(save, 60000);
    const scanTimer = setInterval(() => {
        try {
            scan();
        } catch (err) {
            // chunk not loaded yet, etc.
        }
    }, 45000);
    bot.once("end", () => {
        clearInterval(saveTimer);
        clearInterval(scanTimer);
        save();
    });

    return {
        begin,
        costAdjust,
        remember,
        recall,
        forget,
        scan,
        choose,
        reward,
        bestArm,
        addDanger,
        dangerAt,
        markUnreachable,
        isUnreachable,
        count,
        value,
        ema,
        save,
        reset,
        summary,
    };
}

module.exports = { createLearning };
