// Support for Minecraft versions newer than the installed libraries know.
//
// minecraft-data / minecraft-protocol / mineflayer stop at 26.1. This adds
// 26.3: the data in compat/26.3/ (built by compat/build-26.3.js from public
// sources) is registered with minecraft-data, and patchBot() adapts the few
// places where mineflayer itself sends or reads packets whose meaning changed
// in 26.2/26.3 (teleport confirmation, digging action codes, sprint/wake action
// codes, arm swing, light masks, entity movement, signs, particles).

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
    listEnchantments();
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

// Items' enchantments, since items carry components (1.20.5+): prismarine-item
// hands back the component as it came ({ enchantments: [{ id, level }] }),
// where mineflayer and prismarine-block expect a list of { name, lvl }. An
// enchanted tool couldn't dig at all ("enchantments.concat is not a
// function", or "not iterable" without a helmet on). Names come from the
// server's own list of enchantments (sent on joining, see patchBot: mods add
// to it, which moves the numbers), else the built-in one.
function listEnchantments() {
    const id = require.resolve("prismarine-item");
    const original = require(id);
    if (original.enchantsListed) return;
    const wrapped = function (registryOrVersion) {
        const Item = original(registryOrVersion);
        const registry = typeof registryOrVersion === "string" ? require("prismarine-registry")(registryOrVersion) : registryOrVersion;
        const own = Object.getOwnPropertyDescriptor(Item.prototype, "enchants");
        if (!own?.get) return Item;
        Object.defineProperty(Item.prototype, "enchants", {
            configurable: true,
            get() {
                const component = this.componentMap?.get?.("enchantments");
                if (!component) return own.get.call(this);
                const data = component.data;
                const list = Array.isArray(data) ? data : Array.isArray(data?.enchantments) ? data.enchantments : [];
                const names = registry?.serverEnchantments;
                return list.map((e) => ({
                    name: (typeof e.name === "string" ? e.name : names?.[e.id] ?? registry?.enchantments?.[e.id]?.name) ?? null,
                    lvl: e.level ?? e.lvl ?? 0,
                }));
            },
            set: own.set,
        });
        return Item;
    };
    wrapped.enchantsListed = true;
    require.cache[id].exports = wrapped;
}

function is26_3(bot) {
    return bot.registry?.version?.minecraftVersion === "26.3" || bot._client?.version === "26.3";
}

