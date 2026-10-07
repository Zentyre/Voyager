#!/usr/bin/env node
// Builds Minecraft 26.3 data for minecraft-data / mineflayer, which (as of
// October 2026) stop at 26.1. Output goes to compat/26.3/ and is committed,
// so this only needs re-running to regenerate it.
//
// Sources (all public, see compat/README.md for how to fetch them):
//   MD262   minecraft-data's hand-made 26.2 data (branch pc_26_2)
//   VIA     ViaVersion source: its 26.2/26.3 ID tables are decoded here to get
//           the exact protocol order of blocks, items, entities, particles,
//           sounds, item components and command parsers
//   MCMETA  misode/mcmeta tag 26.3-summary: Mojang's generated block property
//           lists and default item components for 26.3
//
// The 26.3 protocol is the real 26.2 protocol plus every 26.2 -> 26.3 change
// in ViaVersion's Protocol26_2To26_3 (packet ids, entity movement, teleport
// confirmation, item components, particles, signs, advancements, ...).
//
//   node compat/build-26.3.js <MD262 dir> <ViaVersion repo> <mcmeta 26.3-summary dir>

const fs = require("fs");
const path = require("path");
const nbt = require("prismarine-nbt");

const [MD262, VIA, MCMETA] = process.argv.slice(2);
if (!MD262 || !VIA || !MCMETA) {
    console.error("usage: node compat/build-26.3.js <MD262 dir> <ViaVersion repo> <mcmeta 26.3-summary dir>");
    process.exit(1);
}
const OUT = path.join(__dirname, "26.3");
const VIA_DATA = path.join(VIA, "common/src/main/resources/assets/viaversion/data");
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
const write = (file, data) => fs.writeFileSync(path.join(OUT, file), JSON.stringify(data));

// ---------- ViaVersion compact identifier tables ----------

function varint(buf, pos) {
    let value = 0;
    let shift = 0;
    let b;
    do {
        b = buf[pos.i++];
        value |= (b & 0x7f) << shift;
        shift += 7;
    } while (b & 0x80);
    return value >>> 0;
}
const zigzag = (v) => (v >>> 1) ^ -(v & 1);

// Mirrors MappingDataLoader#loadMappings (strategies: 0 direct, 1 shifts, 2 changes, 3 identity).
function decodeMappings(tag) {
    const size = tag.size;
    const buf = Buffer.from(Int8Array.from(tag.val || []).buffer);
    const out = new Array(size);
    if (tag.id === 3) {
        for (let i = 0; i < size; i++) out[i] = i;
        return out;
    }
    if (tag.id === 0) {
        const pos = { i: 0 };
        let prev = 0;
        for (let i = 0; i < size; i++) out[i] = prev += zigzag(varint(buf, pos));
        return out;
    }
    const pos = { i: 0 };
    const at = [];
    const values = [];
    let prevAt = -1;
    let prevValue = 0;
    while (pos.i < buf.length) {
        prevAt = prevAt + 1 + varint(buf, pos);
        prevValue += zigzag(varint(buf, pos));
        at.push(prevAt);
        values.push(prevValue);
    }
    if (tag.id === 1) {
        for (let id = 0; id < (at.length ? at[0] : size); id++) out[id] = id;
        for (let i = 0; i < at.length; i++) {
            const to = i === at.length - 1 ? size : at[i + 1];
            let mapped = values[i];
            for (let id = at[i]; id < to; id++) out[id] = mapped++;
        }
        return out;
    }
    if (tag.id === 2) {
        const fill = tag.nofill === undefined;
        let next = 0;
        for (let i = 0; i < at.length; i++) {
            if (fill) {
                for (let id = next; id < at[i]; id++) out[id] = id;
                next = at[i] + 1;
            }
            out[at[i]] = values[i];
        }
        if (fill) for (let id = next; id < size; id++) out[id] = id;
        return out;
    }
    throw new Error(`unknown mapping strategy ${tag.id}`);
}

async function loadNbt(file) {
    return nbt.simplify((await nbt.parse(fs.readFileSync(path.join(VIA_DATA, file)))).parsed);
}

async function viaIdentifiers(version) {
    const table = await loadNbt("identifier-table.nbt");
    const data = await loadNbt(`identifiers-${version}.nbt`);
    const result = {};
    for (const [key, tag] of Object.entries(data)) {
        if (typeof tag === "object" && table[key]) result[key] = decodeMappings(tag).map((g) => table[key][g]);
    }
    return result;
}

