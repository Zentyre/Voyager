// The chest each bot unloads into, as set in game with "setchest". Saved in
// memory/<bot>.chest.json (one file per bot: a crew sets theirs all at once),
// and used instead of config.json's "chest" (which "setchest clear" goes
// back to).

const fs = require("fs");
const path = require("path");

const fileFor = (label) => path.join(__dirname, "..", "memory", `${String(label).replace(/[^A-Za-z0-9_.-]/g, "_")}.chest.json`);

function savedChest(label) {
    try {
        const c = JSON.parse(fs.readFileSync(fileFor(label), "utf8"));
        return [c.x, c.y, c.z].every(Number.isFinite) ? c : null;
    } catch (err) {
        return null;
    }
}

function saveChest(label, pos) {
    const file = fileFor(label);
    if (!pos) {
        fs.rmSync(file, { force: true });
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ x: pos.x, y: pos.y, z: pos.z }));
    fs.renameSync(`${file}.tmp`, file);
}

module.exports = { savedChest, saveChest };
