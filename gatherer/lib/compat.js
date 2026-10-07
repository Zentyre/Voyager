// Support for Minecraft versions newer than the installed libraries know.
//
// minecraft-data / minecraft-protocol / mineflayer stop at 26.1. This adds
// 26.3: the data in compat/26.3/ (built by compat/build-26.3.js from public
// sources) is registered with minecraft-data, and patchBot() adapts the few
// places where mineflayer itself sends or reads packets whose meaning changed
// in 26.2/26.3 (teleport confirmation, digging action codes, arm swing, light masks,
// entity movement, signs, particles).

const path = require("path");

const EXTRA_VERSIONS = {
    "26.3": {
        dir: path.join(__dirname, "..", "compat", "26.3"),
        // Our own files; everything else is taken from the installed 26.1 data.
        files: [
            "attributes", "blockCollisionShapes", "blocks", "blockLoot", "biomes", "entities", "entityLoot",
            "foods", "items", "materials", "particles", "protocol", "recipes", "sounds", "tints", "version",
        ],
    },
};

let registered = false;

// Must run before minecraft-data is asked about these versions (we call it
// first thing at startup).
function registerExtraVersions() {
    if (registered) return;
    registered = true;
    const data = require("minecraft-data/data.js");
    const base = data.pc["26.1"];
    for (const [version, { dir, files }] of Object.entries(EXTRA_VERSIONS)) {
        if (data.pc[version]) continue; // a newer minecraft-data already has it
        const entry = {};
        for (const key of Object.getOwnPropertyNames(base)) {
            const get = files.includes(key)
                ? () => require(path.join(dir, `${key}.json`))
                : () => base[key];
            Object.defineProperty(entry, key, { get, enumerable: true });
        }
        data.pc[version] = entry;
    }
    aliasChunkFormat();
    aliasPhysicsFeatures();
    allowInMineflayer();
}

// prismarine-physics lists the exact versions each physics rule applies to.
// Movement physics didn't change after 26.1, so give 26.3 the 26.1 rules.
function aliasPhysicsFeatures() {
    const features = require("prismarine-physics/lib/features.json");
    for (const feature of features) {
        if (!feature.versions.includes("26.1")) continue;
        for (const version of Object.keys(EXTRA_VERSIONS)) {
            if (!feature.versions.includes(version)) feature.versions.push(version);
        }
    }
}

// mineflayer refuses servers newer than its newest tested version. It reads
// that once when it first loads, so this must run before mineflayer is required.
function allowInMineflayer() {
    const versions = require("mineflayer/lib/version");
    for (const version of Object.keys(EXTRA_VERSIONS)) {
        if (!versions.testedVersions.includes(version)) versions.testedVersions.push(version);
    }
    versions.latestSupportedVersion = versions.testedVersions[versions.testedVersions.length - 1];
}

// prismarine-chunk picks its chunk code from a per-version table that stops at
// 26.1. The chunk format didn't change in 26.2/26.3, so serve 26.1's code.
function aliasChunkFormat() {
    const id = require.resolve("prismarine-chunk");
    const original = require(id);
    if (original.compatWrapped) return;
    const wrapped = function (registryOrVersion) {
        const major = registryOrVersion?.version?.majorVersion;
        if (major && EXTRA_VERSIONS[major]) {
            const version = { ...registryOrVersion.version, majorVersion: "26.1" };
            const registry = new Proxy(registryOrVersion, {
                get: (target, key) => (key === "version" ? version : Reflect.get(target, key)),
            });
            return original(registry);
        }
        return original(registryOrVersion);
    };
    wrapped.compatWrapped = true;
    require.cache[id].exports = wrapped;
}

function is26_3(bot) {
    return bot.registry?.version?.minecraftVersion === "26.3" || bot._client?.version === "26.3";
}