// ---------- helpers ----------

const titleCase = (name) => name.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const strip = (key) => key.replace(/^minecraft:/, "");

// Pick an existing (26.2) block or item to copy properties from for a new one.
function templateName(name, existing) {
    const candidates = [];
    if (name.includes("poplar")) candidates.push(name.replace(/(red_|orange_|yellow_)?poplar/, "oak"));
    let m;
    if ((m = /_wool_(stairs|slab)$/.exec(name))) candidates.push(`oak_${m[1]}`);
    if ((m = /_concrete_(stairs|slab)$/.exec(name))) candidates.push(`stone_${m[1]}`);
    if (name.endsWith("_cushion")) candidates.push(name.replace("_cushion", "_carpet"));
    if (name.endsWith("_map")) candidates.push("map");
    candidates.push(
        { straw_bed: "white_bed", red_shrub: "dead_bush", shelf_mushroom: "brown_mushroom", cushion: "armor_stand" }[name]
    );
    // Same suffix as some existing block (e.g. "_stairs")
    const suffix = name.slice(name.lastIndexOf("_"));
    candidates.push(Object.keys(existing).find((n) => n.endsWith(suffix)));
    return candidates.find((c) => c && existing[c]);
}

// Hardness, tool and drops come from the base material for wool/concrete
// stairs and slabs (shape comes from the template).
function materialSource(name) {
    let m;
    if ((m = /^(.*)_wool_(stairs|slab)$/.exec(name))) return `${m[1]}_wool`;
    if ((m = /^(.*)_concrete_(stairs|slab)$/.exec(name))) return `${m[1]}_concrete`;
    return null;
}

