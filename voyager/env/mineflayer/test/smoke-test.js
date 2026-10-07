// Smoke test for the mineflayer bridge (index.js) without a real Minecraft
// server: a minecraft-protocol mock server logs the bot in, sends a small
// stone platform, and records the commands the bot sends.
//
// Usage: node test/smoke-test.js [version]   (default: 26.1)

const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");
const mc = require("minecraft-protocol");

const version = process.argv[2] || "26.1";
const registry = require("prismarine-registry")(version);
const Chunk = require("prismarine-chunk")(version);

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer().listen(0, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function chunkPacket() {
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    const stone = registry.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            chunk.setBlockStateId({ x, y: 64, z }, stone);
            for (let y = 65; y < 80; y++) chunk.setSkyLight({ x, y, z }, 15);
        }
    }
    const lights = chunk.dumpLight();
    return {
        x: 0,
        z: 0,
        groundUp: true,
        biomes: chunk.dumpBiomes(),
        heightmaps: {
            type: "compound",
            name: "",
            value: {
                MOTION_BLOCKING: {
                    type: "longArray",
                    value: new Array(37).fill([0, 0]),
                },
            },
        },
        bitMap: chunk.getMask(),
        chunkData: chunk.dump(),
        blockEntities: [],
        trustEdges: false,
        ...lights,
    };
}

async function post(base, route, body = {}) {
    const res = await fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    return { status: res.status, body: await res.json() };
}

async function main() {
    const mcPort = await freePort();
    const apiPort = await freePort();
    const commands = [];
    const chats = [];

    const server = mc.createServer({
        "online-mode": false,
        version,
        port: mcPort,
    });
    server.on("playerJoin", (client) => {
        client.on("chat_command", (p) => commands.push("/" + p.command));
        client.on("chat_command_signed", (p) => commands.push("/" + p.command));
        client.on("chat_message", (p) => chats.push(p.message));
        const login = { ...registry.loginPacket, entityId: 0 };
        client.write("login", login);
        client.write("map_chunk", chunkPacket());
        client.write("position", {
            x: 8.5,
            y: 65,
            z: 8.5,
            dx: 0,
            dy: 0,
            dz: 0,
            yaw: 0,
            pitch: 0,
            flags: {},
            teleportId: 1,
        });
        // mineflayer emits "spawn" on the first health update
        client.write("update_health", { health: 20, food: 20, foodSaturation: 5 });
    });

    const bridge = spawn(
        process.execPath,
        [path.join(__dirname, "..", "index.js"), String(apiPort)],
        { stdio: ["ignore", "pipe", "inherit"] }
    );
    let bridgeOut = "";
    bridge.stdout.on("data", (d) => (bridgeOut += d));
    const base = `http://127.0.0.1:${apiPort}`;
    try {
        for (let i = 0; !bridgeOut.includes("Server started"); i++) {
            assert(i < 100, "bridge did not start");
            await new Promise((r) => setTimeout(r, 100));
        }

        const start = await post(base, "start", {
            port: mcPort,
            version,
            reset: "hard",
            inventory: { oak_log: 2 },
            equipment: [null, null, null, null, null, null],
            waitTicks: 5,
        });
        assert.strictEqual(start.status, 200, JSON.stringify(start.body));
        const events = JSON.parse(start.body);
        const obs = events[events.length - 1];
        assert.strictEqual(obs[0], "observe");
        assert.strictEqual(obs[1].status.version, version);
        console.log("start: observation ok", obs[1].status.position);

        assert.strictEqual((await post(base, "pause")).status, 200);
        assert.strictEqual((await post(base, "unpause")).status, 200);

        const programs = require("fs")
            .readdirSync(path.join(__dirname, "..", "..", "..", "control_primitives"))
            .filter((f) => f.endsWith(".js"))
            .map((f) =>
                require("fs").readFileSync(
                    path.join(__dirname, "..", "..", "..", "control_primitives", f),
                    "utf8"
                )
            )
            .join("\n\n");
        const step = await post(base, "step", {
            code: 'bot.chat("hello from step");',
            programs,
        });
        assert.strictEqual(step.status, 200, JSON.stringify(step.body));
        const stepEvents = JSON.parse(step.body);
        const chat = stepEvents.find(([type]) => type === "onChat");
        assert(chat && chat[1].onChat.includes("hello from step"), "chat event missing");
        console.log("step: ok,", stepEvents.length, "events");

        const failing = await post(base, "step", {
            code: "await mineBlock(bot, 'diamond_ore', 1);",
            programs,
        });
        assert.strictEqual(failing.status, 200);
        console.log("step with primitive: ok");

        await post(base, "stop");
        await new Promise((r) => setTimeout(r, 500));

        const expectNewNames = registry.version[">="]("1.21.11");
        const expected = [
            "/clear @s",
            "/give @s minecraft:oak_log 2",
            "/tick freeze",
            "/tick unfreeze",
            expectNewNames ? "/gamerule keep_inventory true" : "/gamerule keepInventory true",
            expectNewNames ? "/gamerule advance_time false" : "/gamerule doDaylightCycle false",
            expectNewNames ? "/gamerule block_drops false" : "/gamerule doTileDrops false",
        ];
        for (const cmd of expected) {
            assert(commands.includes(cmd), `missing command ${cmd}; got ${commands.join(" | ")}`);
        }
        assert(
            commands.some((c) => c.startsWith("/spawnpoint @s ")),
            `missing /spawnpoint; got ${commands.join(" | ")}`
        );
        console.log(`commands ok: ${commands.join(" | ")}`);

        // normal player: no commands, and no chat sent to the server
        const sentBefore = commands.length;
        const chatsBefore = chats.length;
        const normal = await post(base, "start", {
            port: mcPort,
            version,
            reset: "hard",
            cheats: false,
            inventory: { diamond: 64 },
            waitTicks: 5,
        });
        assert.strictEqual(normal.status, 200, JSON.stringify(normal.body));
        assert.strictEqual((await post(base, "pause")).status, 200);
        assert.strictEqual((await post(base, "unpause")).status, 200);
        const normalStep = await post(base, "step", {
            code: 'bot.chat("/give @s diamond 64"); bot.chat("progress report");',
            programs,
        });
        assert.strictEqual(normalStep.status, 200, JSON.stringify(normalStep.body));
        const log = JSON.parse(normalStep.body)
            .filter(([type]) => type === "onChat")
            .map(([, e]) => e.onChat)
            .join(" ");
        assert(log.includes("Cannot use /give"), `no refusal in chat log: ${log}`);
        assert(log.includes("progress report"), `chat log missing message: ${log}`);
        await post(base, "stop");
        await new Promise((r) => setTimeout(r, 500));
        const extra = commands.slice(sentBefore);
        assert.deepStrictEqual(extra, [], `normal player sent commands: ${extra.join(" | ")}`);
        assert.strictEqual(chats.length, chatsBefore, "normal player chatted on the server");
        console.log("normal player: no commands or server chat sent");
        console.log(`SMOKE TEST PASSED for Minecraft ${version}`);
    } catch (err) {
        console.error("bridge output:\n" + bridgeOut.slice(-3000));
        throw err;
    } finally {
        bridge.kill();
        server.close();
    }
}

main().catch((err) => {
    console.error("SMOKE TEST FAILED:", err.message);
    process.exit(1);
});
