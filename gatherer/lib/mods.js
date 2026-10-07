// Modded servers (Fabric, NeoForge). The bot can't run mods (they are Java code
// for the real game client), but it can cope with what they send:
//
//   - Blocks added by mods arrive as state ids the bot has no data for, and
//     the libraries treat those as air: the bot would walk into them, fall
//     through them, or get stuck. They become a "modded_block" instead: solid,
//     never broken.
//   - Mods like Visual Workbench, Easy Anvils and Easy Magic swap the crafting
//     table, anvil and enchanting table screens for their own, which the bot
//     didn't recognise, so it never saw them open. Underneath they are the
//     vanilla screens (same slots and buttons), so an unknown screen is mapped
//     to the vanilla one by its title or by the block that was just used.
//   - The mods the server announces (through its plugin channels) are listed
//     once after joining, to help tell which one is causing trouble.

const nbt = require("prismarine-nbt");
const { Vec3 } = require("vec3");

// Screen titles (translation keys) and blocks -> the vanilla screen they open.
const SCREEN_BY_TITLE = {
    "container.crafting": "minecraft:crafting",
    "container.repair": "minecraft:anvil",
    "container.enchant": "minecraft:enchantment",
    "container.grindstone_title": "minecraft:grindstone",
    "container.upgrade": "minecraft:smithing",
    "container.stonecutter": "minecraft:stonecutter",
    "container.loom": "minecraft:loom",
    "container.cartography_table": "minecraft:cartography",
    "container.brewing": "minecraft:brewing_stand",
    "container.furnace": "minecraft:furnace",
    "container.blast_furnace": "minecraft:blast_furnace",
    "container.smoker": "minecraft:smoker",
};
const SCREEN_BY_BLOCK = {
    crafting_table: "minecraft:crafting",
    anvil: "minecraft:anvil",
    chipped_anvil: "minecraft:anvil",
    damaged_anvil: "minecraft:anvil",
    enchanting_table: "minecraft:enchantment",
    grindstone: "minecraft:grindstone",
    smithing_table: "minecraft:smithing",
    stonecutter: "minecraft:stonecutter",
    loom: "minecraft:loom",
    cartography_table: "minecraft:cartography",
    brewing_stand: "minecraft:brewing_stand",
    furnace: "minecraft:furnace",
    blast_furnace: "minecraft:blast_furnace",
    smoker: "minecraft:smoker",
};

// The translation key in a screen title ({"translate": "container.crafting"}), if any.
function titleKey(title) {
    try {
        const value = title && typeof title === "object" && "type" in title ? nbt.simplify(title) : title;
        if (typeof value === "string") {
            try {
                return JSON.parse(value).translate || null;
            } catch (err) {
                return value.startsWith("container.") ? value : null;
            }
        }
        return value?.translate || null;
    } catch (err) {
        return null;
    }
}

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

    // A mod can replace a vanilla block with its own (a crafting table from
    // Visual Workbench, say). Once the bot sees what one is (it placed a
    // crafting table and got this block, or clicking it opened a crafting
    // screen), that block state counts as the vanilla block from then on.
    const taught = new Set();
    bot.teachModdedBlock = (pos, name) => {
        const vanilla = registry.blocksByName[name];
        const stateId = bot.world.getBlockStateId(pos);
        if (!vanilla || !(stateId > vanillaMaxState) || taught.has(stateId)) return false;
        taught.add(stateId);
        registry.blocksByStateId[stateId] = { ...vanilla, minStateId: stateId, maxStateId: stateId, defaultState: stateId };
        log(`This server's ${name.replace(/_/g, " ")} is a block from a mod; I'll recognise it from now on.`);
        return true;
    };

    let unknownStates = 0;
    const learnState = (stateId) => {
        if (stateId <= vanillaMaxState || registry.blocksByStateId[stateId]) return;
        registry.blocksByStateId[stateId] = { ...template, shapes: cube, minStateId: stateId, maxStateId: stateId, defaultState: stateId };
        if (unknownStates++ === 0) {
            log("This server has blocks from mods. The bot treats them as solid and won't break them.");
        }
    };

    const client = bot._client;
    // After mineflayer has stored the chunk (a raw map_chunk listener can run first).
    bot.on("chunkColumnLoad", (corner) => {
        const column = bot.world.getColumn(Math.floor(corner.x / 16), Math.floor(corner.z / 16));
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

    // Modded screens -> vanilla ones (see the top of this file).
    const windows = require("prismarine-windows")(registry).windows;
    const vanillaScreens = new Map(); // "minecraft:crafting" -> protocol id
    for (const [key, w] of Object.entries(windows)) if (w && typeof w.type === "number") vanillaScreens.set(key, w.type);
    const knownIds = new Set(vanillaScreens.values());
    const moddedScreens = new Map(); // modded id -> vanilla key
    let lastUsed = null; // the block the bot last clicked
    const write = client.write.bind(client);
    client.write = (name, params) => {
        if (name === "block_place" && params?.location) lastUsed = { pos: params.location, at: Date.now() };
        return write(name, params);
    };
    const STATION_BLOCK = { "minecraft:crafting": "crafting_table", "minecraft:anvil": "anvil", "minecraft:enchantment": "enchanting_table",
        "minecraft:grindstone": "grindstone", "minecraft:smithing": "smithing_table", "minecraft:stonecutter": "stonecutter",
        "minecraft:loom": "loom", "minecraft:cartography": "cartography_table", "minecraft:brewing_stand": "brewing_stand",
        "minecraft:furnace": "furnace", "minecraft:blast_furnace": "blast_furnace", "minecraft:smoker": "smoker" };
    client.prependListener("open_window", (packet) => {
        // Clicked a modded block and got a station's screen: that block is the station.
        const recent = lastUsed && Date.now() - lastUsed.at < 5000;
        const clicked = recent ? new Vec3(lastUsed.pos.x, lastUsed.pos.y, lastUsed.pos.z) : null;
        const clickedModded = clicked && bot.blockAt(clicked)?.name === "modded_block";
        if (vanillaScreens.size === 0 || knownIds.has(packet.inventoryType)) {
            const key = [...vanillaScreens].find(([, id]) => id === packet.inventoryType)?.[0];
            if (clickedModded && STATION_BLOCK[key]) bot.teachModdedBlock(clicked, STATION_BLOCK[key]);
            return;
        }
        let key = moddedScreens.get(packet.inventoryType);
        if (!key) {
            key = SCREEN_BY_TITLE[titleKey(packet.windowTitle)];
            if (!key && lastUsed && Date.now() - lastUsed.at < 5000) {
                const block = bot.blockAt(new Vec3(lastUsed.pos.x, lastUsed.pos.y, lastUsed.pos.z));
                key = SCREEN_BY_BLOCK[block?.name];
            }
            if (!key || !vanillaScreens.has(key)) return;
            moddedScreens.set(packet.inventoryType, key);
            log(`This server's ${key.replace("minecraft:", "").replace("_", " ")} screen comes from a mod; using it like the normal one.`);
        }
        if (clickedModded && STATION_BLOCK[key]) bot.teachModdedBlock(clicked, STATION_BLOCK[key]);
        packet.inventoryType = vanillaScreens.get(key);
    });

    return { moddedType };
}

module.exports = { installModSupport };
