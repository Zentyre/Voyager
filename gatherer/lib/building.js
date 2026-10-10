// Building schematics (the "builder" profile). Reads a schematic from the
// schematics folder, works out what goes where and what it needs, takes the
// materials from chests first and gathers or crafts the rest, then places
// block by block from the bottom up, each one facing the way the schematic
// says.
//
// Facing: the game decides how a placed block faces from where the player
// looks and which face (and spot on it) they click. Stairs face the way you
// look, furnaces and chests face you, logs lie along the face you click,
// slabs go top or bottom by the half you click, torches and signs go on the
// wall you look at. So for each block the bot looks the right way first, then
// clicks the right spot (see waysToPlace).

const fs = require("fs");
const path = require("path");
const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { loadSchematic, rotate, EXTENSIONS } = require("./schematic");

const DIR = path.join(__dirname, "..", "schematics");
const DIRS = {
    north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0),
    west: new Vec3(-1, 0, 0), up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0),
};
const OPP = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
const CCW = { north: "west", west: "south", south: "east", east: "north" };
const SIDES = ["north", "south", "east", "west"];
const ALL_FACES = ["up", ...SIDES, "down"];

// Things that can't (or needn't) be placed from an item.
const UNPLACEABLE = /^(water|lava|bubble_column|fire|soul_fire|nether_portal|end_portal|end_gateway|piston_head|moving_piston|frosted_ice|light|barrier|structure_block|jigsaw|(chain_|repeating_)?command_block|spawner|trial_spawner|vault|budding_amethyst|reinforced_deepslate|bedrock|end_portal_frame|farmland|dirt_path|powder_snow)$/;
// Blocks whose item has another name.
const ITEM_OF = {
    wall_torch: "torch", soul_wall_torch: "soul_torch", redstone_wall_torch: "redstone_torch", copper_wall_torch: "copper_torch",
    redstone_wire: "redstone", tripwire: "string", wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato",
    beetroots: "beetroot_seeds", melon_stem: "melon_seeds", pumpkin_stem: "pumpkin_seeds", attached_melon_stem: "melon_seeds",
    attached_pumpkin_stem: "pumpkin_seeds", cocoa: "cocoa_beans", sweet_berry_bush: "sweet_berries", bamboo_sapling: "bamboo",
    kelp_plant: "kelp", cave_vines: "glow_berries", cave_vines_plant: "glow_berries", big_dripleaf_stem: "big_dripleaf",
    twisting_vines_plant: "twisting_vines", weeping_vines_plant: "weeping_vines", torchflower_crop: "torchflower_seeds", pitcher_crop: "pitcher_pod",
};
// The game puts these in the spot when you place into it (grass, water...).
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|tall_seagrass|fire|soul_fire|structure_void|light|bush|short_dry_grass|tall_dry_grass|leaf_litter)$/;
// Placed around/after the solid blocks of their layer (they hang on them).
const ATTACHED = /torch|button|lever|sign|banner|ladder|carpet|pressure_plate|rail|_door$|_bed$|lantern|flower_pot|potted_|vine|lichen|_head$|_skull$|tripwire|redstone_wire|repeater|comparator|_sapling$|^(short_grass|fern|dandelion|poppy|.*_tulip|wheat|carrots|potatoes|beetroots)$|_coral|candle|chain$|bell$|cocoa|scaffolding/;
// Properties that say how a block sits; the rest (connections, lit, open,
// waterlogged...) the game works out or doesn't matter for building.
const ORIENTATION = ["facing", "axis", "half", "rotation", "face", "hanging", "attachment"];

// Item to place for a block, or null with why not.
function itemFor(name, props, registry) {
    if (UNPLACEABLE.test(name)) return { item: null, why: `${name.replace(/_/g, " ")} can't be placed` };
    if (props.half === "upper" && (/_door$/.test(name) || /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|tall_seagrass|small_dripleaf)$/.test(name))) return { item: null, part: true };
    if (props.part === "head" && /_bed$/.test(name)) return { item: null, part: true };
    let item = ITEM_OF[name];
    if (!item) {
        const m =
            /^(.+)_wall_sign$/.exec(name) ? `${/^(.+)_wall_sign$/.exec(name)[1]}_sign`
            : /^(.+)_wall_hanging_sign$/.exec(name) ? `${/^(.+)_wall_hanging_sign$/.exec(name)[1]}_hanging_sign`
            : /^(.+)_wall_banner$/.exec(name) ? `${/^(.+)_wall_banner$/.exec(name)[1]}_banner`
            : /^(.+)_wall_(head|skull)$/.exec(name) ? name.replace("_wall_", "_")
            : /^(.+_coral)_wall_fan$/.exec(name) ? `${/^(.+_coral)_wall_fan$/.exec(name)[1]}_fan`
            : /^potted_/.test(name) ? "flower_pot"
            : name;
        item = m;
    }
    if (!registry.itemsByName[item]) return { item: null, why: `no item for ${name.replace(/_/g, " ")}` };
    const count = /_slab$/.test(name) && props.type === "double" ? 2 : 1;
    return { item, count };
}