// Translate between what mineflayer sends/expects and the 26.3 protocol.
function patchBot(bot) {
    const conv = require("mineflayer/lib/conversions");
    const client = bot._client;

    // The server's list of enchantments, in its order (items name them by
    // number): see listEnchantments.
    client.on("registry_data", (packet) => {
        if (!/(^|:)enchantment$/.test(packet?.id || "") || !Array.isArray(packet.entries) || !bot.registry) return;
        bot.registry.serverEnchantments = packet.entries.map((e) => String(e.key).replace(/^minecraft:/, ""));
    });

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
    let blockSequence = 0;
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
                // 26.3 inserted "change destroy direction" as action 1. Number the
                // block actions like a real client (mineflayer always sends 0).
                return write(name, { ...params, status: params.status >= 1 ? params.status + 1 : params.status, sequence: params.sequence || ++blockSequence });
            case "block_place":
                return write(name, { ...params, sequence: params.sequence || ++blockSequence });
            case "arm_animation":
                // Swinging is now "punch", main hand only.
                if (!params.hand) return write("punch", {});
                return undefined;
            case "entity_action":
                // Mineflayer still sends the pre-1.21.6 numbers (3/4 sprint, 2 wake),
                // which 26.3 reads as horse jumps and stop sprinting.
                if (typeof params.actionId === "number") {
                    const actionId = { 2: "leave_bed", 3: "start_sprinting", 4: "stop_sprinting", 8: "start_elytra_flying" }[params.actionId];
                    if (!actionId) return undefined;
                    params = { ...params, actionId };
                }
                note(`out ${name} ${fmt(params)}`);
                return write(name, params);
            case "update_sign": {
                const { isFrontText, ...rest } = params;
                return write(name, { ...rest, textSlot: isFrontText === false ? 0 : 1 });
            }
            default:
                if (/^(player_input|player_loaded|use_entity|abilities)$/.test(name)) {
                    note(`out ${name} ${fmt(params)}`);
                }
                return write(name, params);
        }
    };

    // An exception thrown while handling a packet leaves minecraft-protocol's
    // packet parser stuck mid-packet: nothing more is read, the bot stops
    // answering keep-alives and times out 30 seconds later. So each listener of
    // a packet runs on its own; a failure is reported with the packet's name and
    // the rest carry on.
    const originalEmit = client.emit.bind(client);
    const reported = new Set();
    const report = (packetName, err) => {
        const key = `${packetName} ${err.message}`;
        if (reported.has(key)) return;
        reported.add(key);
        const where = (err.stack || "").split("\n").slice(1, 6).join("\n");
        console.log(`[${bot.username}] Error handling the server's ${packetName} packet (ignored): ${err.message}\n${where}`);
    };
    const isPacket = (meta) => meta && typeof meta === "object" && typeof meta.name === "string";
    const emit = (event, packet, meta, ...rest) => {
        if (!isPacket(meta)) return originalEmit(event, packet, meta, ...rest);
        const listeners = client.rawListeners(event);
        for (const listener of listeners) {
            try {
                listener.call(client, packet, meta, ...rest);
            } catch (err) {
                report(meta.name, err);
            }
        }
        return listeners.length > 0;
    };

    // If the server seems to go quiet, these say whether packets stopped
    // arriving or arrived but couldn't be read, and whether the bot froze.
    const clock = (t) => new Date(t).toISOString().slice(11, 19);
    const received = []; // recent packets from the server
    const silences = []; // gaps of over 2 s between packets: [when it ended, seconds]
    const perSecond = new Map(); // second -> packets read
    let lastPacketAt = Date.now();
    let lastKeepAliveAt = null;
    let bytesAtLastPacket = 0;
    const notePacket = (name) => {
        const now = Date.now();
        if (now - lastPacketAt > 2000) {
            silences.push([now, (now - lastPacketAt) / 1000]);
            if (silences.length > 5) silences.shift();
        }
        lastPacketAt = now;
        if (name === "keep_alive") lastKeepAliveAt = now;
        bytesAtLastPacket = client.socket?.bytesRead ?? 0;
        const second = Math.floor(now / 1000);
        perSecond.set(second, (perSecond.get(second) || 0) + 1);
        if (perSecond.size > 90) perSecond.delete(perSecond.keys().next().value);
        received.push(`${new Date(now).toISOString().slice(11, 23)} ${name}`);
        if (received.length > 15) received.shift();
    };
    const diagnose = () => {
        const now = Date.now();
        const quiet = ((now - lastPacketAt) / 1000).toFixed(1);
        const unread = (client.socket?.bytesRead ?? 0) - bytesAtLastPacket;
        let recent = 0;
        for (const [second, count] of perSecond) if (second * 1000 > now - 30000) recent += count;
        const gaps = silences.filter(([at]) => at > now - 60000);
        const longest = Math.max(0, ...gaps.map(([, secs]) => secs));
        const verdict =
            longest >= 15 || now - lastPacketAt >= 15000
                ? "The server sent nothing for a long stretch: the server (or the network) stalled. " +
                  "Check the server console around this time for \"Can't keep up!\" messages."
                : "The server kept sending game data but no keep-alives.";
        console.log(
            `[${bot.username}] Connection diagnostics: ${verdict}\n` +
                `  Last keep-alive from the server: ${lastKeepAliveAt ? `${((now - lastKeepAliveAt) / 1000).toFixed(1)} s ago` : "none"}.\n` +
                `  Packets read in the last 30 s: ${recent}. Last packet: ${quiet} s ago, ` +
                `${unread} bytes arrived after it${unread > 0 ? " that the bot could not read" : ""}.\n` +
                `  Silences over 2 s in the last minute: ${gaps.length ? gaps.map(([at, secs]) => `${secs.toFixed(1)} s ending ${clock(at)}`).join(", ") : "none"}.\n` +
                `  Last packets read:\n    ${received.join("\n    ")}`
        );
    };
    client.on("error", (err) => {
        if (/timed out/.test(err.message)) diagnose();
    });
    let lastBeat = Date.now();
    // minecraft-protocol hangs up after 30 s without a keep-alive (the bot
    // passes a longer limit, see bot.js). Some servers go quiet on keep-alives
    // while still sending game data, and would kick the bot themselves (with a
    // reason) if they really wanted a reply. So only hang up when the server
    // sends nothing at all for a minute.
    let quietNotice = false;
    const heartbeat = setInterval(() => {
        const now = Date.now();
        const gap = now - lastBeat;
        if (gap > 5000) console.log(`[${bot.username}] The bot froze for ${(gap / 1000).toFixed(1)} s (busy computing).`);
        lastBeat = now;
        if (client.state !== "play" || lastKeepAliveAt === null) return;
        if (now - lastKeepAliveAt > 45000 && now - lastPacketAt < 5000 && !quietNotice) {
            quietNotice = true;
            console.log(`[${bot.username}] The server hasn't sent a keep-alive for 45 s but is still sending game data; staying connected.`);
        } else if (now - lastKeepAliveAt < 45000) {
            quietNotice = false;
        }
        if (now - lastPacketAt > 60000) {
            console.log(`[${bot.username}] Nothing from the server for 60 s; disconnecting.`);
            diagnose();
            client.end("timeout");
        }
    }, 1000);
    heartbeat.unref?.();
    client.once("end", () => clearInterval(heartbeat));
    const translate = (event, packet, ...rest) => {
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
                emit("animation", { entityId: packet.entityId, animation: packet.hand === 1 ? 3 : 0 }, { ...rest[0], name: "animation" });
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
    client.emit = (event, packet, meta, ...rest) => {
        if (!isPacket(meta)) return translate(event, packet, meta, ...rest);
        if (event === meta.name) notePacket(event);
        try {
            return translate(event, packet, meta, ...rest);
        } catch (err) {
            report(meta.name, err);
            return false;
        }
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
