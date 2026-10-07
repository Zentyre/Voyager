// Support for Minecraft versions newer than the installed libraries know.
//
// minecraft-data / minecraft-protocol / mineflayer stop at 26.1. This adds
// 26.3: the data in compat/26.3/ (built by compat/build-26.3.js from public
// sources) is registered with minecraft-data, and patchBot() adapts the few
// places where mineflayer itself sends or reads packets whose meaning changed
// in 26.2/26.3 (teleport confirmation, digging action codes, arm swing,
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

    const write = client.write.bind(client);
    client.write = (name, params) => {
        if (!is26_3(bot)) return write(name, params);
        switch (name) {
            case "teleport_confirm": {
                // 26.3 confirms with the position the client ended up at
                // (mineflayer has already applied the teleport at this point).
                const pos = bot.entity?.position;
                return write(name, {
                    teleportId: params.teleportId,
                    x: pos?.x ?? 0,
                    y: pos?.y ?? 0,
                    z: pos?.z ?? 0,
                    yaw: bot.entity ? conv.toNotchianYaw(bot.entity.yaw) : 0,
                    pitch: bot.entity ? conv.toNotchianPitch(bot.entity.pitch) : 0,
                });
            }
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
                return write(name, params);
        }
    };

    const emit = client.emit.bind(client);
    client.emit = (event, packet, ...rest) => {
        if (!is26_3(bot) || !packet || typeof packet !== "object") return emit(event, packet, ...rest);
        switch (event) {
            case "rel_entity_move":
            case "entity_move_look":
                packet.onGround = (packet.flags & 1) === 1;
                break;
            case "sync_entity_position":
                packet.dx = packet.dy = packet.dz = 0;
                break;
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

module.exports = { registerExtraVersions, patchBot, EXTRA_VERSIONS };
