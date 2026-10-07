#!/usr/bin/env node
// Adds Minecraft 26.2 and 26.3 data to the installed minecraft-data package.
//
// No minecraft-data release on npm covers 26.2/26.3 yet. The data lives in the
// open upstream pull requests PrismarineJS/minecraft-data#1300 (26.3 data) and
// #1301 (26.2/26.3 protocol fixes, stacked on #1300). This script downloads the
// files from that PR's head at a pinned commit, merges the version tables into
// the installed package, and regenerates data.js.
//
// Run through `npm run setup:26.3` (mc-26.3/setup.js). Delete the mc-26.3
// folder once a minecraft-data release lists 26.3 in its supported versions.
//
// Offline install: set MC_DATA_DIR to a local checkout of minecraft-data at
// the pinned commit; its data/ folder is used instead of downloading.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const COMMIT = "924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2"; // head of minecraft-data#1301
const RAW = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${COMMIT}/data`;
const NEW_VERSIONS = ["26.2", "26.3"];

// Every file under data/pc/26.2 and data/pc/26.3 at COMMIT, plus the 1.20.3
// windows table that the 26.2+ dataPaths entries point to.
const FILES = [
    ...[
        "attributes", "biomes", "blockCollisionShapes", "blockLoot", "blocks",
        "commands", "entities", "entityLoot", "foods", "items", "language",
        "loginPacket", "materials", "particles", "protocol", "recipes",
        "sounds", "tints", "version",
    ].map((f) => `pc/26.2/${f}.json`),
    "pc/26.2/proto.yml",
    ...[
        "blockCollisionShapes", "blocks", "entities", "foods", "items",
        "protocol", "recipes", "version",
    ].map((f) => `pc/26.3/${f}.json`),
    "pc/26.3/proto.yml",
    "pc/1.20.3/windows.json",
];
// Tables merged into the installed copies rather than overwritten, so entries
// newer than the PR branch (e.g. bedrock versions) are kept.
const MERGED = [
    "dataPaths.json",
    "pc/common/features.json",
    "pc/common/versions.json",
    "pc/common/protocolVersions.json",
];

const pkgDir = path.dirname(require.resolve("minecraft-data/package.json"));
const dataDir = path.join(pkgDir, "minecraft-data", "data");
const stampFile = path.join(dataDir, "pc", "26.3", ".voyager-commit");

async function fetchText(rel) {
    if (process.env.MC_DATA_DIR) {
        return fs.readFileSync(path.join(process.env.MC_DATA_DIR, "data", rel), "utf8");
    }
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(`${RAW}/${rel}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            if (attempt >= 4) {
                throw new Error(`Failed to download ${rel}: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
    }
}

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(dataDir, rel), "utf8"));
}

function writeFile(rel, text) {
    const file = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function mergeTables(rel, upstream) {
    const local = readJson(rel);
    let merged;
    if (rel === "dataPaths.json") {
        merged = local;
        for (const v of NEW_VERSIONS) merged.pc[v] = upstream.pc[v];
    } else if (rel.endsWith("features.json")) {
        const names = new Set(local.map((f) => f.name));
        merged = local.concat(upstream.filter((f) => !names.has(f.name)));
    } else if (rel.endsWith("versions.json") && !rel.includes("protocol")) {
        merged = local.concat(upstream.filter((v) => !local.includes(v)));
    } else {
        const seen = new Set(local.map((v) => v.minecraftVersion));
        // protocolVersions.json is ordered newest first
        merged = upstream.filter((v) => !seen.has(v.minecraftVersion)).concat(local);
    }
    writeFile(rel, JSON.stringify(merged, null, 2) + "\n");
}

async function main() {
    if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8").trim() === COMMIT) {
        console.log("minecraft-data 26.2/26.3 data already installed");
        return;
    }
    console.log(`Installing minecraft-data 26.2/26.3 data from PR commit ${COMMIT.slice(0, 7)}`);
    const contents = await Promise.all(FILES.map(fetchText));
    const tables = await Promise.all(MERGED.map(fetchText));
    FILES.forEach((rel, i) => writeFile(rel, contents[i]));
    MERGED.forEach((rel, i) => mergeTables(rel, JSON.parse(tables[i])));
    execFileSync(process.execPath, [path.join(pkgDir, "bin", "generate_data.js")], {
        stdio: "inherit",
    });
    writeFile(path.relative(dataDir, stampFile), COMMIT + "\n");
    // Fail the install now rather than at bot start if anything is missing.
    const check = execFileSync(process.execPath, [
        "-e",
        "const d=require('minecraft-data')('26.3');" +
            "if(!d||!d.blocksByName.stone||!d.protocol)throw new Error('26.3 data incomplete');" +
            "console.log('minecraft-data 26.3 OK: protocol '+d.version.version)",
    ]);
    process.stdout.write(check);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
