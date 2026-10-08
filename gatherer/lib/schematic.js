// Reads schematic files into a list of blocks: Litematica (.litematic),
// WorldEdit/Sponge (.schem, versions 1-3) and vanilla structure blocks (.nbt).
// Positions start at 0,0,0 (the lowest north-west corner); air is left out.
//
//   { name, size: {x, y, z}, blocks: [{ x, y, z, name, props }] }
//
// `rotate` turns one clockwise (seen from above) in steps of 90 degrees,
// turning facings, axes and sign rotations with it.

const fs = require("fs");
const path = require("path");
const nbt = require("prismarine-nbt");

const AIR = new Set(["air", "cave_air", "void_air", "structure_void"]);

function bare(name) {
    return String(name).replace(/^minecraft:/, "");
}

// "minecraft:oak_stairs[facing=east,half=bottom]" -> { name, props }
function parseState(text) {
    const m = /^([^[]+)(?:\[(.*)\])?$/.exec(String(text).trim());
    const props = {};
    for (const pair of (m?.[2] || "").split(",").filter(Boolean)) {
        const [k, v] = pair.split("=");
        props[k.trim()] = String(v).trim();
    }
    return { name: bare(m ? m[1] : text), props };
}

// A long from prismarine-nbt ([high, low] or BigInt) as an unsigned BigInt.
function toBig(value) {
    if (typeof value === "bigint") return BigInt.asUintN(64, value);
    if (Array.isArray(value)) return BigInt.asUintN(64, (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0));
    return BigInt.asUintN(64, BigInt(value));
}

// ---------- Litematica ----------

function readLitematic(root) {
    const regions = root.Regions || {};
    const out = [];
    for (const region of Object.values(regions)) {
        const pos = region.Position;
        const size = region.Size;
        const sx = Math.abs(size.x), sy = Math.abs(size.y), sz = Math.abs(size.z);
        // A negative size grows the region the other way from its position.
        const x0 = pos.x + (size.x < 0 ? size.x + 1 : 0);
        const y0 = pos.y + (size.y < 0 ? size.y + 1 : 0);
        const z0 = pos.z + (size.z < 0 ? size.z + 1 : 0);
        const palette = (region.BlockStatePalette || []).map((e) => ({ name: bare(e.Name), props: { ...(e.Properties || {}) } }));
        const longs = (region.BlockStates || []).map(toBig);
        const bits = BigInt(Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length)))));
        const mask = (1n << bits) - 1n;
        const total = sx * sy * sz;
        for (let i = 0; i < total; i++) {
            // Entries are packed back to back and may straddle two longs.
            const start = BigInt(i) * bits;
            const word = Number(start >> 6n);
            const offset = start & 63n;
            let value = longs[word] >> offset;
            if (offset + bits > 64n) value |= longs[word + 1] << (64n - offset);
            const entry = palette[Number(value & mask)];
            if (!entry || AIR.has(entry.name)) continue;
            const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
            out.push({ x: x0 + x, y: y0 + y, z: z0 + z, name: entry.name, props: entry.props });
        }
    }
    return out;
}

// ---------- Sponge / WorldEdit .schem ----------

function readVarints(bytes) {
    const values = [];
    let value = 0, shift = 0;
    for (const b of bytes) {
        const byte = b & 0xff;
        value |= (byte & 0x7f) << shift;
        if (byte & 0x80) {
            shift += 7;
        } else {
            values.push(value);
            value = 0;
            shift = 0;
        }
    }
    return values;
}