// ---------- main ----------

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const via262 = await viaIdentifiers("26.2");
    const via263 = await viaIdentifiers("26.3");
    const props263 = read(path.join(MCMETA, "blocks"), "data.json");
    const components263 = read(path.join(MCMETA, "item_components"), "data.json");

    const blocks262 = read(MD262, "blocks.json");
    const items262 = read(MD262, "items.json");
    const entities262 = read(MD262, "entities.json");
    const byName = (list) => Object.fromEntries(list.map((e) => [e.name, e]));
    const oldBlocks = byName(blocks262);
    const oldItems = byName(items262);
    const oldEntities = byName(entities262);

    // 26.2 item id -> 26.3 item id (by name), for drops, tools, recipes, ...
    const newItemId = Object.fromEntries(via263.items.map((n, i) => [n, i]));
    const itemName262 = Object.fromEntries(items262.map((i) => [i.id, i.name]));
    const remapItem = (id) => (id == null ? id : newItemId[itemName262[id]]);
    const remapKeys = (obj) =>
        obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [remapItem(Number(k)), v]).filter(([k]) => k != null));

    // ----- blocks + collision shapes -----
    const shapes262 = read(MD262, "blockCollisionShapes.json");
    const blocks = [];
    const shapeBlocks = {};
    let nextState = 0;
    for (const [id, name] of via263.blocks.entries()) {
        const [p, def] = props263[name] || [{}, {}];
        const keys = Object.keys(p).sort(); // Mojang orders properties by name; last varies fastest
        const count = keys.reduce((n, k) => n * p[k].length, 1);
        let offset = 0;
        for (const k of keys) offset = offset * p[k].length + p[k].indexOf(def[k]);
        const states = keys.map((k) => {
            const values = p[k];
            if (values.length === 2 && values.includes("true") && values.includes("false")) {
                return { name: k, type: "bool", num_values: 2 };
            }
            const type = values.every((v) => /^\d+$/.test(v)) ? "int" : "enum";
            return { name: k, type, num_values: values.length, values };
        });

        const old = oldBlocks[name];
        const template = old || oldBlocks[templateName(name, oldBlocks)] || oldBlocks.stone;
        const material = oldBlocks[materialSource(name)] || template;
        const block = {
            ...template,
            ...(old ? {} : {
                hardness: material.hardness,
                resistance: material.resistance,
                material: material.material,
                harvestTools: material.harvestTools,
                displayName: titleCase(name),
            }),
            id,
            name,
            minStateId: nextState,
            maxStateId: nextState + count - 1,
            defaultState: nextState + offset,
            states,
        };
        if (block.harvestTools) block.harvestTools = remapKeys(block.harvestTools);
        if (old) block.drops = (old.drops || []).map(remapItem).filter((d) => d != null);
        else block.drops = newItemId[name] != null ? [newItemId[name]] : (template.drops || []).map(remapItem).filter((d) => d != null);
        if (!block.harvestTools) delete block.harvestTools;
        blocks.push(block);

        const shape = shapes262.blocks[old ? name : template.name];
        if (Array.isArray(shape)) {
            shapeBlocks[name] = shape.length === count ? shape : shape[0];
        } else {
            shapeBlocks[name] = shape ?? 1;
        }
        nextState += count;
    }
    const mappings = await loadNbt("mappings-26.2to26.3.nbt");
    if (nextState !== mappings.blockstates.mappedSize) {
        throw new Error(`26.3 block state count ${nextState} != ViaVersion's ${mappings.blockstates.mappedSize}`);
    }
    write("blocks.json", blocks);
    write("blockCollisionShapes.json", { blocks: shapeBlocks, shapes: shapes262.shapes });

    // ----- items -----
    const items = via263.items.map((name, id) => {
        if (oldItems[name]) return { ...oldItems[name], id };
        const c = components263[name] || components263[`minecraft:${name}`] || {};
        const item = { id, name, displayName: titleCase(name), stackSize: c["minecraft:max_stack_size"] ?? 64 };
        if (c["minecraft:max_damage"]) item.maxDurability = c["minecraft:max_damage"];
        return item;
    });
    write("items.json", items);

    // ----- entities -----
    const entities = via263.entities.map((name, id) => {
        const old = oldEntities[name] || oldEntities[templateName(name, oldEntities)] || oldEntities.armor_stand;
        return { ...old, id, internalId: id, name, displayName: oldEntities[name] ? old.displayName : titleCase(name) };
    });
    write("entities.json", entities);

    // ----- small tables -----
    write("particles.json", via263.particles.map((name, id) => ({ id, name })));
    write("sounds.json", via263.sounds.map((name, i) => ({ id: i + 1, name })));
    write(
        "foods.json",
        read(MD262, "foods.json").map((f) => ({ ...f, id: newItemId[f.name] })).filter((f) => f.id != null)
    );
    const materials = read(MD262, "materials.json");
    write("materials.json", Object.fromEntries(Object.entries(materials).map(([k, v]) => [k, remapKeys(v)])));

    // Recipes: { resultItemId: [ { inShape | ingredients, result: { id, count } } ] }
    const remapShape = (row) => row.map((x) => (x == null ? x : remapItem(x)));
    const recipes = {};
    for (const [resultId, list] of Object.entries(read(MD262, "recipes.json"))) {
        const newId = remapItem(Number(resultId));
        if (newId == null) continue;
        recipes[newId] = list.map((r) => {
            const out = { ...r, result: { ...r.result, id: remapItem(r.result.id) } };
            if (r.inShape) out.inShape = r.inShape.map(remapShape);
            if (r.outShape) out.outShape = r.outShape.map(remapShape);
            if (r.ingredients) out.ingredients = remapShape(r.ingredients);
            return out;
        });
    }
    write("recipes.json", recipes);

    // Name-keyed tables carry over unchanged.
    for (const file of ["blockLoot.json", "entityLoot.json", "attributes.json", "biomes.json", "tints.json"]) {
        fs.copyFileSync(path.join(MD262, file), path.join(OUT, file));
    }

    // ----- protocol -----
    write("protocol.json", buildProtocol(read(MD262, "protocol.json"), via262, via263));
    write("version.json", { version: 777, minecraftVersion: "26.3", majorVersion: "26.3", releaseType: "release" });

    console.log(
        `26.3: ${blocks.length} blocks (${nextState} states), ${items.length} items, ${entities.length} entities, ` +
            `${Object.keys(recipes).length} recipe results -> ${OUT}`
    );
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

// ---------- protocol: 26.2 + ViaVersion's 26.2 -> 26.3 changes ----------

