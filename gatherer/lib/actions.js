// Executes plans: mine, craft, smelt, farm, hunt. `obtain` is the entry point;
// it asks the planner for the cheapest method and recurses into the inputs.
// Every attempt is timed and scored so the planner learns what works.

const { goals } = require("mineflayer-pathfinder");
// Blocks that do something when clicked (chests, doors, crafting tables...):
// placing against them needs sneaking, so better not to pick them at all.
const INTERACTABLE = new Set(require("mineflayer-pathfinder/lib/interactable.json"));
const { Vec3 } = require("vec3");

function installActions(ctx) {
    const { bot, config, kb, planner, learn } = ctx;
    const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

    // Make sure the inventory holds at least `target` of `name`.
    async function obtain(name, target, seen = new Set()) {
        if (ctx.countItem(name) >= target) return;
        if (seen.has(name)) throw new Error(`going in circles on ${name}`);
        if (!bot.registry.itemsByName[name]) throw new Error(`unknown item ${name}`);
        const next = new Set(seen).add(name);
        const plan = planner.plan(name, seen, target);
        // Going out for something (mining, hunting, farming, smelting)? Get what
        // the tasks after this one need of it too, as far as the bag allows:
        // one trip down for the 24 diamonds of a diamond armor set, not four.
        const later = ctx.ahead?.get(name) || 0;
        if (later > 0 && ["mine", "hunt", "farm", "smelt"].includes(plan.type)) {
            const stack = bot.registry.itemsByName[name].stackSize || 64;
            const room = Math.max(0, bot.inventory.emptySlotCount() - 2) * stack;
            const extra = Math.min(later, room);
            if (extra > 0) {
                ctx.log(`Getting ${extra} more ${name} while I'm at it, for the tasks after this one.`);
                target += extra;
                ctx.ahead.set(name, later - extra);
            }
        }
        const missing = target - ctx.countItem(name);
        ctx.log(`Need ${missing} more ${name}: ${plan.type}`);
        if (plan.type === "none") throw new Error(`I don't know how to get ${name}`);
        const done = learn.begin(plan.type, name, missing);
        try {
            await ctx.within(`${missing} ${ctx.pretty(name)}`, () => run(plan, name, target, next));
            done(true);
        } catch (err) {
            // Only the step that went wrong is marked as failing: planks didn't
            // fail because the log under them couldn't be mined, and blaming
            // them sent the bot looking for spruce it can't see past oak it can.
            const blame = !(err instanceof ctx.Stopped || err instanceof ctx.Retry) && !err.blamed;
            done(blame ? false : null);
            if (blame) err.blamed = true;
            throw err;
        }
    }

    // The plan's method, run inside obtain's goal level.
    async function run(plan, name, target, next) {
        switch (plan.type) {
            case "mine":
                await mine(name, target, plan.blocks, next);
                break;
            case "craft":
                await craft(name, target, plan, next);
                break;
            case "smelt":
                await smelt(name, target, plan.input, next);
                break;
            case "hunt":
                await hunt(name, target, plan.mobs, next);
                break;
            case "farm":
                await ctx.farmFor(name, target, plan.crop, next);
                break;
        }
    }

    // ---------- mining ----------

    async function mine(name, target, blocks, seen) {
        let exploreAttempts = 0;
        let failedDigs = 0;
        let lastExplore = null;
        const skipped = new Set(); // blocks we could not reach or break
        const climbed = new Set(); // blocks we already fetched dirt to build up to
        while (ctx.countItem(name) < target) {
            ctx.checkStop();
            await ctx.guard();
            await makeRoom(name);

            const harvestable = blocks.filter(ctx.canHarvest);
            if (harvestable.length === 0) {
                const tool = planner.toolFor(blocks, seen);
                if (!tool) throw new Error(`no tool I can make will mine ${name}`);
                ctx.say(`Getting a ${tool} to mine ${name}.`);
                ctx.doing(`Getting a ${ctx.pretty(tool)} to mine ${ctx.pretty(name)}`);
                await obtain(tool, 1, seen);
                continue;
            }

            const candidates = () => bot
                .findBlocks({
                    matching: harvestable.map((b) => b.id),
                    maxDistance: config.searchRadius,
                    count: spawnProtected ? 4096 : 64, // the nearest may all be in spawn protection
                })
                .filter((p) => !skipped.has(p.toString()) && !isProtected(p) && !learn.isUnreachable(p))
                .filter((p) => !ctx.crew?.claimedByOther(`block:${p}`));
            const positions = candidates();
            // Prefer blocks near our own height: the top of a tree whose trunk
            // is gone looks close but can't be reached without building up.
            // Logs grow on the surface, so one far below is in a ravine or cave
            // and means digging down to it.
            const me = bot.entity.position;
            // Dirt and sand: take it from the top rather than digging a pit.
            const below = /_(log|stem)$/.test(name) ? 4 : /^(dirt|grass_block|sand|red_sand|gravel|clay)$/.test(name) ? 1 : null;
            const effort = (p) =>
                p.distanceTo(me) + 3 * Math.max(0, p.y - me.y - 2) + (below === null ? 0 : 6 * Math.max(0, me.y - p.y - below));
            positions.sort((a, b) => effort(a) - effort(b));
            if (lastExplore) {
                learn.reward(lastExplore.context, lastExplore.arm, positions.length > 0 ? 1 : 0);
                lastExplore = null;
            }
            if (positions.length === 0) {
                if (++exploreAttempts > config.maxExploreAttempts) {
                    throw new Error(`couldn't find any ${name} nearby`);
                }
                ctx.log(`No ${name} source in range, exploring (${exploreAttempts}/${config.maxExploreAttempts}).`);
                ctx.doing(`Looking for ${ctx.pretty(name)} (${exploreAttempts}/${config.maxExploreAttempts})`);
                lastExplore = await exploreAndReplan(seen, "block", harvestable.map((b) => b.name), candidates);
                continue;
            }
            exploreAttempts = 0;

            const block = bot.blockAt(positions[0]);
            learn.remember("block", block.name, block.position, positions.length);
            ctx.crew?.claim(`block:${block.position}`);
            const before = ctx.interrupts;
            let failure = null;
            try {
                await harvest(block);
            } catch (err) {
                failure = err.message;
            }
            ctx.checkStop();
            if (ctx.interrupts !== before) continue; // a mob showed up; try again
            if (!failure && bot.blockAt(block.position)?.type === block.type) {
                failure = "unreachable";
            }
            // Out of reach overhead (the top of a tree whose trunk is gone, say):
            // get some dirt, build a pillar up to it and break it from there.
            const key = block.position.toString();
            if (failure && !climbed.has(key) && block.position.y > bot.entity.position.y + 2) {
                climbed.add(key);
                try {
                    await climbTo(block, seen);
                    failure = bot.blockAt(block.position)?.type === block.type ? "couldn't reach it" : null;
                } catch (err) {
                    if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                    failure = err.message;
                }
                if (ctx.interrupts !== before) continue;
            }
            if (failure) {
                skipped.add(block.position.toString());
                if (failure === "unreachable") learn.markUnreachable(block.position);
                ctx.log(`Skipping ${block.name} at ${ctx.fmt(block.position)}: ${failure}`);
                if (++failedDigs > 10) throw new Error(`too many failures mining ${name}`);
            } else {
                failedDigs = 0;
            }
        }
    }

    // Blocks the pathfinder may place to climb or bridge.
    function scaffoldCount() {
        const ids = new Set(bot.pathfinder.movements.scafoldingBlocks);
        return bot.inventory.items().reduce((sum, i) => sum + (ids.has(i.type) ? i.count : 0), 0);
    }

    // Walk to a block, break it and pick up what drops, never waiting forever:
    // a drop that lands on leaves or out of reach is left behind.
    async function harvest(block) {
        const far = block.position.distanceTo(bot.entity.position);
        const what = `${ctx.pretty(block.name)} at ${ctx.fmt(block.position)}`;
        ctx.doing(`Walking to the ${what}`);
        // Grass, flowers and crops have no hitbox, so "somewhere it can be seen
        // from" never comes true for them (the pathfinder searched until it gave
        // up): just get next to those.
        const goal = block.boundingBox === "empty"
            ? new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
            : new goals.GoalLookAtBlock(block.position, bot.world);
        // Under water: the pathfinder won't go there, so dive.
        if (ctx.isUnderwater?.(block.position)) await ctx.diveTo(block.position);
        else await ctx.withTimeout(bot.pathfinder.goto(goal), 20000 + far * 1500);
        const target = bot.blockAt(block.position);
        if (!target || target.type !== block.type) return; // already gone
        await bot.tool.equipForBlock(target, { requireHarvest: true });
        if (!target.canHarvest(bot.heldItem?.type ?? null)) throw new Error("no tool that can harvest it");
        ctx.doing(`Mining the ${what}`);
        await digBlock(target);
        ctx.doing(`Picking up what the ${ctx.pretty(block.name)} dropped`);
        await collectDropsAt(block.position);
    }

    // mineflayer marks a block as broken the moment its own timer runs out. The
    // server may not agree yet: a lagging server finishes the break a little
    // later, and one that disagrees about the dig time puts the block back. So
    // wait for the server's word, and dig again if the block is still there.
    let warnedServerDig = false;
    let spawnProtected = false; // the server refused a block near the world spawn
    async function digBlock(block) {
        const pos = block.position;
        if (bot.game?.gameMode === "adventure") {
            throw new Error(`I'm in adventure mode, which can't break blocks. Put me in survival: /gamemode survival ${bot.username}`);
        }
        let refusals = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            ctx.checkStop();
            const verdict = serverVerdict(pos);
            let ms;
            try {
                ms = await swingAt(block);
            } catch (err) {
                verdict.cancel();
                throw err;
            }
            // If the server saw us as slower (in the air, say), it finishes the
            // break itself a little later, so give it time.
            const result = await verdict.after(Math.max(4000, ms * 5));
            stopSwinging();
            if (result === "broken") {
                bot.world.setBlockStateId(pos, 0);
                return;
            }
            // Spawn protection refuses every time, so only conclude that after the
            // server has put this block back twice.
            if (result === "kept") refusals++;
            if (refusals >= 2 && nearSpawn(pos)) {
                if (!spawnProtected) {
                    spawnProtected = true;
                    const sp = bot.spawnPoint;
                    ctx.log(
                        `The server won't let me break blocks near the world spawn (${sp.x} ${sp.z}): that's spawn ` +
                            `protection. I'll work at least 17 blocks away from it. (Ops aren't affected, or set ` +
                            `spawn-protection=0 in server.properties.)`
                    );
                }
                throw new Error("inside spawn protection");
            }
            if (!warnedServerDig) {
                warnedServerDig = true;
                ctx.log(
                    result === "kept"
                        ? `The server put the ${block.name} back after I broke it; digging it again.`
                        : `The server hasn't confirmed breaking the ${block.name} (is it lagging?); digging it again.`
                );
            }
            block = bot.blockAt(pos);
            if (!block || block.type === 0) return;
        }
        throw new Error(`the server wouldn't let me break the ${block.name}`);
    }

    // Dig like a client: face the block, start, keep swinging, and say we're
    // done once it should be broken if we're standing on the ground (the server
    // keeps going by itself if it saw us as slower). mineflayer's bot.dig decides
    // the time once, at the start: a bot still settling from a step or a jump
    // waited five times too long, so the dig timed out before it said "done".
    // Returns the dig time used; the swinging goes on until stopSwinging().
    let swinging = null;
    async function swingAt(block) {
        const pos = block.position;
        const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
        const d = eye.minus(pos.offset(0.5, 0.5, 0.5));
        const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
        // faces: 0 down, 1 up, 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x)
        const face = ay >= ax && ay >= az ? (d.y > 0 ? 1 : 0) : ax >= az ? (d.x > 0 ? 5 : 4) : d.z > 0 ? 3 : 2;
        const offset = [[0, -0.5, 0], [0, 0.5, 0], [0, 0, -0.5], [0, 0, 0.5], [-0.5, 0, 0], [0.5, 0, 0]][face];
        await bot.lookAt(pos.offset(0.5 + offset[0], 0.5 + offset[1], 0.5 + offset[2]), true);
        const held = bot.heldItem;
        const helmet = bot.inventory.slots[bot.getEquipmentDestSlot("head")];
        const enchants = [...(held?.enchants || []), ...(helmet?.enchants || [])];
        // Head under water, or not standing on anything: each makes it five times slower.
        const inWater = ctx.headUnderwater ? ctx.headUnderwater() : ["water", "flowing_water"].includes(bot._getBlockAtEyeLevel?.()?.name);
        const ms = block.digTime(held?.type ?? null, bot.game.gameMode === "creative", inWater, !bot.entity.onGround, enchants, bot.entity.effects);
        if (!Number.isFinite(ms)) throw new Error(`can't break the ${block.name}`);
        stopSwinging();
        bot._client.write("block_dig", { status: 0, location: pos, face });
        bot.swingArm();
        swinging = setInterval(() => bot.swingArm(), 250);
        // A long dig (under water, say) gives way to anything urgent: short of
        // air, a mob, a stop. Cancel it with the server and let the caller deal.
        const before = ctx.interrupts;
        const end = Date.now() + ms + 50;
        while (Date.now() < end) {
            await ctx.wait(Math.min(100, Math.max(0, end - Date.now())));
            if (ctx.interrupts !== before || ctx.stopRequested) {
                stopSwinging();
                bot._client.write("block_dig", { status: 1, location: pos, face }); // cancelled
                throw new Error("interrupted");
            }
        }
        bot._client.write("block_dig", { status: 2, location: pos, face }); // finished
        return ms;
    }

    function stopSwinging() {
        if (swinging) clearInterval(swinging);
        swinging = null;
    }

    // Vanilla spawn protection covers 16 blocks around the world spawn (a square).
    function nearSpawn(pos) {
        const sp = bot.spawnPoint;
        return Boolean(sp) && Math.max(Math.abs(pos.x - sp.x), Math.abs(pos.z - sp.z)) <= 16;
    }

    // Watches the server's block updates for `pos`: "broken" once it reports
    // air, "kept" if it reports the block (a refusal often comes right as we
    // start digging), "silent" if it says nothing within `ms` after we finished.
    function serverVerdict(pos) {
        const client = bot._client;
        let result = null;
        let sawBlock = false;
        let wake = null;
        const seen = (stateId) => {
            if (stateId === 0 || bot.registry.blocksByStateId[stateId]?.name?.endsWith("air")) result = "broken";
            else if (!result) sawBlock = true;
            if (result && wake) wake();
        };
        const onChange = (packet) => {
            const l = packet.location;
            if (l && l.x === pos.x && l.y === pos.y && l.z === pos.z) seen(packet.type);
        };
        const onMulti = (packet) => {
            const c = packet.chunkCoordinates;
            if (!c || c.x !== pos.x >> 4 || c.y !== pos.y >> 4 || c.z !== pos.z >> 4) return;
            for (const record of packet.records || []) {
                const x = (record >> 8) & 15, z = (record >> 4) & 15, y = record & 15;
                if (x === (pos.x & 15) && y === (pos.y & 15) && z === (pos.z & 15)) seen(Math.floor(record / 4096));
            }
        };
        client.on("block_change", onChange);
        client.on("multi_block_change", onMulti);
        const cancel = () => {
            client.removeListener("block_change", onChange);
            client.removeListener("multi_block_change", onMulti);
        };
        return {
            cancel,
            after: (ms) =>
                new Promise((resolve) => {
                    const done = () => {
                        clearTimeout(timer);
                        cancel();
                        resolve(result || (sawBlock ? "kept" : "silent"));
                    };
                    const timer = setTimeout(done, ms);
                    wake = done;
                    if (result) done();
                }),
        };
    }

    // Pillar up with dirt until `block` is within reach, then break it.
    async function climbTo(block, seen) {
        const reach = () => bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
        const needed = Math.min(20, Math.ceil(block.position.y - bot.entity.position.y));
        if (scaffoldCount() < needed) {
            ctx.log(`Can't reach the ${block.name} at ${ctx.fmt(block.position)}; getting dirt to build up to it.`);
            ctx.doing(`Getting dirt to build up to the ${ctx.pretty(block.name)}`);
            await obtain("dirt", ctx.countItem("dirt") + needed - scaffoldCount(), seen);
        }
        // Stand under it, or as close as the ground allows.
        const p = block.position;
        ctx.doing(`Walking under the ${ctx.pretty(block.name)} at ${ctx.fmt(p)}`);
        await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(p.x, p.z, 1)), 30000);
        ctx.log(`Building up to the ${block.name} at ${ctx.fmt(p)}.`);
        ctx.doing(`Building up to the ${ctx.pretty(block.name)} at ${ctx.fmt(p)}`);
        const pillar = [];
        try {
            await buildUp(block, reach, pillar);
            const target = bot.blockAt(p);
            if (target && target.type === block.type) {
                await bot.tool.equipForBlock(target, { requireHarvest: true });
                ctx.doing(`Mining the ${ctx.pretty(block.name)} from the top of a pillar`);
                await digBlock(target);
            }
            await digInReach(block.type);
            await shakeDownDrops();
        } finally {
            ctx.doing("Climbing back down");
            await climbDown(pillar).catch(() => {});
        }
        ctx.doing(`Picking up what the ${ctx.pretty(block.name)} dropped`);
        await collectDropsAt(p);
    }

    async function buildUp(block, reach, pillar) {
        const p = block.position;
        for (let step = 0; step < 24 && reach() > 4; step++) {
            ctx.checkStop();
            const feet = bot.entity.position.floored();
            // Clear leaves (or anything else) above our head first.
            const overhead = bot.blockAt(feet.offset(0, 2, 0));
            if (overhead && overhead.boundingBox === "block") {
                if (overhead.position.equals(p)) break; // that's the target: in reach now
                if (!overhead.diggable || ctx.kb.neverBreakIds().includes(overhead.type)) throw new Error("something unbreakable overhead");
                await bot.tool.equipForBlock(overhead, {});
                await digBlock(overhead);
                continue;
            }
            await pillarStep(feet);
            pillar.push(feet);
        }
        if (reach() > 4.5) throw new Error("couldn't build up to it");
    }

    // While up there, break any more of the same block within reach (the rest
    // of the treetop).
    async function digInReach(type) {
        for (let i = 0; i < 12; i++) {
            ctx.checkStop();
            const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
            const next = bot
                .findBlocks({ matching: type, maxDistance: 6, count: 20 })
                .filter((pos) => eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.3)
                .map((pos) => bot.blockAt(pos))[0];
            if (!next) return;
            await bot.tool.equipForBlock(next, { requireHarvest: true });
            await digBlock(next);
        }
    }

    // Drops from a treetop often land on the leaves below, out of reach from the
    // ground. Break the leaves under them (from up here) so they fall.
    async function shakeDownDrops() {
        await ctx.wait(500); // let the drops appear
        for (let i = 0; i < 8; i++) {
            ctx.checkStop();
            const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
            const under = Object.values(bot.entities)
                .filter((e) => e.name === "item" && e.isValid !== false && e.position.distanceTo(eye) < 6)
                .map((e) => bot.blockAt(e.position.offset(0, -0.3, 0).floored()))
                .find((b) => b && /_leaves$/.test(b.name) && eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.3);
            if (!under) return;
            await bot.tool.equipForBlock(under, {});
            await digBlock(under);
            await ctx.wait(500); // let it fall
        }
    }

    // Dig the pillar away from the top, landing on each block below in turn;
    // the dirt drops where we land, so it's picked up on the way.
    async function climbDown(pillar) {
        while (pillar.length) {
            const top = pillar.pop();
            if (!bot.entity.position.floored().offset(0, -1, 0).equals(top)) return; // moved off it
            const b = bot.blockAt(top);
            if (!b || b.boundingBox !== "block") return;
            await bot.tool.equipForBlock(b, {});
            await digBlock(b);
            await waitUntil(() => bot.entity.onGround && bot.entity.position.y < top.y + 0.5, 2000);
        }
    }

    // Jump, and once our feet are above the block we stood on, put dirt there
    // (or the first of `prefer` we carry: the builder uses scaffolding).
    async function pillarStep(feet, prefer = null) {
        const ids = new Set(bot.pathfinder.movements.scafoldingBlocks);
        const item = prefer
            ? prefer.map((n) => bot.inventory.items().find((i) => i.name === n)).find(Boolean)
            : bot.inventory.items().find((i) => ids.has(i.type));
        if (!item) throw new Error("out of dirt");
        await bot.equip(item, "hand");
        const ground = bot.blockAt(feet.offset(0, -1, 0));
        if (!ground || ground.boundingBox !== "block") throw new Error("nothing solid to build on");
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        // The server refuses a block that would overlap us, so place it near the
        // top of the jump, once the server has seen our feet clear of it.
        for (let attempt = 0; attempt < 3; attempt++) {
            await waitUntil(() => bot.entity.onGround, 1500);
            bot.setControlState("jump", true);
            const risen = await waitUntil(() => bot.entity.position.y > feet.y + 1.15, 1500);
            bot.setControlState("jump", false);
            if (!risen) throw new Error("couldn't jump");
            await waitTicks(2);
            try {
                await bot.placeBlock(ground, new Vec3(0, 1, 0));
            } catch (err) {
                // refused or not confirmed; check below and try again
            }
            await waitUntil(() => bot.entity.onGround, 1500);
            if (bot.entity.position.y > feet.y + 0.9) return;
        }
        throw new Error("the server didn't let me place blocks");
    }

    async function waitTicks(n) {
        for (let i = 0; i < n; i++) await new Promise((resolve) => bot.once("physicsTick", resolve));
    }

    function waitUntil(test, ms) {
        return new Promise((resolve) => {
            if (test()) return resolve(true);
            const start = Date.now();
            const check = () => {
                if (test()) done(true);
                else if (Date.now() - start > ms) done(false);
            };
            const done = (result) => {
                bot.removeListener("physicsTick", check);
                resolve(result);
            };
            bot.on("physicsTick", check);
        });
    }

    async function collectDropsAt(pos) {
        const deadline = Date.now() + 8000;
        await ctx.wait(400); // let the drop spawn and land
        while (Date.now() < deadline) {
            ctx.checkStop();
            const me = bot.entity.position;
            const drop = Object.values(bot.entities)
                // drops fall, so look below the block too
                .filter((e) => e.name === "item" && e.isValid !== false && Math.hypot(e.position.x - pos.x - 0.5, e.position.z - pos.z - 0.5) < 5 && Math.abs(e.position.y - pos.y) < 12)
                .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
            if (!drop) return;
            if (!(await walkOver(drop, deadline - Date.now()))) return; // can't get to it
        }
    }

    // Get onto a dropped item so the server hands it over: path to its block,
    // then step straight at it (being "within a block" can be just too far).
    // Returns false if it couldn't get there.
    async function walkOver(drop, ms = 8000) {
        const deadline = Date.now() + Math.max(1000, ms);
        const p = drop.position;
        const goal = new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 0);
        try {
            await ctx.withTimeout(bot.pathfinder.goto(goal), Math.max(500, deadline - Date.now()));
        } catch (err) {
            try {
                await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)), Math.max(500, deadline - Date.now()));
            } catch (err2) {
                return false;
            }
        }
        const flat = () => Math.hypot(drop.position.x - bot.entity.position.x, drop.position.z - bot.entity.position.z);
        if (drop.isValid && bot.entities[drop.id] && flat() > 0.4) {
            try {
                await bot.lookAt(drop.position.offset(0, bot.entity.height ?? 1.62, 0), true);
                bot.setControlState("forward", true);
                await waitUntil(() => !bot.entities[drop.id] || flat() < 0.4, 1500);
            } finally {
                bot.setControlState("forward", false);
            }
        }
        await ctx.wait(250);
        return true;
    }

    function isProtected(pos) {
        if (spawnProtected && nearSpawn(pos)) return true;
        const r = config.protectRadius;
        if (!r) return false;
        const anchors = [ctx.home, config.chest && new Vec3(config.chest.x, config.chest.y, config.chest.z)];
        return anchors.some((a) => a && a.distanceTo(pos) <= r);
    }

    // After wandering somewhere new, a different material may now be closer
    // (birch instead of oak), so sub-steps hand control back to re-plan.
    async function exploreAndReplan(seen, kind, names, usable) {
        const choice = await explore(kind, names, usable);
        const task = ctx.current;
        if (!task) return choice;
        task.explores = (task.explores || 0) + 1;
        if (task.explores > config.maxExploreAttempts * 3) {
            throw new Error("explored too long without finding what I need");
        }
        if (seen.size > 1) {
            // Score the direction now, since re-planning skips the normal check.
            if (choice) learn.reward(choice.context, choice.arm, sourcesInView(kind, names) ? 1 : 0);
            throw new ctx.Retry();
        }
        return choice;
    }

    function sourcesInView(kind, names) {
        if (kind === "mob") return Boolean(nearestEntity(names, config.searchRadius));
        const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
        return Boolean(bot.findBlock({ matching: ids, maxDistance: config.searchRadius }));
    }

    // What of `names` is in view now, as keys: block positions or mob ids.
    // `usable` (from the caller) leaves out what it can't use, e.g. blocks it
    // already gave up on, or water that isn't a source.
    function inView(kind, names, usable) {
        if (usable) return usable().map((x) => String(x?.id ?? x?.position ?? x)); // mobs by id, blocks by place
        if (kind === "mob") {
            const me = bot.entity.position;
            return Object.values(bot.entities)
                .filter((e) => names.includes(e.name) && e.position.distanceTo(me) <= config.searchRadius)
                .map((e) => `mob:${e.id}`);
        }
        const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
        return bot.findBlocks({ matching: ids, maxDistance: config.searchRadius, count: 32 }).map(String);
    }

    // Walk to `goal`, but stop as soon as something new from `names` comes
    // into view: it used to walk on to a remembered spot past water (or trees,
    // or cows) on the way. Things in view when it set off don't count; they
    // were there already and weren't good enough. Returns true if it stopped
    // for something.
    async function walkLooking(goal, ms, kind, names, usable) {
        const before = new Set(inView(kind, names, usable));
        let spotted = false;
        const timer = setInterval(() => {
            try {
                if (!spotted && inView(kind, names, usable).some((key) => !before.has(key))) {
                    spotted = true;
                    bot.pathfinder.setGoal(null);
                }
            } catch (err) {
                // world changing under us; check again next time
            }
        }, 1000);
        try {
            await ctx.withTimeout(bot.pathfinder.goto(goal), ms);
        } catch (err) {
            if (!spotted) throw err;
        } finally {
            clearInterval(timer);
        }
        if (spotted) ctx.log(`Spotted ${names.slice(0, 3).join("/")} on the way.`);
        return spotted;
    }

    // Look for `names` (blocks or mobs). First go back to places we remember
    // seeing them; otherwise pick a compass direction, learning which
    // directions tend to pay off around here and avoiding places we got hurt.
    // Either way it keeps looking on the way (see walkLooking).
    // Returns the direction choice so the caller can score it.
    async function explore(kind = "block", names = [], usable = null) {
        const pos = bot.entity.position;
        const remembered = learn
            .recall(kind, names, pos)
            .filter((spot) => spot.distance > config.searchRadius * 0.6);
        if (remembered.length) {
            const spot = remembered[0];
            ctx.log(`Heading to where I saw ${spot.name} before (${spot.x} ${spot.z}).`);
            const goal = new goals.GoalNear(spot.x, spot.y, spot.z, 6);
            const spotted = await ctx.during(`Heading to where I saw ${ctx.pretty(spot.name)} before (${spot.x} ${spot.z})`, () =>
                ctx.safely(() => walkLooking(goal, 120000, kind, names, usable))
            );
            if (!spotted && !sourcesInView(kind, names)) learn.forget(kind, names, new Vec3(spot.x, spot.y, spot.z));
            return null;
        }

        const region = `${Math.floor(pos.x / 256)},${Math.floor(pos.z / 256)}`;
        const context = `explore:${kind}:${names.slice(0, 3).join("/")}@${region}`;
        const target = (arm) => {
            const angle = (COMPASS.indexOf(arm) * Math.PI) / 4;
            return new Vec3(
                Math.floor(pos.x + Math.sin(angle) * config.exploreDistance),
                pos.y,
                Math.floor(pos.z - Math.cos(angle) * config.exploreDistance)
            );
        };
        const safe = COMPASS.filter((arm) => learn.dangerAt(target(arm)) < 3);
        // In a crew, leave directions another bot is already exploring.
        const free = safe.filter((arm) => !ctx.crew?.claimedByOther(`explore:${context}:${arm}`));
        const arm = learn.choose(context, free.length ? free : safe.length ? safe : COMPASS);
        ctx.crew?.claim(`explore:${context}:${arm}`, 90000);
        const dest = target(arm);
        const looking = names.length ? ` for ${names.slice(0, 3).map(ctx.pretty).join(" / ")}` : "";
        await ctx.during(`Exploring ${arm}${looking} (to ${dest.x} ${dest.z})`, () =>
            ctx.safely(() => walkLooking(new goals.GoalXZ(dest.x, dest.z), 60000, kind, names, usable))
        );
        return { context, arm };
    }

    // ---------- crafting ----------

    // Walk to a crafting table or furnace. A creeper it ran from standing by
    // it (or turning up while it kept away) means starting over: the plan
    // then uses, or puts down, another one away from it.
    async function goToStation(block, what) {
        await ctx.act(async () => {
            const lurker = ctx.lurkerNear?.(block.position);
            if (lurker) {
                ctx.log(`A ${ctx.pretty(lurker.name)} is by ${what} at ${ctx.fmt(block.position)}; using another one.`);
                throw new ctx.Retry();
            }
            await ctx.goTo(block.position, 2, what);
        });
    }

    async function craft(name, target, plan, seen) {
        const item = bot.registry.itemsByName[name];
        const perCraft = plan.recipe.result.count;
        const times = Math.ceil((target - ctx.countItem(name)) / perCraft);

        // Gathering one ingredient can use up another (sticks eat planks), so
        // loop until everything is in hand at once.
        for (let pass = 0; ; pass++) {
            ctx.checkStop();
            ctx.doing(`Gathering what ${ctx.pretty(name)} is made from`);
            if (plan.recipe.requiresTable) await ensureStation("crafting_table", seen);
            for (const ing of plan.ingredients) {
                await obtain(ing.name, ing.count * times, seen);
            }
            const ready = plan.ingredients.every((ing) => ctx.countItem(ing.name) >= ing.count * times);
            if (ready) break;
            if (pass >= 4) throw new Error(`couldn't collect ingredients for ${name}`);
        }

        let table = null;
        if (plan.recipe.requiresTable) {
            table = await ensureStation("crafting_table", seen);
            await goToStation(table, "the crafting table");
        }
        // The variant that was planned (cobblestone, not the cobbled deepslate
        // that happens to be in the bag for something else), if it's craftable.
        const usable = bot.recipesFor(item.id, null, 1, table);
        const wanted = new Map(plan.ingredients.map((i) => [i.name, i.count]));
        const same = (r) => {
            const ings = kb.recipeIngredients(r);
            return ings.length === wanted.size && ings.every((i) => wanted.get(i.name) === i.count);
        };
        const recipe = usable.find(same) || usable[0];
        if (!recipe) throw new Error(`no usable recipe for ${name}`);
        ctx.doing(`Crafting ${times * perCraft} ${ctx.pretty(name)}`);
        await bot.craft(recipe, times, table);
        ctx.log(`Crafted ${times * perCraft} ${name}.`);
    }

    // Find a crafting table / furnace nearby, or make and place one.
    async function ensureStation(name, seen) {
        let block = ctx.findStation(name);
        if (block) return block;
        if (seen.has(name)) throw new Error(`need a ${name} to make a ${name}`);
        await obtain(name, 1, seen);
        block = await ctx.during(`Placing a ${ctx.pretty(name)}`, () => ctx.act(() => placeNearby(name)));
        ctx.placedStations.push(block.position);
        ctx.say(`Placed a ${name} at ${ctx.fmt(block.position)}.`);
        return block;
    }

    async function placeNearby(name) {
        const item = bot.inventory.items().find((i) => i.name === name);
        if (!item) throw new Error(`no ${name} to place`);
        const feet = bot.entity.position.floored();
        const spots = bot
            .findBlocks({
                matching: (b) => b.boundingBox === "block" && !INTERACTABLE.has(b.name) && b.name !== "modded_block",
                maxDistance: 3,
                count: 40,
            })
            .filter((p) => {
                const above = p.offset(0, 1, 0);
                if (above.equals(feet) || above.equals(feet.offset(0, 1, 0))) return false;
                return bot.blockAt(above)?.name === "air";
            })
            .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
        for (const pos of spots.slice(0, 6)) {
            const dest = pos.offset(0, 1, 0);
            let problem = null;
            try {
                const held = bot.inventory.items().find((i) => i.name === name);
                if (!held) break; // it went down somewhere already
                await bot.equip(held, "hand");
                // Sneak, like a player does, so clicking never opens something instead.
                bot.setControlState("sneak", true);
                await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
            } catch (err) {
                problem = err.message;
            } finally {
                bot.setControlState("sneak", false);
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow); // opened by mistake
            }
            // The server may have placed it even if the reply looked wrong; look again.
            await ctx.wait(400);
            const placed = bot.blockAt(dest);
            if (placed?.name === name) return placed;
            if (placed?.name === "modded_block" && bot.teachModdedBlock?.(dest, name)) return bot.blockAt(dest);
            ctx.log(`Couldn't place ${name} at ${ctx.fmt(dest)}: ${problem || `got ${placed?.name || "nothing"}`}`);
        }
        throw new Error(`no room to place a ${name}`);
    }

    // ---------- smelting ----------

    async function smelt(name, target, input, seen) {
        const amount = target - ctx.countItem(name);
        await obtain(input, amount, seen);
        const furnaceBlock = await ensureStation("furnace", seen);
        ctx.doing(`Getting fuel to smelt ${ctx.pretty(input)}`);
        await ensureFuel(amount, input, seen);
        await obtain(input, amount, seen); // planks for fuel may have used up logs
        await goToStation(furnaceBlock, "the furnace");
        ctx.doing("Loading the furnace");

        let furnace = await bot.openFurnace(furnaceBlock);
        try {
            if (furnace.outputItem()) await furnace.takeOutput();
            const leftover = furnace.inputItem();
            if (leftover && leftover.name !== input) await furnace.takeInput();

            await addFuel(furnace, amount, input);
            const inputItem = bot.registry.itemsByName[input];
            let toLoad = amount;
            // The input slot holds one stack; top it up as it empties.
            const loadInput = async () => {
                const n = Math.min(toLoad, 64 - (furnace.inputItem()?.count || 0), ctx.countItem(input));
                if (n <= 0) return;
                await furnace.putInput(inputItem.id, null, n);
                toLoad -= n;
            };
            await loadInput();

            ctx.say(`Smelting ${amount} ${input} into ${name}.`);
            let lastProgress = Date.now();
            while (ctx.countItem(name) < target) {
                ctx.checkStop();
                ctx.doing(`Smelting ${ctx.pretty(input)} into ${ctx.pretty(name)} (${ctx.countItem(name)}/${target})`);
                if (ctx.threatNearby()) {
                    furnace.close();
                    await ctx.guard();
                    // (what's in it stays there if a creeper keeps us away)
                    await goToStation(furnaceBlock, "the furnace");
                    furnace = await bot.openFurnace(furnaceBlock);
                }
                if (furnace.outputItem()) {
                    await furnace.takeOutput();
                    await loadInput();
                    lastProgress = Date.now();
                    continue;
                }
                // Out of fuel with work left: top up right away.
                if (!furnace.fuelItem() && furnace.fuel <= 0 && furnace.inputItem()) {
                    const before = furnace.fuelItem()?.count || 0;
                    await addFuel(furnace, target - ctx.countItem(name), input);
                    if ((furnace.fuelItem()?.count || 0) === before) throw new Error(`ran out of fuel for ${name}`);
                    lastProgress = Date.now();
                    continue;
                }
                if (Date.now() - lastProgress > 15000) throw new Error(`furnace stopped making ${name}`);
                for (let i = 0; i < 4 && !ctx.threatNearby(); i++) await ctx.wait(250);
            }
            // Leave nothing behind in the furnace that we put in.
            if (furnace.inputItem()) await furnace.takeInput().catch(() => {});
        } finally {
            try {
                furnace.close();
            } catch (err) {
                // already closed
            }
        }
    }

    // Make sure we carry enough fuel to smelt `amount` items.
    async function ensureFuel(amount, input, seen) {
        if (ctx.fuelInInventory(input) >= amount) return;
        const planks = Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith("_planks"));
        const choice = planner.cheapestOf(["coal", ...planks]);
        if (!choice || choice.cost === Infinity) throw new Error("can't find any fuel");
        const missing = amount - ctx.fuelInInventory(input);
        const units = Math.ceil(missing / kb.fuelValue(choice.name));
        await obtain(choice.name, ctx.countItem(choice.name) + units, seen);
    }

    // The fuel slot holds one kind at a time: top up what's in it, or else put
    // in the kind that covers the most (one log and two planks used to stop
    // after the log). Counts come from the furnace screen, which is current
    // while it's open; bot.inventory isn't (see ctx.countItem).
    async function addFuel(furnace, amount, input) {
        const current = furnace.fuelItem();
        const needed = amount - (current ? kb.fuelValue(current.name) * current.count : 0);
        if (needed <= 0) return;
        const totals = new Map(); // fuel kind -> count carried
        for (const i of furnace.items()) {
            if (i.name !== input && kb.fuelValue(i.name) > 0) totals.set(i.name, (totals.get(i.name) || 0) + i.count);
        }
        const value = (n) => totals.get(n) * kb.fuelValue(n);
        const kind = current
            ? totals.has(current.name) ? current.name : null
            : [...totals.keys()].sort((a, b) => value(b) - value(a))[0];
        if (!kind) return;
        const n = Math.min(totals.get(kind), Math.ceil(needed / kb.fuelValue(kind)), 64 - (current?.count || 0));
        if (n > 0) await furnace.putFuel(bot.registry.itemsByName[kind].id, null, n);
    }

    // ---------- hunting ----------

    async function hunt(name, target, mobs, seen) {
        let exploreAttempts = 0;
        let lastExplore = null;
        const gaveUpOn = new Set(); // mobs we couldn't catch
        while (ctx.countItem(name) < target) {
            ctx.checkStop();
            await ctx.guard();
            await makeRoom(name);
            await ctx.act(() => pickUpDrops(name));
            if (ctx.countItem(name) >= target) break;

            const findMob = () => nearestEntity(
                mobs,
                config.searchRadius,
                gaveUpOn,
                (e) => ctx.huntable(e) && !ctx.crew?.claimedByOther(`mob:${e.id}`)
            );
            const mob = findMob();
            if (lastExplore) {
                learn.reward(lastExplore.context, lastExplore.arm, mob ? 1 : 0);
                lastExplore = null;
            }
            if (!mob) {
                if (++exploreAttempts > config.maxExploreAttempts) {
                    throw new Error(`couldn't find any ${mobs.join("/")} nearby`);
                }
                ctx.log(`No ${mobs.join("/")} I can hunt in range, exploring (${exploreAttempts}/${config.maxExploreAttempts}).`);
                ctx.doing(`Looking for ${mobs.map(ctx.pretty).join(" / ")} (${exploreAttempts}/${config.maxExploreAttempts})`);
                lastExplore = await exploreAndReplan(seen, "mob", mobs, () => [findMob()].filter(Boolean));
                continue;
            }
            exploreAttempts = 0;
            learn.remember("mob", mob.name, mob.position);
            ctx.crew?.claim(`mob:${mob.id}`, 45000);
            ctx.log(`Hunting ${mob.name} for ${name}.`);
            ctx.doing(`Hunting a ${ctx.pretty(mob.name)} for ${ctx.pretty(name)}`);
            try {
                await ctx.act(() => ctx.huntMob(mob));
            } catch (err) {
                if (err instanceof ctx.Stopped || err instanceof ctx.Retry) throw err;
                ctx.log(err.message);
                gaveUpOn.add(mob.id);
                continue;
            }
            await ctx.wait(500); // let drops spawn
        }
    }

    function nearestEntity(names, radius, exclude = new Set(), allowed = () => true) {
        const pos = bot.entity.position;
        return Object.values(bot.entities)
            .filter((e) => names.includes(e.name) && !exclude.has(e.id) && allowed(e))
            .filter((e) => e.position.distanceTo(pos) <= radius)
            .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0];
    }

    // Walk over dropped items (optionally only `name`) lying nearby.
    async function pickUpDrops(name, radius = 12) {
        const pos = bot.entity.position;
        const drops = Object.values(bot.entities)
            .filter((e) => e.name === "item" && e.position.distanceTo(pos) <= radius)
            .filter((e) => !name || e.getDroppedItem?.()?.name === name)
            .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));
        for (const drop of drops) {
            if (!drop.isValid || !bot.entities[drop.id]) continue;
            const item = drop.getDroppedItem?.()?.name;
            await ctx.during(`Picking up ${item ? ctx.pretty(item) : "drops"}`, () => ctx.safely(() => walkOver(drop)));
        }
    }

    // ---------- inventory ----------

    async function makeRoom(name) {
        if (bot.inventory.emptySlotCount() >= 2) return;
        if (!config.chest) throw new Error("inventory is full and no chest is configured");
        const before = ctx.countItem(name);
        await depositAll();
        if (ctx.countItem(name) < before) throw new ctx.Retry();
        if (bot.inventory.emptySlotCount() < 2) throw new Error("inventory is still full after unloading");
    }

    // Put the items we were asked to gather into the configured chest.
    async function depositAll() {
        return ctx.during("Emptying my bag into the chest", depositInChest);
    }

    async function depositInChest() {
        const chestPos = new Vec3(config.chest.x, config.chest.y, config.chest.z);
        await ctx.act(() => ctx.goTo(chestPos, 2, "the chest"));
        const chestBlock = bot.blockAt(chestPos);
        if (!chestBlock || !chestBlock.name.includes("chest")) {
            ctx.say(`No chest at ${ctx.fmt(chestPos)}.`);
            return;
        }
        const chest = await bot.openContainer(chestBlock);
        try {
            const wanted = new Set(
                [ctx.current, ...ctx.queue, ...config.tasks].filter(Boolean).map((t) => t.item)
            );
            for (const item of bot.inventory.items()) {
                if (!wanted.has(item.name)) continue;
                try {
                    await chest.deposit(item.type, null, item.count);
                    if (ctx.current && item.name === ctx.current.item) {
                        ctx.current.deposited += item.count;
                    }
                } catch (err) {
                    ctx.say(`Chest is full: ${err.message}`);
                    break;
                }
            }
        } finally {
            chest.close();
        }
        ctx.log("Deposited items in chest.");
    }

    Object.assign(ctx, { obtain, depositAll, pickUpDrops, nearestEntity, explore, placeNearby, ensureStation, pillarStep, climbDown });
}

module.exports = { installActions };