// The ways to place `want`: which face of a neighbour to click (named by the
// direction from that neighbour to the new block: "up" = on top of the block
// below), where on it (low/high half for slabs, stairs, trapdoors), and which
// way to look. In vanilla's terms: stairs, doors, beds and fence gates take
// the player's facing; chests, furnaces and most others face the player;
// pistons, barrels and dispensers face the player in 3D (observers away);
// logs take the clicked face's axis; wall torches, signs and ladders the wall
// looked at; standing signs and banners the exact yaw.
function waysToPlace(want) {
    const { name, props } = want;
    const F = props.facing;
    const way = (face, extra = {}) => ({ face, cursor: "mid", ...extra });
    const lowHigh = (top, extra = {}) =>
        top ? [way("down", extra), ...SIDES.map((s) => way(s, { cursor: "high", ...extra }))]
            : [way("up", extra), ...SIDES.map((s) => way(s, { cursor: "low", ...extra }))];
    if (/_slab$/.test(name)) return lowHigh(props.type === "top");
    if (/_stairs$/.test(name)) return lowHigh(props.half === "top", { look: F });
    if (/trapdoor$/.test(name) && F) {
        const top = props.half === "top";
        return [way(F, { cursor: top ? "high" : "low" }), way(top ? "down" : "up", { look: OPP[F] })];
    }
    if (props.axis && !F) {
        const faces = { x: ["east", "west"], y: ["up", "down"], z: ["north", "south"] }[props.axis] || ALL_FACES;
        return faces.map((f) => way(f));
    }
    if (/_bed$|_door$/.test(name) && F) return [way("up", { look: F })];
    if (/fence_gate$|^(campfire|soul_campfire)$/.test(name) && F) return ALL_FACES.map((f) => way(f, { look: F }));
    if (/anvil$/.test(name) && F) return ALL_FACES.map((f) => way(f, { look: CCW[F] }));
    if (/^(repeater|comparator)$/.test(name) && F) return [way("up", { look: OPP[F] })];
    if (/^(piston|sticky_piston|dispenser|dropper|barrel|crafter)$/.test(name) && F) return ALL_FACES.map((f) => way(f, { look3: OPP[F] }));
    if (name === "observer" && F) return ALL_FACES.map((f) => way(f, { look3: F }));
    if (/^(end_rod|lightning_rod|(.+_)?shulker_box|amethyst_cluster|.+_amethyst_bud)$/.test(name) && F) return [way(F)];
    if (name === "hopper" && F) return F === "down" ? [way("up"), way("down")] : [way(OPP[F])];
    if (/wall_torch$|_wall_sign$|_wall_hanging_sign$|_wall_banner$|_wall_(head|skull)$|_wall_fan$|^(ladder|tripwire_hook)$/.test(name) && F) {
        return [way(F, { look: OPP[F] })]; // on the block behind it, looking at that wall
    }
    if (props.face && F) {
        if (props.face === "floor") return [way("up", { look: F, pitch: "down" })];
        if (props.face === "ceiling") return [way("down", { look: F, pitch: "up" })];
        return [way(F, { look: OPP[F] })];
    }
    if (/lantern$/.test(name)) return props.hanging === "true" ? [way("down", { pitch: "up" })] : [way("up", { pitch: "down" })];
    if (props.rotation !== undefined) return [way("up", { segment: Number(props.rotation), pitch: "down" })];
    if (/torch$|_sign$|_banner$|_head$|_skull$/.test(name)) return [way("up", { pitch: "down" })];
    if (F && SIDES.includes(F)) return ALL_FACES.map((f) => way(f, { look: OPP[F] })); // faces the player
    return ALL_FACES.map((f) => way(f));
}

// Within reach of a block (3 blocks of it), but not standing where it goes.
class GoalReach extends goals.GoalNear {
    constructor(pos) {
        super(pos.x, pos.y, pos.z, 3);
    }
    isEnd(node) {
        const d2 = (this.x - node.x) ** 2 + (this.y - node.y) ** 2 + (this.z - node.z) ** 2;
        return d2 <= this.rangeSq && d2 > 1;
    }
}

// mineflayer's yaw for looking along a horizontal direction.
function yawOf(dir) {
    const d = DIRS[dir];
    return Math.atan2(-d.x, -d.z);
}

function matches(block, want) {
    if (!block || block.name !== want.name) return false;
    const have = block.getProperties();
    for (const key of ORIENTATION) {
        if (want.props[key] === undefined || have[key] === undefined) continue;
        if (String(have[key]) !== String(want.props[key])) return false;
    }
    if (/_slab$/.test(want.name) && want.props.type && have.type !== want.props.type) return false;
    return true;
}

function listSchematics() {
    try {
        return fs.readdirSync(DIR).filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase())).sort();
    } catch (err) {
        return [];
    }
}

// "house" -> "house.litematic" (exact name first, then without extension, then a unique start).
function findSchematic(name) {
    const files = listSchematics();
    const lower = String(name).toLowerCase();
    return (
        files.find((f) => f.toLowerCase() === lower) ||
        files.find((f) => f.toLowerCase().replace(/\.[^.]+$/, "") === lower) ||
        (files.filter((f) => f.toLowerCase().startsWith(lower)).length === 1 ? files.find((f) => f.toLowerCase().startsWith(lower)) : null)
    );
}