function buildProtocol(p, via262, via263) {
    p = JSON.parse(JSON.stringify(p));
    const t = p.types;
    const play = p.play;
    const cb = play.toClient.types;
    const sb = play.toServer.types;
    // Shared types live in p.types, some play-only ones in play.toClient.types.
    const def = (name) => {
        const found = t[name] || cb[name];
        if (!found) throw new Error(`protocol type ${name} not found`);
        return found;
    };

    // Packet id tables. Each state's "packet" type holds a name mapper and a
    // switch from name to packet_<name>.
    function packetTable(dir) {
        const packet = dir.types.packet[1];
        return { mapper: packet[0].type[1].mappings, switch: packet[1].type[1].fields };
    }
    function setPacketOrder(dir, names) {
        const table = packetTable(dir);
        for (const k of Object.keys(table.mapper)) delete table.mapper[k];
        names.forEach((n, i) => {
            table.mapper["0x" + i.toString(16).padStart(2, "0")] = n;
        });
        const previous = { ...table.switch }; // keep shared definitions (e.g. packet_common_*)
        for (const k of Object.keys(table.switch)) delete table.switch[k];
        for (const n of names) table.switch[n] = previous[n] || `packet_${n}`;
    }
    const order = (dir) => {
        const m = packetTable(dir).mapper;
        return Object.keys(m).sort((a, b) => parseInt(a) - parseInt(b)).map((k) => m[k]);
    };
    const insertAfter = (list, after, name) => list.splice(list.indexOf(after) + 1, 0, name);
    const raw = ["container", [{ name: "data", type: "restBuffer" }]]; // payload we don't decode

    // -- play, clientbound: 3 new packets (ViaVersion ClientboundPackets26_3)
    const cbOrder = order(play.toClient);
    const viaCb261 = viaEnum("v1_21_11to26_1/packet/ClientboundPackets26_1.java");
    const viaCb263 = viaEnum("v26_2to26_3/packet/ClientboundPackets26_3.java");
    if (viaCb261.length !== cbOrder.length) throw new Error("clientbound packet count mismatch with ViaVersion 26.1 enum");
    const viaToMd = Object.fromEntries(viaCb261.map((v, i) => [v, cbOrder[i]]));
    const newCb = { ADD_TRANSIENT_BLOCK: "add_transient_block", POST_EFFECTS: "post_effects", SWING_ANIMATION: "swing_animation" };
    setPacketOrder(play.toClient, viaCb263.map((v) => viaToMd[v] || newCb[v]));
    cb.packet_add_transient_block = raw;
    cb.packet_post_effects = raw;
    cb.packet_swing_animation = ["container", [
        { name: "entityId", type: "varint" },
        { name: "hand", type: "varint" },
        { name: "animationType", type: "varint" },
        { name: "duration", type: "varint" },
    ]];

    // -- play, serverbound: PUNCH added; SWING and SPECTATE_ENTITY become SPECTATOR_ACTION
    const sbOrder = order(play.toServer);
    const viaSb261 = viaEnum("v1_21_11to26_1/packet/ServerboundPackets26_1.java");
    const viaSb263 = viaEnum("v26_2to26_3/packet/ServerboundPackets26_3.java");
    if (viaSb261.length !== sbOrder.length) throw new Error("serverbound packet count mismatch with ViaVersion 26.1 enum");
    const viaToMdSb = Object.fromEntries(viaSb261.map((v, i) => [v, sbOrder[i]]));
    // minecraft-data calls SPECTATE_ENTITY "spectator_action"; 26.3 keeps its format.
    const newSb = { PUNCH: "punch", SPECTATOR_ACTION: "spectator_action" };
    setPacketOrder(play.toServer, viaSb263.map((v) => newSb[v] || viaToMdSb[v]));
    sb.packet_punch = ["container", []];
    delete sb.packet_arm_animation;

    // -- configuration, clientbound: POST_EFFECTS inserted after RESOURCE_PACK_PUSH
    const cfgOrder = order(p.configuration.toClient);
    insertAfter(cfgOrder, "add_resource_pack", "post_effects");
    setPacketOrder(p.configuration.toClient, cfgOrder);
    p.configuration.toClient.types.packet_post_effects = raw;

    // -- entity movement: flags (bit 0 = on ground, bit 1 = single step) + interpolation steps
    const flagFields = [
        { name: "flags", type: "varint" },
        { name: "interpolationSteps", type: "varint" },
    ];
    cb.packet_rel_entity_move = ["container", [
        { name: "entityId", type: "varint" }, ...flagFields,
        { name: "dX", type: "i16" }, { name: "dY", type: "i16" }, { name: "dZ", type: "i16" },
    ]];
    cb.packet_entity_move_look = ["container", [
        { name: "entityId", type: "varint" }, ...flagFields,
        { name: "dX", type: "i16" }, { name: "dY", type: "i16" }, { name: "dZ", type: "i16" },
        { name: "yaw", type: "i8" }, { name: "pitch", type: "i8" },
    ]];
    cb.packet_entity_look = ["container", [
        { name: "entityId", type: "varint" }, { name: "onGround", type: "bool" },
        { name: "yaw", type: "i8" }, { name: "pitch", type: "i8" },
    ]];
    cb.packet_sync_entity_position = ["container", [
        { name: "entityId", type: "varint" },
        { name: "stepped", type: "varint" },
        { name: "steps", type: "varint" },
        { name: "x", type: "f64" }, { name: "y", type: "f64" }, { name: "z", type: "f64" },
        { name: "interpolationSteps", type: "varint" },
        { name: "yaw", type: "f32" }, { name: "pitch", type: "f32" },
    ]];

    // -- teleport confirmation now carries the position the client ended up at
    sb.packet_teleport_confirm = ["container", [
        { name: "teleportId", type: "varint" },
        { name: "x", type: "f64" }, { name: "y", type: "f64" }, { name: "z", type: "f64" },
        { name: "yaw", type: "f32" }, { name: "pitch", type: "f32" },
    ]];

    // -- game modes: varint + optional previous game mode
    const spawnInfo = def("SpawnInfo")[1];
    spawnInfo.find((f) => f.name === "gamemode").type = ["mapper", { type: "varint", mappings: { 0: "survival", 1: "creative", 2: "adventure", 3: "spectator" } }];
    spawnInfo.find((f) => f.name === "previousGamemode").type = ["option", "varint"];

    // -- particles: particle first, per-axis max speed, varint count, randomization type
    cb.packet_world_particles = ["container", [
        { name: "particle", type: "Particle" },
        { name: "longDistance", type: "bool" },
        { name: "alwaysShow", type: "bool" },
        { name: "x", type: "f64" }, { name: "y", type: "f64" }, { name: "z", type: "f64" },
        { name: "offsetX", type: "f32" }, { name: "offsetY", type: "f32" }, { name: "offsetZ", type: "f32" },
        { name: "maxSpeedX", type: "f32" }, { name: "maxSpeedY", type: "f32" }, { name: "maxSpeedZ", type: "f32" },
        { name: "amount", type: "varint" },
        { name: "randomization", type: "varint" },
    ]];
    renumberMapper(def("Particle")[1][0].type, via263.particles);

    // -- explosion: + play sound flag
    cb.packet_explosion[1].push({ name: "playSound", type: "bool" });

    // -- signs: front/back flag became a slot number (1 = front, 0 = back)
    cb.packet_open_sign_entity = ["container", [
        { name: "location", type: "position" },
        { name: "textSlot", type: "varint" },
    ]];
    sb.packet_update_sign = ["container", [
        { name: "location", type: "position" },
        { name: "text1", type: "string" }, { name: "text2", type: "string" },
        { name: "text3", type: "string" }, { name: "text4", type: "string" },
        { name: "textSlot", type: "varint" },
    ]];

    // -- advancements: x/y moved out of display data to the end of each entry
    const advValue = cb.packet_advancements[1][1].type[1].type[1][1].type[1];
    const display = advValue[1].type[1][1];
    const xy = display.filter((f) => f.name === "xCord" || f.name === "yCord");
    advValue[1].type[1][1] = display.filter((f) => !xy.includes(f));
    advValue.push(...xy);

    // -- recipes: "tag" slot display is now a holder set of items
    def("SlotDisplay")[1][1].type[1].fields.tag = "IDSet";

    // -- entity metadata: new serializer 43 = dye colour (varint)
    const metaEntry = def("entityMetadataEntry")[1];
    metaEntry[1].type[1].mappings["43"] = "dye_color";
    const metaSwitch = metaEntry[2].type[1].fields;
    metaSwitch.dye_color = "varint";

    // -- command argument parsers: list from ViaVersion; new ones have no properties
    const nodeData = JSON.stringify(def("command_node"));
    const parserMapper = findMapper(def("command_node"), "brigadier:bool");
    const parsers = via263.argumenttypes.map((n) => (n.includes(":") ? n : `minecraft:${n}`));
    renumberMapper(parserMapper, parsers);
    const parserSwitch = findSwitchWithField(def("command_node"), "brigadier:float");
    for (const n of parsers) if (!(n in parserSwitch)) parserSwitch[n] = "void";
    if (!nodeData) throw new Error("command_node missing");

    // -- item components
    buildItemComponents(def, via263.data_component_type);

    return p;

    function viaEnum(file) {
        const src = fs.readFileSync(path.join(VIA, "common/src/main/java/com/viaversion/viaversion/protocols", file), "utf8");
        return (src.match(/^\s+[A-Z_0-9]+(?:\([^)]*\))?[,;]/gm) || []).map((l) => l.trim().replace(/[,;]$/, "").replace(/\(.*/, ""));
    }
}