function readSponge(root) {
    const s = root.Schematic || root;
    const width = s.Width, height = s.Height, length = s.Length;
    const blocks = s.Blocks || s; // version 3 keeps them under "Blocks"
    const paletteMap = blocks.Palette || {};
    const data = blocks.Data || blocks.BlockData || [];
    const palette = [];
    for (const [state, id] of Object.entries(paletteMap)) palette[id] = parseState(state);
    const ids = readVarints(data);
    const out = [];
    for (let i = 0; i < ids.length && i < width * height * length; i++) {
        const entry = palette[ids[i]];
        if (!entry || AIR.has(entry.name)) continue;
        const x = i % width, z = Math.floor(i / width) % length, y = Math.floor(i / (width * length));
        out.push({ x, y, z, name: entry.name, props: entry.props });
    }
    return out;
}

// ---------- vanilla structure block .nbt ----------

function readStructure(root) {
    const palette = (root.palette || root.palettes?.[0] || []).map((e) => ({ name: bare(e.Name), props: { ...(e.Properties || {}) } }));
    const out = [];
    for (const b of root.blocks || []) {
        const entry = palette[b.state];
        if (!entry || AIR.has(entry.name)) continue;
        out.push({ x: b.pos[0], y: b.pos[1], z: b.pos[2], name: entry.name, props: entry.props });
    }
    return out;
}

// Shift so the lowest corner is 0,0,0, and measure.
function normalize(name, blocks) {
    if (!blocks.length) return { name, size: { x: 0, y: 0, z: 0 }, blocks };
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of blocks) {
        for (const k of ["x", "y", "z"]) {
            if (b[k] < min[k]) min[k] = b[k];
            if (b[k] > max[k]) max[k] = b[k];
        }
    }
    for (const b of blocks) {
        b.x -= min.x;
        b.y -= min.y;
        b.z -= min.z;
    }
    return { name, size: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 }, blocks };
}

async function loadSchematic(file) {
    const buffer = fs.readFileSync(file);
    const { parsed } = await nbt.parse(buffer);
    const root = nbt.simplify(parsed);
    const name = path.basename(file).replace(/\.[^.]+$/, "");
    let blocks;
    if (root.Regions) blocks = readLitematic(root);
    else if (root.Schematic || root.Palette || root.BlockData) blocks = readSponge(root);
    else if (root.blocks && (root.palette || root.palettes)) blocks = readStructure(root);
    else if (root.Blocks && root.Data && !root.Palette) {
        throw new Error("that's the old MCEdit .schematic format; save it as .litematic or .schem instead");
    } else {
        throw new Error("not a schematic I can read (.litematic, .schem or structure .nbt)");
    }
    return normalize(name, blocks);
}

// ---------- rotation ----------

const TURN = { north: "east", east: "south", south: "west", west: "north" };
const SIDES = ["north", "east", "south", "west"];

function rotateProps(props, turns) {
    const out = { ...props };
    for (let t = 0; t < turns; t++) {
        if (TURN[out.facing]) out.facing = TURN[out.facing];
        if (out.axis === "x") out.axis = "z";
        else if (out.axis === "z") out.axis = "x";
        if (out.rotation !== undefined) out.rotation = String((Number(out.rotation) + 4) % 16);
        // fences, walls, panes, vines: which sides it reaches to
        if (SIDES.every((s) => s in out)) {
            const [n, e, s, w] = SIDES.map((k) => out[k]);
            Object.assign(out, { north: w, east: n, south: e, west: s });
        }
    }
    return out;
}

// Clockwise (seen from above) by `turns` quarter turns.
function rotate(schem, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return schem;
    let { x: sx, z: sz } = schem.size;
    let blocks = schem.blocks;
    for (let t = 0; t < turns; t++) {
        blocks = blocks.map((b) => ({ ...b, x: sz - 1 - b.z, z: b.x }));
        [sx, sz] = [sz, sx];
    }
    blocks = blocks.map((b) => ({ ...b, props: rotateProps(b.props, turns) }));
    return { ...schem, size: { x: sx, y: schem.size.y, z: sz }, blocks };
}

const EXTENSIONS = [".litematic", ".schem", ".nbt"];

module.exports = { loadSchematic, rotate, parseState, EXTENSIONS };