function installBuilding(ctx) {
    const { bot, config, kb } = ctx;
    const registry = bot.registry;
    const settings = () => ({ chests: [], chestRadius: 24, maxChests: 16, clear: false, ...(config.build || {}) });
    const jobFile = path.resolve(__dirname, "..", "memory", `${config.username}.build.json`);

    let job = null; // the build in progress (or the last one)
    const chests = new Map(); // "x,y,z" -> { pos, items: {name: count}, double }

    // ---------- the job ----------

    async function prepare({ file, origin, turns = 0, clear = false }) {
        const found = findSchematic(file);
        if (!found) {
            const files = listSchematics();
            throw new Error(`no schematic "${file}" in the schematics folder${files.length ? ` (there: ${files.join(", ")})` : ""}`);
        }
        const schem = rotate(await loadSchematic(path.join(DIR, found)), turns);
        const targets = [];
        const skipped = {};
        for (const b of schem.blocks) {
            const { item, count, why, part } = itemFor(b.name, b.props, registry);
            if (part) continue; // the other half of a door or bed comes with the first
            if (!item) {
                skipped[why] = (skipped[why] || 0) + 1;
                continue;
            }
            targets.push({
                pos: origin.offset(b.x, b.y, b.z),
                want: { name: b.name, props: b.props },
                item,
                count,
                attached: ATTACHED.test(b.name) || registry.blocksByName[b.name]?.boundingBox !== "block",
                tries: 0,
                state: "todo", // todo | done | blocked | missing | failed
            });
        }
        // Bottom up; solid blocks before what hangs on them; row by row.
        targets.sort((a, b) =>
            a.pos.y - b.pos.y || a.attached - b.attached || a.pos.x - b.pos.x || (a.pos.x % 2 ? b.pos.z - a.pos.z : a.pos.z - b.pos.z)
        );
        const box = { min: origin.clone(), max: origin.offset(schem.size.x - 1, schem.size.y - 1, schem.size.z - 1) };
        const spots = new Set(targets.map((t) => `${t.pos.x},${t.pos.y},${t.pos.z}`));
        return { file: found, name: schem.name, origin, turns, clear, size: schem.size, box, targets, spots, skipped, misfaced: 0, done: 0, unobtainable: new Set(), startedAt: Date.now() };
    }

    const inBox = (pos, box, pad = 0) =>
        pos.x >= box.min.x - pad && pos.x <= box.max.x + pad && pos.y >= box.min.y - pad && pos.y <= box.max.y + pad && pos.z >= box.min.z - pad && pos.z <= box.max.z + pad;

    function saveJob() {
        if (!job) return;
        try {
            fs.mkdirSync(path.dirname(jobFile), { recursive: true });
            const { file, origin, turns, clear } = job;
            fs.writeFileSync(jobFile, JSON.stringify({ file, origin: { x: origin.x, y: origin.y, z: origin.z }, turns, clear }));
        } catch (err) {
            // not important
        }
    }
    function lastJob() {
        try {
            const j = JSON.parse(fs.readFileSync(jobFile, "utf8"));
            return { ...j, origin: new Vec3(j.origin.x, j.origin.y, j.origin.z) };
        } catch (err) {
            return null;
        }
    }

    // Items still to place, by item: { item: count }.
    function stillNeeded(targets = job?.targets || []) {
        const need = {};
        for (const t of targets) if (t.state === "todo") need[t.item] = (need[t.item] || 0) + t.count;
        return need;
    }

    // ---------- chests ----------

    const CONTAINERS = ["chest", "trapped_chest", "barrel"];
    function knownChestSpots(box) {
        const s = settings();
        const ids = CONTAINERS.map((n) => registry.blocksByName[n]?.id).filter((id) => id !== undefined);
        const centers = [box ? box.min.plus(box.max).scaled(0.5) : null, ctx.home].filter(Boolean);
        const spots = new Map();
        const add = (p) => spots.set(`${p.x},${p.y},${p.z}`, new Vec3(p.x, p.y, p.z));
        for (const c of [...(s.chests || []), config.chest].filter(Boolean)) add(c);
        for (const center of centers) {
            for (const p of bot.findBlocks({ matching: ids, point: center, maxDistance: s.chestRadius, count: 64 })) {
                if (!box || !inBox(p, box)) add(p); // not the build's own chests
            }
        }
        const me = bot.entity.position;
        return [...spots.values()].sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, s.maxChests);
    }

    async function openChestAt(pos) {
        const block = bot.blockAt(pos);
        if (!block || !CONTAINERS.includes(block.name)) return null;
        await ctx.act(() => ctx.goTo(pos, 2, `the ${block.name.replace(/_/g, " ")} at ${ctx.fmt(pos)}`));
        return bot.openContainer(bot.blockAt(pos));
    }

    function chestContents(window) {
        const items = {};
        for (const i of window.containerItems()) items[i.name] = (items[i.name] || 0) + i.count;
        return items;
    }

    // Look in every chest nearby once, so the bot knows where things are.
    async function indexChests(box) {
        const covered = new Set();
        for (const pos of knownChestSpots(box)) {
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (covered.has(key) || chests.has(key)) continue;
            ctx.checkStop();
            ctx.doing(`Checking what's in the chest at ${ctx.fmt(pos)}`);
            let window = null;
            try {
                window = await openChestAt(pos);
                if (!window) continue;
                const double = window.inventoryStart >= 54;
                chests.set(key, { pos, items: chestContents(window) });
                // the other half of a double chest is the same chest
                if (double) for (const s of SIDES) covered.add(`${pos.x + DIRS[s].x},${pos.y},${pos.z + DIRS[s].z}`);
            } catch (err) {
                if (err instanceof ctx.Stopped) throw err;
                ctx.log(`Couldn't look in the chest at ${ctx.fmt(pos)}: ${err.message}`);
            } finally {
                try {
                    window?.close();
                } catch (err) {}
            }
        }
    }

    function inChests(item) {
        let n = 0;
        for (const c of chests.values()) n += c.items[item] || 0;
        return n;
    }

    // Take up to `amount` of `item` from the chests that have it, nearest first.
    async function takeFromChests(item, amount) {
        const id = registry.itemsByName[item].id;
        let got = 0;
        const me = bot.entity.position;
        const have = [...chests.values()].filter((c) => c.items[item] > 0).sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
        for (const c of have) {
            if (got >= amount) break;
            if (bot.inventory.emptySlotCount() === 0) break;
            ctx.checkStop();
            ctx.doing(`Taking ${ctx.pretty(item)} from the chest at ${ctx.fmt(c.pos)}`);
            let window = null;
            try {
                window = await openChestAt(c.pos);
                if (!window) {
                    chests.delete(`${c.pos.x},${c.pos.y},${c.pos.z}`);
                    continue;
                }
                c.items = chestContents(window);
                const n = Math.min(amount - got, c.items[item] || 0, roomFor(item));
                if (n > 0) {
                    await window.withdraw(id, null, n);
                    got += n;
                }
                c.items = chestContents(window);
            } catch (err) {
                if (err instanceof ctx.Stopped) throw err;
                ctx.log(`Couldn't take ${item} from the chest at ${ctx.fmt(c.pos)}: ${err.message}`);
            } finally {
                try {
                    window?.close();
                } catch (err) {}
            }
        }
        if (got) ctx.log(`Took ${got} ${item} from chests.`);
        return got;
    }

    function roomFor(item) {
        const stack = registry.itemsByName[item]?.stackSize || 64;
        const partial = bot.inventory.items().filter((i) => i.name === item).reduce((n, i) => n + (stack - i.count), 0);
        return bot.inventory.emptySlotCount() * stack + partial;
    }

    // Make room: put what the build doesn't need (and isn't gear or food) in a chest.
    const GEAR = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(bow|crossbow|trident|shield|totem_of_undying|elytra|arrow|spectral_arrow|tipped_arrow|bucket|water_bucket|torch|flint_and_steel)$/;
    async function makeRoom() {
        if (bot.inventory.emptySlotCount() >= 4) return;
        const need = stillNeeded();
        const extra = bot.inventory.items().filter((i) => !need[i.name] && !GEAR.test(i.name) && !kb.isFood(i.name) && !TOWER.includes(i.name));
        if (!extra.length) return;
        const target = config.chest ? new Vec3(config.chest.x, config.chest.y, config.chest.z) : [...chests.values()][0]?.pos;
        if (!target) return;
        ctx.doing("Putting spare items in a chest to make room");
        let window = null;
        try {
            window = await openChestAt(target);
            if (!window) return;
            for (const i of extra) {
                try {
                    await window.deposit(i.type, null, i.count);
                } catch (err) {
                    break; // full
                }
            }
            const c = chests.get(`${target.x},${target.y},${target.z}`);
            if (c) c.items = chestContents(window);
        } finally {
            try {
                window?.close();
            } catch (err) {}
        }
    }

    // Get the items for the next stretch of the build into the inventory:
    // chests first, then gather or craft what's still short of `item`.
    async function restock(item, upcoming) {
        await makeRoom();
        const want = stillNeeded(upcoming);
        for (const [name, count] of Object.entries(want)) {
            const short = count - ctx.countItem(name);
            if (short > 0 && inChests(name) > 0) await takeFromChests(name, short);
        }
        const short = Math.min(want[item] || 1, 64 * 4) - ctx.countItem(item);
        if (short > 0 && !job.unobtainable.has(item)) {
            ctx.log(`Getting ${short} ${item} for the build.`);
            ctx.doing(`Gathering ${short} ${ctx.pretty(item)} for the build`);
            try {
                await ctx.obtain(item, ctx.countItem(item) + short);
            } catch (err) {
                if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                job.unobtainable.add(item); // don't go round trying again for every block
                throw err;
            }
        }
    }

    // ---------- moving and placing ----------

    const reachOf = (pos) => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
    const passable = (b) => b && (b.boundingBox === "empty" || REPLACEABLE.test(b.name)) && !/^(water|lava)$/.test(b.name);

    // Somewhere within reach of `pos`, but not in its way. Too high to reach
    // from anywhere to stand: up a tower next to it.
    async function getNear(pos) {
        const feet = bot.entity.position.floored();
        const inTheWay = feet.x === pos.x && feet.z === pos.z && pos.y - feet.y >= -1 && pos.y - feet.y <= 1;
        if (reachOf(pos) <= 4.2 && !inTheWay) return;
        if (job.tower) await towerDown();
        // Once no way up was found at some height, higher blocks go straight to a tower.
        if (pos.y >= job.towerFrom || !placeToStand(pos)) return towerUp(pos);
        try {
            // from far off (down a mine, say) it can take a while
            await ctx.withTimeout(bot.pathfinder.goto(new GoalReach(pos)), 30000 + 3000 * reachOf(pos));
        } catch (err) {
            // Ground to stand on up there (the top of a wall), but no way onto it.
            if (err instanceof ctx.Stopped || !/decide path|no path|timed out/i.test(err.message) || pos.y <= bot.entity.position.y + 2) throw err;
            job.towerFrom = Math.min(job.towerFrom, pos.y);
            return towerUp(pos);
        }
    }

    // Is there ground within a few blocks of `pos` to stand on and reach it from?
    function placeToStand(pos) {
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                for (let y = pos.y + 2; y >= pos.y - 5; y--) {
                    const ground = bot.blockAt(new Vec3(pos.x + dx, y - 1, pos.z + dz));
                    if (!ground) continue;
                    if (ground.boundingBox !== "block") continue;
                    const at = new Vec3(pos.x + dx, y, pos.z + dz);
                    if (!passable(bot.blockAt(at)) || !passable(bot.blockAt(at.offset(0, 1, 0)))) continue;
                    if (at.equals(pos) || at.offset(0, 1, 0).equals(pos)) continue;
                    if (at.offset(0.5, 1.62, 0.5).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.2) return true;
                    break; // the highest ground in this column is too low
                }
            }
        }
        return false;
    }

    // ---------- towers, to reach high blocks ----------
    // Scaffolding is best: one hit breaks it and it comes back as items. Dirt
    // and cobblestone do too. A tower never goes where the build has a block.
    const TOWER = ["scaffolding", "dirt", "cobblestone", "cobbled_deepslate", "netherrack"];
    const towerItems = () => TOWER.reduce((n, name) => n + ctx.countItem(name), 0);

    async function towerUp(pos) {
        // a column next to it (not where the build goes), lowest tower first
        const options = [];
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (!dx && !dz) continue;
                const x = pos.x + dx, z = pos.z + dz;
                const stand = pos.y - 1; // feet there: the block is level with the head
                let ground = null;
                for (let y = stand - 1; y > stand - 30; y--) {
                    const b = bot.blockAt(new Vec3(x, y, z));
                    if (!b) break;
                    if (b.boundingBox === "block") {
                        ground = y;
                        break;
                    }
                }
                if (ground === null) continue;
                let ok = true;
                for (let y = ground + 1; y <= stand + 1 && ok; y++) {
                    const p = new Vec3(x, y, z);
                    if (job.spots.has(`${x},${y},${z}`) || !passable(bot.blockAt(p))) ok = false;
                }
                if (ok) options.push({ x, z, ground, height: stand - ground - 1, inside: inBox(new Vec3(x, stand, z), job.box) });
            }
        }
        options.sort((a, b) => a.height - b.height || a.inside - b.inside);
        const spot = options[0];
        if (!spot) throw new Error("nowhere next to it to put up a tower");
        if (spot.height > 24) throw new Error("too high to build a tower to");
        if (towerItems() < spot.height) await getTowerBlocks(spot.height);
        ctx.doing(`Walking to the foot of a tower at ${spot.x} ${spot.ground + 1} ${spot.z}`);
        await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.ground + 1, spot.z)), 40000);
        job.tower = { x: spot.x, z: spot.z, blocks: [] };
        ctx.doing(`Building a tower up to ${ctx.fmt(pos)}`);
        for (let i = 0; i < spot.height; i++) {
            ctx.checkStop();
            const feet = bot.entity.position.floored();
            await ctx.pillarStep(feet, TOWER);
            job.tower.blocks.push(feet);
        }
    }

    // Down the tower, breaking it under us; then pick the blocks up again.
    async function towerDown() {
        const tower = job.tower;
        job.tower = null;
        if (!tower?.blocks.length) return;
        ctx.doing("Climbing down the tower");
        await ctx.climbDown(tower.blocks.slice()).catch(() => {});
        // Scaffolding left standing (knocked off it, say): breaking the bottom brings it all down.
        const bottom = tower.blocks[0] && bot.blockAt(tower.blocks[0]);
        if (bottom?.name === "scaffolding") await ctx.safely(() => dig(bottom));
        await ctx.safely(() => ctx.pickUpDrops(null, 6));
    }

    async function getTowerBlocks(count) {
        for (const name of TOWER) {
            if (towerItems() >= count) return;
            if (inChests(name) > 0) await takeFromChests(name, count - towerItems());
        }
        if (towerItems() < count) {
            ctx.doing(`Getting ${count - towerItems()} dirt for a tower`);
            await ctx.obtain("dirt", ctx.countItem("dirt") + count - towerItems());
        }
    }

    // A block to click on, next to `pos` on side `face`.
    function clickable(pos, face) {
        const ref = bot.blockAt(pos.minus(DIRS[face]));
        if (!ref || ref.boundingBox !== "block" || REPLACEABLE.test(ref.name)) return null;
        return ref;
    }

    function cursorFor(face, where) {
        const d = DIRS[face];
        // the clicked face of the neighbour is the one towards the new block
        const c = new Vec3(0.5 + d.x * 0.5, 0.5 + d.y * 0.5, 0.5 + d.z * 0.5);
        if (d.y === 0) c.y = where === "low" ? 0.25 : where === "high" ? 0.75 : 0.5;
        return c;
    }

    function airCursor(way) {
        const c = cursorFor(way.face, way.cursor);
        // keep the point just inside the block (the server checks it's on it)
        c.y = Math.min(0.99, Math.max(0.01, c.y));
        return c;
    }

    async function lookFor(way) {
        let yaw = bot.entity.yaw;
        let pitch = 0;
        if (way.look) yaw = yawOf(way.look);
        if (way.segment !== undefined) yaw = Math.PI - ((way.segment * 22.5 - 180) * Math.PI) / 180;
        if (way.look3) {
            if (way.look3 === "up") pitch = Math.PI / 2;
            else if (way.look3 === "down") pitch = -Math.PI / 2;
            else yaw = yawOf(way.look3);
        }
        if (way.pitch === "down") pitch = -Math.PI / 2;
        if (way.pitch === "up") pitch = Math.PI / 2;
        if (!way.look && way.look3 === undefined && way.segment === undefined && !way.pitch) return;
        await bot.look(yaw, pitch, true);
        await bot.waitForTicks(1); // the server takes the facing from the last look it saw
    }

    async function clickPlace(ref, way) {
        bot.setControlState("sneak", true); // so clicking a chest or table never opens it
        try {
            // In mid-air the spot itself is clicked: the point is on that block, so
            // a face's high/low half reads the same and up/down sit inside it.
            const delta = way.air ? airCursor(way) : cursorFor(way.face, way.cursor);
            await bot._genericPlace(ref, DIRS[way.face], { forceLook: "ignore", delta, swingArm: "right" });
        } finally {
            bot.setControlState("sneak", false);
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
        }
    }

    async function waitForBlock(pos, isDone, ticks = 15) {
        for (let i = 0; i < ticks; i++) {
            if (isDone(bot.blockAt(pos))) return true;
            await bot.waitForTicks(1);
        }
        return isDone(bot.blockAt(pos));
    }

    async function equip(item) {
        const held = bot.inventory.items().find((i) => i.name === item);
        if (!held) return false;
        if (bot.heldItem?.name !== item) await bot.equip(held, "hand");
        return true;
    }

    // Things in the way that can just go: plants, snow, leaves, and natural
    // ground (dirt, stone, sand...). Anything else only with "clear".
    function clearable(block, clear) {
        if (!block || block.name === "air") return true;
        if (clear) return true;
        return block.hardness === 0 || /leaves$/.test(block.name) || kb.isMineable(block.name) ||
            /^(dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|stone|deepslate|granite|diorite|andesite|tuff|gravel|sand|red_sand|clay|netherrack|snow_block|ice|packed_ice|mud)$/.test(block.name);
    }

    async function dig(block) {
        await getNear(block.position);
        await bot.tool.equipForBlock(block, {}).catch(() => {});
        await bot.dig(block, true);
    }

    // Place one target. Returns "done", "later" (nothing to place against yet)
    // or "blocked" (something that isn't ours to remove is there).
    async function placeOne(t) {
        let block = bot.blockAt(t.pos);
        if (!block) {
            await getNear(t.pos);
            block = bot.blockAt(t.pos);
            if (!block) return "later";
        }
        if (matches(block, t.want)) return "done";
        const intoSlab = t.want.props.type === "double" && block.name === t.want.name;
        if (!intoSlab && block.name !== t.want.name && !REPLACEABLE.test(block.name)) {
            if (!clearable(block, job.clear)) return "blocked";
            ctx.doing(`Clearing the ${ctx.pretty(block.name)} at ${ctx.fmt(t.pos)}`);
            await dig(block);
            block = bot.blockAt(t.pos);
        } else if (block.name === t.want.name && !intoSlab) {
            // the right block facing the wrong way: take it out and place again
            if (t.tries >= 2) {
                job.misfaced++;
                return "done";
            }
            await dig(block);
        }

        if (!(await equip(t.item))) return "missing";
        // Second half of a double slab: click the slab that's there.
        const ways = intoSlab
            ? [{ face: block.getProperties().type === "top" ? "down" : "up", cursor: "mid", self: true }]
            : waysToPlace(t.want);
        const refFor = (w) => (w.self ? bot.blockAt(t.pos) : clickable(t.pos, w.face));
        const way = ways.find(refFor);
        if (!way) return airPlace(t, ways);

        ctx.doing(`Placing ${ctx.pretty(t.want.name)} at ${ctx.fmt(t.pos)} (${job.done}/${job.targets.length})`);
        await getNear(t.pos);
        const ref = refFor(way);
        if (!ref || !(await equip(t.item))) return "later";
        await lookFor(way);
        t.tries++;
        await clickPlace(ref, way);
        if (!(await waitForBlock(t.pos, (b) => b && b.name === t.want.name))) return t.tries >= 3 ? "failed" : "later";
        const now = bot.blockAt(t.pos);
        if (matches(now, t.want)) return "done";
        if (t.want.props.type === "double") return "later"; // the second slab next
        if (t.tries >= 2) {
            job.misfaced++;
            return "done";
        }
        return "later"; // facing the wrong way: the next pass takes it out and tries again
    }

    // Nothing next to it to place against (the edge of a roof, say): click
    // the empty spot itself. The game takes air as replaceable and puts the
    // block right there, facing and halves as for a normal click (the same
    // face and point on it), so no pillar is needed underneath. A server that
    // won't have it (an anti-cheat plugin) gets the old way after three
    // refusals: a pillar under it (scaffoldUnder).
    async function airPlace(t, ways) {
        if (job.airRefused >= 3) return "later";
        const solid = (b) => b && b.boundingBox === "block";
        ctx.doing(`Placing ${ctx.pretty(t.want.name)} in mid-air at ${ctx.fmt(t.pos)} (${job.done}/${job.targets.length})`);
        await getNear(t.pos);
        const spot = bot.blockAt(t.pos);
        if (!spot || !(REPLACEABLE.test(spot.name) || spot.boundingBox === "empty") || !(await equip(t.item))) return "later";
        const way = ways[0];
        await lookFor(way);
        t.tries++;
        await clickPlace(spot, { ...way, air: true });
        if (!(await waitForBlock(t.pos, (b) => b && b.name === t.want.name))) {
            // only full blocks count against the server (a torch in mid-air fails anyway)
            if (solid({ boundingBox: bot.registry.blocksByName[t.want.name]?.boundingBox })) {
                t.tries--; // the server's no, not this block's fault: it gets its tries with a pillar
                if (++job.airRefused === 3) ctx.log("The server won't let me place blocks in mid-air; putting a pillar under them instead.");
                return "later";
            }
            return t.tries >= 3 ? "failed" : "later";
        }
        job.airRefused = 0;
        if (matches(bot.blockAt(t.pos), t.want)) return "done";
        if (t.tries >= 2) {
            job.misfaced++;
            return "done";
        }
        return "later";
    }

    // A block with nothing next to it to place against, on a server that
    // won't take mid-air placing: put a temporary pillar of dirt (or
    // cobblestone) under it, taken away afterwards.
    async function scaffoldUnder(t) {
        const filler = TOWER.find((n) => ctx.countItem(n) > 0);
        if (!filler) return false;
        const column = [];
        for (let y = t.pos.y - 1; y > t.pos.y - 8; y--) {
            const p = new Vec3(t.pos.x, y, t.pos.z);
            const b = bot.blockAt(p);
            if (!b) return false;
            if (b.boundingBox === "block") break;
            if (job.spots.has(`${p.x},${p.y},${p.z}`)) return false; // part of the build: never scaffolding
            column.unshift(p);
        }
        if (!column.length || column.length > 6) return false;
        for (const p of column) {
            ctx.doing(`Putting up scaffolding at ${ctx.fmt(p)}`);
            await getNear(p);
            const ref = bot.blockAt(p.offset(0, -1, 0));
            if (!(await equip(filler))) return false;
            await clickPlace(ref, { face: "up", cursor: "mid" });
            if (!(await waitForBlock(p, (b) => b && b.boundingBox === "block"))) return false;
            job.scaffold.push(p);
        }
        return true;
    }

    // Blocks the pathfinder put down to climb or bridge on its way round the
    // build (it towers up when that's quicker than walking round). Broken
    // again at the end, top down, and picked up; only blocks still there
    // and of the kinds it climbs with.
    async function clearLitter() {
        // (the pathfinder's list is of item ids; compare by name)
        const climbWith = new Set([...TOWER, ...bot.pathfinder.movements.scafoldingBlocks.map((id) => bot.registry.items[id]?.name)]);
        // Only blocks standing out in the open (air on two sides or more: a
        // pillar, a bridge), not ones filling a shaft it climbed up out of a
        // mine: taking those out would only open the hole up again.
        const inShaft = (p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => bot.blockAt(p.offset(dx, 0, dz))?.boundingBox !== "block").length < 2;
        const ours = (p) => {
            const b = bot.blockAt(p);
            return b && climbWith.has(b.name) && !job.spots.has(`${p.x},${p.y},${p.z}`) && !inShaft(p) ? b : null;
        };
        let cleared = 0;
        for (let round = 0; round < 3 && job.litter.length; round++) {
            const list = job.litter.splice(0).filter(ours).sort((a, b) => b.y - a.y);
            // Standing on a pillar of them: climb down it, breaking each one under us.
            const feet = bot.entity.position.floored();
            const under = list.filter((p) => p.x === feet.x && p.z === feet.z && p.y < feet.y);
            if (under.length && under[0].y === feet.y - 1) {
                ctx.doing("Climbing down the blocks I put up");
                await ctx.climbDown(under.slice().reverse()).catch(() => {});
            }
            for (const p of list) {
                ctx.checkStop();
                if (!ours(p)) continue;
                ctx.doing(`Clearing away the ${ctx.pretty(ours(p).name)} I climbed on at ${ctx.fmt(p)}`);
                await ctx.safely(async () => {
                    await getNear(p);
                    const b = ours(p);
                    if (b) await dig(b);
                    cleared++;
                });
            }
        }
        if (job.tower) await ctx.safely(towerDown);
        if (cleared) {
            ctx.log(`Cleared away ${cleared} block${cleared === 1 ? "" : "s"} I'd climbed on.`);
            await ctx.safely(() => ctx.pickUpDrops(null, 8));
        }
    }

    async function takeDownScaffold() {
        for (const p of job.scaffold.slice().reverse()) {
            const b = bot.blockAt(p);
            if (b && b.boundingBox === "block" && !job.spots.has(`${p.x},${p.y},${p.z}`)) {
                ctx.doing(`Taking down scaffolding at ${ctx.fmt(p)}`);
                await ctx.safely(() => dig(b));
            }
        }
        job.scaffold = [];
    }

    function setState(t, state) {
        if (t.state === state) return;
        if (state === "done") job.done++;
        else if (t.state === "done") job.done--;
        t.state = state;
    }

    // ---------- the build loop ----------

    async function build(options) {
        job = await prepare(options);
        job.scaffold = [];
        job.litter = [];
        job.airRefused = 0;
        job.tower = null;
        job.towerFrom = Infinity;
        job.state = "starting";
        saveJob();
        const skippedNote = Object.entries(job.skipped).map(([why, n]) => `${n}× ${why}`).join(", ");
        ctx.say(`Building ${job.name}: ${job.targets.length} blocks at ${ctx.fmt(job.origin)}${job.turns ? `, turned ${job.turns * 90}°` : ""}.${skippedNote ? ` Skipping ${skippedNote}.` : ""}`);

        // The pathfinder shouldn't dig into the build or drop its own
        // scaffolding blocks into it on the way somewhere.
        const movements = bot.pathfinder.movements;
        const noBreak = (b) => (inBox(b.position, job.box) ? 1000 : 0);
        const noPlace = (b) => (inBox(b.position, job.box) ? 1000 : 0);
        movements.exclusionAreasBreak.push(noBreak);
        movements.exclusionAreasPlace.push(noPlace);
        // Note what the pathfinder puts down on the way (see clearLitter).
        const place = bot.placeBlock;
        bot.placeBlock = async (ref, face) => {
            const spot = ref.position.plus(face);
            const byPathfinder = bot.pathfinder.isBuilding();
            const result = await place(ref, face);
            if (byPathfinder) job.litter.push(spot);
            return result;
        };
        try {
            // Already there from an earlier go?
            for (const t of job.targets) if (matches(bot.blockAt(t.pos), t.want)) setState(t, "done");
            job.state = "checking chests";
            chests.clear(); // look again: things may have been taken or added
            await indexChests(job.box);
            job.state = "building";
            for (let pass = 0; pass < 6; pass++) {
                let progress = false;
                const todo = job.targets.filter((t) => t.state === "todo");
                if (!todo.length) break;
                for (let i = 0; i < todo.length; i++) {
                    const t = todo[i];
                    if (t.state !== "todo") continue;
                    ctx.checkStop();
                    await ctx.guard();
                    if (ctx.countItem(t.item) < t.count) {
                        try {
                            await restock(t.item, todo.slice(i, i + 160));
                        } catch (err) {
                            if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                            ctx.log(`Couldn't get ${t.item}: ${err.message}`);
                        }
                        if (ctx.countItem(t.item) < 1) {
                            // nothing to be done for this item for now
                            for (const o of job.targets) if (o.state === "todo" && o.item === t.item) setState(o, "missing");
                            continue;
                        }
                    }
                    let result;
                    try {
                        result = await ctx.act(() => placeOne(t));
                    } catch (err) {
                        if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                        ctx.log(`Couldn't place ${t.want.name} at ${ctx.fmt(t.pos)}: ${err.message}`);
                        result = ++t.tries >= 3 ? "failed" : "later";
                    }
                    if (result === "done") {
                        setState(t, "done");
                        progress = true;
                    } else if (result === "blocked" || result === "failed" || result === "missing") {
                        setState(t, result);
                    }
                }
                if (!progress) {
                    // stuck on floating blocks: scaffold under them and go round again
                    let built = false;
                    for (const t of job.targets.filter((o) => o.state === "todo")) {
                        if (await ctx.safely(() => scaffoldUnder(t))) built = true;
                    }
                    if (!built) break;
                }
            }
            for (const t of job.targets) if (t.state === "todo") setState(t, "failed");
            if (job.tower) await ctx.safely(towerDown);
            await takeDownScaffold();
            await clearLitter();
            job.state = "finished";
            ctx.say(summary());
        } catch (err) {
            job.state = err instanceof ctx.Stopped ? "stopped" : "failed";
            throw err;
        } finally {
            bot.placeBlock = place;
            movements.exclusionAreasBreak.splice(movements.exclusionAreasBreak.indexOf(noBreak), 1);
            movements.exclusionAreasPlace.splice(movements.exclusionAreasPlace.indexOf(noPlace), 1);
        }
    }

    function summary() {
        const count = (state) => job.targets.filter((t) => t.state === state).length;
        const missing = {};
        for (const t of job.targets) if (t.state === "missing") missing[t.item] = (missing[t.item] || 0) + t.count;
        const parts = [`Built ${job.name}: ${count("done")}/${job.targets.length} blocks.`];
        if (count("blocked")) parts.push(`${count("blocked")} spots had something in the way (say ${config.commandPrefix}build ${job.name} ... clear to dig those out).`);
        if (Object.keys(missing).length) parts.push(`Couldn't get: ${Object.entries(missing).map(([i, n]) => `${n} ${i}`).join(", ")}.`);
        if (count("failed")) parts.push(`${count("failed")} wouldn't place.`);
        if (job.misfaced) parts.push(`${job.misfaced} ended up facing another way.`);
        return parts.join(" ");
    }

    // Materials: what the build needs, what the bot carries, what the chests hold.
    async function materials(options) {
        const j = options ? await prepare(options) : job;
        if (!j) return null;
        if (options) {
            chests.clear();
            await indexChests(j.box); // (a build in progress has looked already)
        }
        const need = {};
        for (const t of j.targets) {
            if (t.state === "done" || matches(bot.blockAt(t.pos), t.want)) continue;
            need[t.item] = (need[t.item] || 0) + t.count;
        }
        return Object.entries(need)
            .map(([item, count]) => ({ item, need: count, have: ctx.countItem(item), chests: inChests(item) }))
            .sort((a, b) => b.need - a.need);
    }

    function status() {
        if (!job) return null;
        const count = (state) => job.targets.filter((t) => t.state === state).length;
        const missing = {};
        for (const t of job.targets) if (t.state === "missing") missing[t.item] = (missing[t.item] || 0) + t.count;
        const need = stillNeeded();
        return {
            name: job.name,
            file: job.file,
            origin: { x: job.origin.x, y: job.origin.y, z: job.origin.z },
            size: job.size,
            turns: job.turns,
            state: job.state,
            total: job.targets.length,
            done: count("done"),
            blocked: count("blocked"),
            failed: count("failed"),
            missing,
            materials: Object.entries(need)
                .map(([item, n]) => ({ item, need: n, have: ctx.countItem(item), chests: inChests(item) }))
                .sort((a, b) => b.need - a.need)
                .slice(0, 12),
        };
    }

    Object.assign(ctx, { buildSchematic: build, buildMaterials: materials, buildStatus: status, lastBuild: lastJob, listSchematics, findSchematic });
}

module.exports = { installBuilding, listSchematics, waysToPlace, itemFor, matches, DIR: DIR };
