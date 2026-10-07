// Modded servers (Fabric, NeoForge). The bot can't run mods (they are Java code
// for the real game client), but it can cope with what they send:
//
//   - Blocks added by mods arrive as state ids the bot has no data for, and
//     the libraries treat those as air: the bot would walk into them, fall
//     through them, or get stuck. They become a "modded_block" instead: solid,
//     never broken.
//   - The mods the server announces (through its plugin channels) are listed
//     once after joining, to help tell which one is causing trouble.

const VANILLA_NAMESPACES = new Set(["minecraft", "c", "fabric", "neoforge", "forge", "bungeecord", "velocity", "paper", "bukkit"]);

function installModSupport(bot, log) {
    const registry = bot.registry;
    const vanillaMaxState = Math.max(...registry.blocksArray.map((b) => b.maxStateId));
    const stone = registry.blocksByName.stone;
    const cube = [[0, 0, 0, 1, 1, 1]];
    const moddedType = Math.max(...registry.blocksArray.map((b) => b.id)) + 1;
    const template = {
        ...stone,
        shapes: cube,
        id: moddedType,
        name: "modded_block",
        displayName: "Modded block",
        hardness: null,
        diggable: false,
        harvestTools: undefined,
        drops: [],
        states: [],
        material: undefined,
    };
    registry.blocks[moddedType] = template;
    registry.blocksByName.modded_block = template;
    // prismarine-block looks collision shapes up by name: a full cube, like stone
    const shapes = registry.blockCollisionShapes;
    if (shapes?.blocks) shapes.blocks.modded_block = shapes.blocks.stone;

    let unknownStates = 0;
    const learnState = (stateId) => {
        if (stateId <= vanillaMaxState || registry.blocksByStateId[stateId]) return;
        registry.blocksByStateId[stateId] = { ...template, shapes: cube, minStateId: stateId, maxStateId: stateId, defaultState: stateId };
        if (unknownStates++ === 0) {
            log("This server has blocks from mods. The bot treats them as solid and won't break them.");
        }
    };

    const client = bot._client;
    client.on("map_chunk", (packet) => {
        const column = bot.world.getColumn(packet.x, packet.z);
        for (const section of column?.sections || []) {
            if (!section) continue;
            if (section.palette) {
                for (const stateId of section.palette) learnState(stateId);
            } else if (section.data?.get) {
                // direct palette: no list of what's in it, so look at every block
                for (let i = 0; i < 4096; i++) learnState(section.data.get(i));
            }
        }
    });
    client.on("block_change", (packet) => learnState(packet.type));
    client.on("multi_block_change", (packet) => {
        // each record: state id << 12 | x << 8 | z << 4 | y
        for (const record of packet.records || []) learnState(Math.floor(record / 4096));
    });

    // Plugin channels look like "modid:name"; the namespaces say which mods talk to clients.
    const namespaces = new Set();
    const noteChannel = (channel) => {
        const namespace = String(channel).split(":")[0];
        if (namespace && !VANILLA_NAMESPACES.has(namespace)) namespaces.add(namespace);
    };
    client.on("custom_payload", (packet) => noteChannel(packet.channel));
    client.on("minecraft:register", (channels) => (channels || []).forEach(noteChannel));
    bot.once("spawn", () => {
        setTimeout(() => {
            const brand = bot.game?.serverBrand;
            const modded = brand && !/^vanilla$/i.test(brand);
            if (!modded && namespaces.size === 0) return;
            const mods = namespaces.size ? ` Mods it announces: ${[...namespaces].sort().join(", ")}.` : "";
            log(`Server: ${brand || "unknown"}.${mods}`);
        }, 5000);
    });

    return { moddedType };
}

module.exports = { installModSupport };