function renumberMapper(mapperType, names) {
    const m = mapperType[1].mappings;
    for (const k of Object.keys(m)) delete m[k];
    names.forEach((n, i) => {
        m[String(i)] = n;
    });
}

function findMapper(node, containsName) {
    let found = null;
    (function walk(n) {
        if (found || !n || typeof n !== "object") return;
        if (Array.isArray(n) && n[0] === "mapper" && Object.values(n[1].mappings).includes(containsName)) {
            found = n;
            return;
        }
        Object.values(n).forEach(walk);
    })(node);
    if (!found) throw new Error(`mapper with ${containsName} not found`);
    return found;
}

function findSwitchWithField(node, field) {
    let found = null;
    (function walk(n) {
        if (found || !n || typeof n !== "object") return;
        if (Array.isArray(n) && n[0] === "switch" && n[1].fields && field in n[1].fields) {
            found = n[1].fields;
            return;
        }
        Object.values(n).forEach(walk);
    })(node);
    if (!found) throw new Error(`switch with ${field} not found`);
    return found;
}

function buildItemComponents(def, componentNames) {
    // Order of component types = data_component_type registry order (ids).
    renumberMapper(def("SlotComponentType"), componentNames);
    const fields = findSwitchWithField(def("SlotComponent"), "custom_data");

    const resolvableInt = ["container", [
        { name: "isValue", type: "bool" },
        { name: "value", type: ["switch", { compareTo: "isValue", fields: { true: "i32", false: "string" } }] },
    ]];
    const resolvableFloat = ["container", [
        { name: "isValue", type: "bool" },
        { name: "value", type: ["switch", { compareTo: "isValue", fields: { true: "f32", false: "string" } }] },
    ]];
    const swingAnimation = ["container", [
        { name: "type", type: ["mapper", { type: "varint", mappings: { 0: "none", 1: "whack", 2: "stab" } }] },
        { name: "duration", type: "varint" },
    ]];
    const signText = ["container", [
        { name: "messages", type: ["array", { count: 4, type: "anonymousNbt" }] },
        { name: "filteredMessages", type: ["option", ["array", { count: 4, type: "anonymousNbt" }]] },
        { name: "color", type: "varint" },
        { name: "hasGlowingText", type: "bool" },
    ]];

    // Removed in 26.3
    delete fields.swing_animation;
    delete fields.map_color;

    // New in 26.3
    Object.assign(fields, {
        attack_animation: swingAnimation,
        interact_animation: swingAnimation,
        block_transformer: "varint",
        villager_food: "varint",
        compostable: resolvableInt,
        cooking_fuel: ["container", [{ name: "burnTime", type: resolvableInt }, { name: "speedMultiplier", type: resolvableFloat }]],
        brewing_fuel: ["container", [{ name: "uses", type: resolvableInt }, { name: "speedMultiplier", type: resolvableFloat }]],
        mob_visibility: ["container", [{ name: "targetingEntityTypes", type: "IDSet" }, { name: "visibility", type: "f32" }]],
        provides_pottery_pattern: "varint",
        sign_text_front: signText,
        sign_text_back: signText,
        waxed: "void",
        "cushion/color": "varint",
    });

    // Changed in 26.3
    const trimMaterial = def("ArmorTrimMaterial");
    trimMaterial.splice(0, trimMaterial.length, "container", [
        { name: "paletteId", type: "string" },
        { name: "description", type: "anonymousNbt" },
    ]);
    const instrument = def("InstrumentData")[1];
    instrument.splice(instrument.findIndex((f) => f.name === "range") + 1, 0, { name: "durabilityDamage", type: "varint" });
    const effects = findSwitchWithField(def("ItemConsumeEffect"), "teleport_randomly");
    effects.teleport_randomly = ["container", [
        { name: "diameter", type: "f32" },
        { name: "directionalParticles", type: "bool" },
    ]];
    const optionalTemplate = ["option", "ItemStackTemplate"];
    fields.pot_decorations = ["container", [
        { name: "back", type: optionalTemplate },
        { name: "left", type: optionalTemplate },
        { name: "right", type: optionalTemplate },
        { name: "front", type: optionalTemplate },
    ]];

    for (const name of componentNames) {
        if (!(name in fields)) throw new Error(`no definition for item component ${name}`);
    }
}
