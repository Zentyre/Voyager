#!/usr/bin/env node
// Opt-in, UNRELEASED Minecraft 26.3 support: `npm run setup:26.3`.
//
// No mineflayer release supports 26.3 yet. This applies patches built from
// open, unmerged upstream pull requests to the installed packages, and adds the
// 26.2/26.3 data from an open minecraft-data pull request. The upstream work
// is unreviewed and has known gaps (some item components cannot be decoded,
// some recipes are incomplete), so expect bugs.
//
// Patches (all MIT, from PrismarineJS):
//   mineflayer        #4125 teleport confirm, #4128 tick_end, #4144 stepped
//                     entity movement, #4146 26.3 player-action ids; 26.2/26.3
//                     added to testedVersions; entity_action names for leaving a
//                     bed and starting elytra flight on 1.21.6+
//   minecraft-protocol #1538 entityDelta type; 26.2 in supportedVersions;
//                     #1529 (merged) 26.2+ login for the mock server in npm test
//   prismarine-chunk  #334 light-section masks as byte arrays
//   prismarine-physics 26.2/26.3 in its feature version lists
//   minecraft-data    data from PR #1300/#1301 (see install-mc-data.js)
//
// `npm install` reinstalls the unpatched packages; run this again after it.
// To go back to 26.1 only: rm -rf node_modules && npm install

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const patchDir = path.join(__dirname, "patches");

function installedVersion(pkg) {
    try {
        const file = require.resolve(`${pkg}/package.json`, { paths: [root] });
        return JSON.parse(fs.readFileSync(file, "utf8")).version;
    } catch {
        return null;
    }
}

function main() {
    console.log(
        "Setting up UNRELEASED Minecraft 26.3 support from open upstream pull requests.\n" +
            "This code is not reviewed upstream; expect bugs.\n"
    );
    const wanted = fs
        .readdirSync(patchDir)
        .filter((f) => f.endsWith(".patch"))
        .map((f) => f.replace(/\.patch$/, "").split("+"))
        .concat([["minecraft-data", "3.117.0"]]);
    const mismatched = wanted.filter(([pkg, v]) => installedVersion(pkg) !== v);
    if (mismatched.length) {
        for (const [pkg, v] of mismatched) {
            console.error(`${pkg}: need ${v}, found ${installedVersion(pkg) || "nothing"}`);
        }
        console.error(
            "\nThe patches only fit these exact versions. Run `npm install` in " +
                "voyager/env/mineflayer first (package.json pins them)."
        );
        process.exit(1);
    }

    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    execFileSync(
        npx,
        ["--yes", "patch-package@8.0.1", "--patch-dir", "mc-26.3/patches", "--error-on-fail"],
        { cwd: root, stdio: "inherit", shell: process.platform === "win32" }
    );
    execFileSync(process.execPath, [path.join(__dirname, "install-mc-data.js")], {
        cwd: root,
        stdio: "inherit",
    });
    console.log(
        '\nMinecraft 26.3 setup done. Use version "26.3", e.g.\n' +
            '  Voyager(minecraft_server={"version": "26.3", "accept_eula": True})\n' +
            "Run `npm run setup:26.3` again after any `npm install`."
    );
}

main();