// Translate between what mineflayer sends/expects and the 26.3 protocol.
function patchBot(bot) {
    const conv = require("mineflayer/lib/conversions");
    const client = bot._client;

    // Recent movement-related packets, printed if the server kicks the bot, so a
    // kick can be traced to the packet that caused it.
    const trace = [];
    const note = (line) => {
        trace.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
        if (trace.length > 40) trace.shift();
    };
    bot.on("kicked", () => {
        if (!is26_3(bot) || !trace.length) return;
        console.log(`[${bot.username}] 26.3 debug, last packets before the kick:\n  ${trace.join("\n  ")}`);
    });

    const teleports = new Map(); // teleport id -> the server's position packet
    const confirmed = new Set();
    const finite = (...values) => values.every((v) => v === undefined || Number.isFinite(v));
    const inWorld = (p) => Math.abs(p.x ?? 0) < 3e7 && Math.abs(p.z ?? 0) < 3e7 && Math.abs(p.y ?? 0) < 2e7;

    // A 26.3 client sends at most one movement per tick and ends every tick with
    // tick_end; a teleport confirmation (which now carries the position) is that
    // tick's movement. Mineflayer sends no tick_end and follows each confirmation
    // with an extra position packet, so pace its packets the same way.
    let movedThisTick = false;
    let justConfirmed = false;
    const endTick = () => {
        if (client.state !== "play") return;
        write("tick_end", {});
        movedThisTick = false;
    };
    let ticker = null;
    bot.once("login", () => {
        if (is26_3(bot)) ticker = setInterval(endTick, 50);
    });
    client.once("end", () => clearInterval(ticker));
    const isMove = (name) => /^(position|position_look|look|flying)$/.test(name);

    const write = client.write.bind(client);
    client.write = (name, params) => {
        if (!is26_3(bot)) return write(name, params);
        if (isMove(name)) {
            if (justConfirmed) {
                note(`out ${name} DROPPED (the teleport confirmation already moved the player)`);
                return undefined;
            }
            if (movedThisTick) endTick();
            movedThisTick = true;
        }
        switch (name) {
            case "teleport_confirm": {
                // A second confirmation for the same teleport gets the player kicked.
                if (confirmed.has(params.teleportId)) {
                    note(`out teleport_confirm #${params.teleportId} DROPPED (already confirmed)`);
                    return undefined;
                }
                confirmed.add(params.teleportId);
                if (confirmed.size > 50) confirmed.delete(confirmed.values().next().value);
                // 26.3 confirms with the position the client ended up at
                // (mineflayer has already applied the teleport at this point).
                // Absolute angles are echoed back exactly as the server sent them.
                const tp = teleports.get(params.teleportId);
                teleports.delete(params.teleportId);
                const pos = bot.entity?.position;
                const out = {
                    teleportId: params.teleportId,
                    x: pos?.x ?? tp?.x ?? 0,
                    y: pos?.y ?? tp?.y ?? 0,
                    z: pos?.z ?? tp?.z ?? 0,
                    yaw: tp && !tp.flags?.yaw ? tp.yaw : bot.entity ? conv.toNotchianYaw(bot.entity.yaw) : 0,
                    pitch: tp && !tp.flags?.pitch ? tp.pitch : bot.entity ? conv.toNotchianPitch(bot.entity.pitch) : 0,
                };
                note(`out teleport_confirm #${out.teleportId} ${fmt(out)}`);
                if (movedThisTick) endTick();
                movedThisTick = true;
                justConfirmed = true;
                setImmediate(() => (justConfirmed = false));
                return write(name, out);
            }
            case "position":
            case "position_look":
            case "look":
            case "flying":
            case "vehicle_move":
                if (!finite(params.x, params.y, params.z, params.yaw, params.pitch) || !inWorld(params)) {
                    note(`out ${name} DROPPED (invalid values) ${fmt(params)}`);
                    return undefined;
                }
                if (name !== "flying") note(`out ${name} ${fmt(params)}`);
                return write(name, params);
            case "block_dig":
                // 26.3 inserted "change destroy direction" as action 1.
                return write(name, { ...params, status: params.status >= 1 ? params.status + 1 : params.status });
            case "arm_animation":
                // Swinging is now "punch", main hand only.
                if (!params.hand) return write("punch", {});
                return undefined;
            case "update_sign": {
                const { isFrontText, ...rest } = params;
                return write(name, { ...rest, textSlot: isFrontText === false ? 0 : 1 });
            }
            default:
                if (/^(player_input|player_loaded|use_entity|entity_action|abilities)$/.test(name)) {
                    note(`out ${name} ${fmt(params)}`);
                }
                return write(name, params);
        }
    };

    const emit = client.emit.bind(client);
    client.emit = (event, packet, ...rest) => {
        if (!is26_3(bot) || !packet || typeof packet !== "object") return emit(event, packet, ...rest);
        if (/^(position|player_rotation|respawn|login|explosion|entity_velocity|entity_teleport|sync_entity_position|game_state_change|update_health|vehicle_move)$/.test(event)) {
            const self = bot.entity?.id;
            if (packet.entityId === undefined || packet.entityId === self || event === "login") {
                note(`in  ${event} ${fmt(packet)}`);
            }
        }
        switch (event) {
            case "position":
                teleports.set(packet.teleportId, packet);
                if (teleports.size > 50) teleports.delete(teleports.keys().next().value);
                break;
            case "entity_update_attributes":
                // physics adds its own sprint boost; drop the server's to avoid doubling it
                for (const prop of packet.properties || []) {
                    if (prop.modifiers) prop.modifiers = prop.modifiers.filter((m) => m.uuid !== "minecraft:sprinting");
                }
                break;
            case "map_chunk":
            case "update_light":
                // Light masks are byte arrays now; mineflayer expects longs.
                for (const key of ["skyLightMask", "blockLightMask", "emptySkyLightMask", "emptyBlockLightMask"]) {
                    if (Buffer.isBuffer(packet[key])) packet[key] = bitSetToLongs(packet[key]);
                }
                break;
            case "rel_entity_move":
            case "entity_move_look": {
                const look = event === "entity_move_look";
                const tail = readMovementTail(packet.movement, look ? 8 : 6);
                if (!tail) return false; // malformed: skip rather than corrupt the entity
                packet.dX = tail.readInt16BE(0);
                packet.dY = tail.readInt16BE(2);
                packet.dZ = tail.readInt16BE(4);
                if (look) {
                    packet.yaw = tail.readInt8(6);
                    packet.pitch = tail.readInt8(7);
                }
                packet.onGround = (packet.flags & 1) === 1;
                break;
            }
            case "sync_entity_position": {
                const sync = readSyncPosition(packet.movement);
                if (!sync) return false;
                Object.assign(packet, sync, { dx: 0, dy: 0, dz: 0 });
                break;
            }
            case "animation":
                // 26.3: 0 wake up, 1 critical hit, 2 magic critical hit (swings moved out).
                packet.animation = { 0: 2, 1: 4, 2: 5 }[packet.animation] ?? packet.animation;
                break;
            case "swing_animation":
                emit("animation", { entityId: packet.entityId, animation: packet.hand === 1 ? 3 : 0 });
                break;
            case "open_sign_entity":
                packet.isFrontText = packet.textSlot !== 0;
                break;
            case "world_particles":
                packet.velocityOffset = packet.maxSpeedX;
                break;
        }
        return emit(event, packet, ...rest);
    };
}

