// "Update" and "Restart" for the dashboard, so nobody needs a terminal for
// `git pull`: fetch the latest code, install any new packages, and start a
// fresh copy of the program in the background.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let running = false;

function run(cmd, args, log) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === "win32", windowsHide: true });
        let out = "";
        const take = (chunk) => {
            out += chunk;
            for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log(line.trim());
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        child.on("error", (err) => {
            log(`${cmd}: ${err.message}`);
            resolve({ code: -1, out });
        });
        child.on("close", (code) => resolve({ code, out }));
    });
}

async function update(log) {
    if (running) return log("Already updating.");
    running = true;
    try {
        const pkg = path.join(ROOT, "package.json");
        const before = fs.existsSync(pkg) ? fs.readFileSync(pkg, "utf8") : "";
        log("Checking for updates...");
        const pull = await run("git", ["pull", "--ff-only"], log);
        if (pull.code !== 0) {
            log("Couldn't update. Is git installed, and are there local edits to the code? (config.json is fine.)");
            return;
        }
        if (/Already up.to.date/i.test(pull.out)) {
            log("Already up to date.");
            return;
        }
        if (fs.readFileSync(pkg, "utf8") !== before) {
            log("Installing new packages...");
            const install = await run("npm", ["install", "--no-audit", "--no-fund"], log);
            if (install.code !== 0) return log("npm install failed; see above.");
        }
        log("Updated. Press Restart to run the new version.");
    } finally {
        running = false;
    }
}

// Start a new copy in the background (same arguments) and exit this one once
// it's running. The new copy waits for the dashboard port, then starts the
// bots in `resume` (the ones running before). Throws if it couldn't start
// one, and this copy keeps running.
//
// Output: when this copy already writes to a file (Start Gatherer.vbs sends
// it to logs\gatherer.log), the new one shares that same file handle. Opening
// the file again doesn't work on Windows, where the launcher holds it locked
// for writing: that failed, crashed this copy, and nothing came back.
async function restart(resume = []) {
    let out = "ignore";
    let toFile = false;
    try {
        toFile = fs.fstatSync(1).isFile();
    } catch (err) {
        // no usable stdout
    }
    if (toFile) {
        out = "inherit";
    } else {
        try {
            const logs = path.join(ROOT, "logs");
            fs.mkdirSync(logs, { recursive: true });
            out = fs.openSync(path.join(logs, "gatherer.log"), "a");
        } catch (err) {
            out = "ignore";
        }
    }
    const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: { ...process.env, GATHERER_RESUME: resume.join(",") },
    });
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
    child.unref();
    process.exit(0);
}

module.exports = { update, restart };
