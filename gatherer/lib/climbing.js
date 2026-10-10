// Getting up: out of holes, up cliffs, and up from underground.
//
// - The pathfinder's 1x1 tower (jump, put a block under itself) placed the
//   block as soon as the jump started, while the bot was still in the way,
//   and servers refuse that. Placing now waits for the top of the jump, and
//   lands on the block without waiting for the server (see placeBlock), so
//   towers are back on and the pathfinder can choose them.
// - Its costs are about time (one is roughly a block walked), so whether to
//   dig a staircase, put blocks down, or walk round is whichever is quicker.
//   Placing was cheaper than it really is; measured, a tower step takes as
//   long as walking two and a half blocks.
// - Underground with somewhere well above to get to, it tunnels straight up,
//   a block under itself at each step (dig one, place one), instead of a
//   staircase (dig three per step). The pathfinder never quite does this
//   itself: in solid rock it can't finish a search in time, so it sets off
//   along its best guess so far, which is a diagonal staircase.

const { Vec3 } = require("vec3");

const LEAVES = /leaves$/;

function installClimbing(ctx, movements) {
    const { bot } = ctx;

    movements.allow1by1towers = true;
    movements.placeCost = 1.5;

    // A block put under itself mid-jump (a tower step): wait until its feet
    // are clear of the spot, then put the block in its own world straight
    // away, as the game does, so it lands on it. Waiting for the server's
    // answer instead, it had dropped back into that space by the time the
    // block arrived (on a server with any lag): standing inside the block,
    // it broke it and started again, and never got anywhere. If the server
    // says no, its answer takes the block back out and the bot drops (and
    // the pathfinder, finding itself short of the step, plans again).
    const placeBlock = bot.placeBlock.bind(bot);
    bot.placeBlock = async (ref, face) => {
        const spot = ref.position.plus(face);
        if (!towerStep(spot)) return placeBlock(ref, face);
        if (inTheWay(spot)) {
            await centreOn(spot);
            await jumpClear(spot);
        }
        await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
        const block = bot.registry.blocksByName[bot.heldItem?.name];
        const before = bot.blockAt(spot);
        if (!block || !before || before.boundingBox !== "empty") return placeBlock(ref, face);
        bot.world.setBlockStateId(spot, block.defaultState);
        watchForRefusal(spot, block);
        // Don't wait for the answer (the block already shows, so mineflayer
        // can't tell a yes from no answer); a no puts the block back to air.
        placeBlock(ref, face).catch(() => {});
        await bot.waitForTicks(2); // sent
    };

    // To the middle of its block before jumping straight up. More than 0.2
    // off, part of its head is under the roof beside the hole above, and the
    // jump goes nowhere: it dug, tried to put a block down, couldn't get up,
    // and went round again. (The pathfinder only gets within 0.35 of a spot,
    // and a tunnel up starts wherever it happened to stand.) Sneaking, so it
    // can't step off an edge.
    const offCentre = (spot) => {
        const p = bot.entity.position;
        return { dx: spot.x + 0.5 - p.x, dz: spot.z + 0.5 - p.z };
    };
    async function centreOn(spot) {
        let { dx, dz } = offCentre(spot);
        if (Math.abs(dx) <= 0.15 && Math.abs(dz) <= 0.15) return;
        try {
            for (let i = 0; i < 40 && (Math.abs(dx) > 0.1 || Math.abs(dz) > 0.1); i++) {
                await bot.look(Math.atan2(-dx, -dz), bot.entity.pitch, true);
                bot.setControlState("jump", false);
                bot.setControlState("sprint", false);
                bot.setControlState("sneak", true);
                bot.setControlState("forward", true);
                await bot.waitForTicks(1);
                ({ dx, dz } = offCentre(spot));
            }
        } finally {
            bot.setControlState("forward", false);
            bot.setControlState("sneak", false);
        }
        await bot.waitForTicks(2); // come to a stop
    }
    ctx.centreOn = centreOn;

    // Jump (if it isn't already: the item can take a moment to get into its
    // hand, by which time it's landed again), until its feet are above the spot.
    async function jumpClear(spot) {
        const start = Date.now();
        bot.setControlState("jump", true);
        try {
            while (inTheWay(spot) && Date.now() - start < 1500) await bot.waitForTicks(1);
        } finally {
            if (!bot.pathfinder.isMoving()) bot.setControlState("jump", false);
        }
        if (inTheWay(spot)) throw new Error("I'm in the way of that block (no room to jump?)");
    }

    // A server that keeps saying no to towering (a plugin, a protected area):
    // after three in a row, stop planning towers for a minute and dig instead,
    // rather than jumping on the spot for ever.
    let refusals = 0;
    let towersBackAt = 0;
    function watchForRefusal(spot, block) {
        const key = `blockUpdate:${spot}`;
        const onUpdate = (oldBlock, newBlock) => {
            if (newBlock?.type === block.id || bot.targetDigBlock?.position?.equals(spot)) return;
            done();
            if (++refusals < 3) return;
            refusals = 0;
            movements.allow1by1towers = false;
            towersBackAt = Date.now() + 60000;
            ctx.log("The server won't let me tower up here; climbing other ways for a minute.");
        };
        const timer = setTimeout(() => {
            done();
            refusals = 0;
        }, 2000);
        const done = () => {
            clearTimeout(timer);
            bot.removeListener(key, onUpdate);
        };
        bot.on(key, onUpdate);
    }
    bot.on("physicsTick", () => {
        if (towersBackAt && Date.now() > towersBackAt) {
            towersBackAt = 0;
            movements.allow1by1towers = true;
        }
    });

    // A block where the bot's feet are, or just under it in mid-jump (not
    // one beside and below it: bridging, at the edge of its block).
    function towerStep(spot) {
        if (!overColumn(spot)) return false;
        const feet = Math.floor(bot.entity.position.y + 0.01);
        return feet === spot.y || (!bot.entity.onGround && feet === spot.y + 1);
    }

    // Is the bot over that block's column?
    function overColumn(spot) {
        const p = bot.entity.position;
        return p.x + 0.3 > spot.x && p.x - 0.3 < spot.x + 1 && p.z + 0.3 > spot.z && p.z - 0.3 < spot.z + 1;
    }

    // Would a block at `spot` overlap the bot (with a little to spare above)?
    function inTheWay(spot) {
        const p = bot.entity.position;
        const w = 0.3;
        return p.x + w > spot.x && p.x - w < spot.x + 1 && p.z + w > spot.z && p.z - w < spot.z + 1 && p.y < spot.y + 1.05 && p.y + 1.8 > spot.y;
    }

    // Before going anywhere well above from underground: straight up first.
    // Not if it's been told to leave that to the pathfinder for a while
    // (ctx.noTunnelUntil: going round in circles with it, see unstuck.js).
    // Each trip has a number, and a tunnel stops as soon as a newer trip
    // starts: one that timed out went on digging and putting blocks down
    // while the pathfinder took it somewhere else.
    const goto = bot.pathfinder.goto.bind(bot.pathfinder);
    let trips = 0;
    bot.pathfinder.goto = async (goal, ...rest) => {
        const trip = ++trips;
        const upTo = tunnelTarget(goal);
        if (upTo !== null && upTo - bot.entity.position.y >= 3 && Date.now() >= (ctx.noTunnelUntil || 0) && boxedIn()) {
            const before = ctx.interrupts;
            await tunnelUp(upTo, () => trip === trips).catch((err) => {
                if (err instanceof ctx.Stopped || ctx.interrupts !== before) throw err;
                ctx.log(`Stopped tunnelling up: ${err.message}.`);
            });
            if (trip !== trips) throw new Error("a newer trip took over");
        }
        return goto(goal, ...rest);
    };

    // How high to tunnel. Somewhere in the open (back to the surface): right
    // up to it, since walking up there is quick. Somewhere else underground:
    // a staircase gets it along as well as up, a block a step, so only the
    // part of the climb that's more than the way across.
    function tunnelTarget(goal) {
        const g = goal?.pos ?? goal;
        if (!Number.isFinite(g?.y)) return null;
        const feet = bot.entity.position.floored();
        const spot = new Vec3(g.x ?? feet.x, g.y, g.z ?? feet.z).floored();
        const open = [0, 1].some((dy) => bot.blockAt(spot.offset(0, dy, 0))?.skyLight > 0);
        if (open) return g.y - 1;
        const across = Math.abs(spot.x - feet.x) + Math.abs(spot.z - feet.z);
        return feet.y + (g.y - feet.y - across);
    }

    const solid = (b) => Boolean(b) && b.boundingBox === "block" && !LEAVES.test(b.name);
    // Rock above the head, or a shaft (rock all round at head height), with
    // no daylight. (A pit open to the sky counted too: there it built a
    // pillar of dirt that the pathfinder then dug back out, and round again.
    // In the open the pathfinder climbs well enough itself.)
    function boxedIn() {
        if (!bot.entity.onGround || bot.entity.isInWater) return false;
        const feet = bot.entity.position.floored();
        const head = bot.blockAt(feet.offset(0, 1, 0));
        if (head?.skyLight > 0) return false;
        return solid(bot.blockAt(feet.offset(0, 2, 0))) || shaft(feet);
    }
    function shaft(feet) {
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(bot.blockAt(feet.offset(dx, 1, dz))));
    }

    // Dig the block over the head, jump, put a block where the feet were;
    // up to feet height `toY`, or out in the open. Anything it can't do
    // safely (water or lava next to it, gravel above, no blocks to place)
    // is left to the pathfinder.
    async function tunnelUp(toY, current = () => true) {
        const before = ctx.interrupts;
        const from = bot.entity.position.floored().y;
        let said = false;
        await ctx.during("Tunnelling straight up", async () => {
            while (bot.entity.position.y < toY) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (!current()) break; // a newer trip took over
                const feet = bot.entity.position.floored();
                const above = movements.getBlock(feet, 0, 2, 0);
                const dig = solid(above);
                if (!dig && !shaft(feet)) break; // out in the open
                if (dig && !canDig(above)) break;
                if (!bot.inventory.items().some((i) => movements.scafoldingBlocks.includes(i.type))) break;
                if (!said) {
                    ctx.log(`Tunnelling straight up from y ${from}.`);
                    said = true;
                }
                if (dig) {
                    const tool = bot.pathfinder.bestHarvestTool(above);
                    if (tool) await bot.equip(tool, "hand");
                    await bot.dig(bot.blockAt(above.position), true);
                    if (solid(bot.blockAt(above.position))) break; // gravel fell in, or the server said no
                }
                await ctx.pillarStep(feet);
            }
        });
        if (said) ctx.log(`Up to y ${bot.entity.position.floored().y}.`);
    }

    function canDig(block) {
        if (!movements.safeToBreak(block)) return false;
        const tool = bot.pathfinder.bestHarvestTool(block);
        return block.digTime(tool ? tool.type : null, false, false, false, [], bot.entity.effects) < 6000;
    }
}

module.exports = { installClimbing };