// Short one-line form of a packet for the debug trace.
function fmt(packet) {
    const round = (v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);
    const parts = [];
    for (const [k, v] of Object.entries(packet || {})) {
        if (v === undefined || Buffer.isBuffer(v) || k === "worldNames" || k === "worldState") continue;
        if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some((x) => typeof x === "boolean")) {
            parts.push(`${k}=[${Object.keys(v).filter((f) => v[f] === true).join(",")}]`); // bit flags
            continue;
        }
        parts.push(`${k}=${typeof v === "object" && v !== null ? JSON.stringify(v, (_, x) => round(x)) : round(v)}`);
    }
    return parts.join(" ").slice(0, 240);
}

// BitSet.toByteArray() bytes -> the [high, low] int32 pairs minecraft-protocol
// uses for an array of i64.
function bitSetToLongs(bytes) {
    const longs = [];
    for (let i = 0; i < bytes.length; i += 8) {
        const word = Buffer.alloc(8);
        bytes.copy(word, 0, i, Math.min(i + 8, bytes.length));
        longs.push([word.readInt32LE(4), word.readInt32LE(0)]);
    }
    return longs;
}

// Reads consecutive varints from buf starting at offset; returns the offset after
// them if they end exactly at `end`, else -1.
function skipVarints(buf, offset, end) {
    while (offset < end) {
        let n = 0;
        while (offset < end && buf[offset] & 0x80 && n < 5) { offset++; n++; }
        if (offset >= end) return -1;
        offset++;
    }
    return offset === end ? offset : -1;
}

// Entity moves: optional step varints, then a fixed-size tail (deltas, angles).
function readMovementTail(buf, tailSize) {
    if (!Buffer.isBuffer(buf) || buf.length < tailSize) return null;
    const end = buf.length - tailSize;
    if (skipVarints(buf, 0, end) < 0) return null;
    return buf.subarray(end);
}

// Position sync: step varints, x/y/z doubles, interpolation varint, yaw, pitch,
// on ground. The number of leading varints isn't fixed, so try the layouts in
// order of likelihood and keep the one whose varints line up exactly.
function readSyncPosition(buf) {
    if (!Buffer.isBuffer(buf)) return null;
    const tail = buf.length - 9; // yaw f32, pitch f32, onGround bool
    for (const heads of [2, 1, 0, 3]) {
        let offset = 0;
        let ok = true;
        for (let i = 0; i < heads && ok; i++) {
            let n = 0;
            while (offset < buf.length && buf[offset] & 0x80 && n < 5) { offset++; n++; }
            offset++;
            if (offset > buf.length) ok = false;
        }
        const xyzEnd = offset + 24;
        // at least the interpolation varint must sit between z and yaw
        if (!ok || xyzEnd >= tail || skipVarints(buf, xyzEnd, tail) < 0) continue;
        return {
            x: buf.readDoubleBE(offset),
            y: buf.readDoubleBE(offset + 8),
            z: buf.readDoubleBE(offset + 16),
            yaw: buf.readFloatBE(tail),
            pitch: buf.readFloatBE(tail + 4),
            onGround: buf[tail + 8] !== 0,
        };
    }
    return null;
}

module.exports = { registerExtraVersions, patchBot, EXTRA_VERSIONS };
