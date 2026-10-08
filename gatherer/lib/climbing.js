// Getting up: out of holes, up cliffs, and up from underground.
//
// - The pathfinder's 1x1 tower (jump, put a block under itself) placed the
//   block as soon as the jump started, while the bot was still in the way,
//   and servers refuse that. Placing now waits for the top of the jump, so
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

    // A block placed where the bot is, mid-jump: wait until its feet are clear.
    const placeBlock = bot.placeBlock.bind(bot);
    bot.placeBlock = async (ref, face) => {
        const spot = ref.position.plus(face);
        if (!bot.entity.onGround && inTheWay(spot)) {
            await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
            const start = Date.now();
            while (inTheWay(spot) && !bot.entity.onGround && Date.now() - start < 1000) await bot.waitForTicks(1);
            if (inTheWay(spot)) throw new Error("I'm in the way of that block");
        }
        return placeBlock(ref, face);
    };

    // Would a block at `spot` overlap the bot (with a little to spare above)?
    function inTheWay(spot) {
        const p = bot.entity.position;
        const w = 0.3;
        return p.x + w > spot.x && p.x - w < spot.x + 1 && p.z + w > spot.z && p.z - w < spot.z + 1 && p.y < spot.y + 1.05 && p.y + 1.8 > spot.y;
    }

    // Before going anywhere well above from underground: straight up first.
    const goto = bot.pathfinder.goto.bind(bot.pathfinder);
    bot.pathfinder.goto = async (goal, ...rest) => {
        const upTo = tunnelTarget(goal);
        if (upTo !== null && upTo - bot.entity.position.y >= 3 && boxedIn()) {
            const before = ctx.interrupts;
            await tunnelUp(upTo).catch((err) => {
                if (err instanceof ctx.Stopped || ctx.interrupts !== before) throw err;
                ctx.log(`Stopped tunnelling up: ${err.message}.`);
            });
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
    // Rock above the head, or a shaft (rock all round at head height), with no daylight.
    function boxedIn() {
        if (!bot.entity.onGround || bot.entity.isInWater) return false;
        const feet = bot.entity.position.floored();
        const head = bot.blockAt(feet.offset(0, 1, 0));
        if (head?.skyLight > 0 && !shaft(feet)) return false;
        return solid(bot.blockAt(feet.offset(0, 2, 0))) || shaft(feet);
    }
    function shaft(feet) {
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(bot.blockAt(feet.offset(dx, 1, dz))));
    }

    // Dig the block over the head, jump, put a block where the feet were;
    // up to feet height `toY`, or out in the open. Anything it can't do
    // safely (water or lava next to it, gravel above, no blocks to place)
    // is left to the pathfinder.
    async function tunnelUp(toY) {
        const before = ctx.interrupts;
        const from = bot.entity.position.floored().y;
        let said = false;
        await ctx.during("Tunnelling straight up", async () => {
            while (bot.entity.position.y < toY) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
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
