// Sprint-jumping: on a straight, flat run the bot jumps as it sprints, as
// players do (each jump while sprinting gives a push forward: about 7 blocks
// a second instead of 5.6). The pathfinder only jumps when it has to, so this
// runs straight after it each tick and holds jump on the stretches where it's
// safe: the next few blocks of its path go straight on at the same height,
// nothing to dig or place, and room above the head to jump into.
// config.sprintJump: false turns it off (jumping uses up food faster).
//
// The pathfinder only counts a step of its path reached within a block of
// its height, and the top of a jump is higher than that: steps flown over
// were missed, and it turned back for them. So in the air on a straight
// run, the steps it has passed are taken off the path here.

function installSprintJump(ctx) {
    const { bot, config } = ctx;
    let path = [];
    bot.on("path_update", (r) => {
        path = r.path || []; // the pathfinder's own list: nodes come off it as they're reached
    });
    bot.on("path_reset", () => (path = []));
    bot.on("goal_reached", () => (path = []));

    let groundY = null; // the level it last stood on (its feet are higher in a jump)
    bot.on("physicsTick", () => {
        if (config.sprintJump === false || !bot.entity) return;
        if (bot.entity.onGround) groundY = Math.floor(bot.entity.position.y + 0.01);
        const pf = bot.pathfinder;
        if (!pf.isMoving() || pf.isMining() || pf.isBuilding()) return;
        if (!bot.controlState.sprint || !bot.controlState.forward) return; // the pathfinder isn't sprinting here
        if (bot.entity.isInWater || bot.entity.isInLava || bot.food <= 6) return;
        const run = straightRun();
        if (!run.dir) return;
        if (!bot.entity.onGround) skipPassed(run);
        // Only once lined up with the run: a jump off the line carries it
        // further off (the push is straight ahead), and it weaves.
        if (run.length >= 3.5 && run.offLine <= 0.3) bot.setControlState("jump", true);
    });

    // In the air: steps of this run it's already over or past come off the
    // path, and it faces the next one (the pathfinder had turned back).
    function skipPassed(run) {
        const me = bot.entity.position;
        let skipped = false;
        while (path.length > 1) {
            const node = path[0];
            if (node.toBreak?.length || node.toPlace?.length || Math.floor(node.y) !== run.y) break;
            const dx = node.x - me.x, dz = node.z - me.z;
            const ahead = dx * run.dir.x + dz * run.dir.z;
            if (ahead > 0.3 && Math.hypot(dx, dz) > 0.6) break;
            path.shift();
            skipped = true;
        }
        if (skipped) {
            const next = path[0];
            bot.look(Math.atan2(-(next.x - me.x), -(next.z - me.z)), 0, true).catch(() => {});
        }
    }

    // How far the path goes on straight ahead, level, from here.
    function straightRun() {
        const me = bot.entity.position;
        const level = groundY ?? Math.floor(me.y);
        let from = me.floored();
        from.y = level;
        let dir = null;
        let run = 0;
        for (const node of path.slice(0, 8)) {
            if (node.toBreak?.length || node.toPlace?.length) break;
            if (Math.floor(node.y) !== level) break;
            const step = { x: Math.sign(Math.floor(node.x) - from.x), z: Math.sign(Math.floor(node.z) - from.z) };
            if (!step.x && !step.z) continue;
            if (dir && (step.x !== dir.x || step.z !== dir.z)) break; // a turn
            dir = dir || step;
            const at = node.floored ? node.floored() : node;
            if (!clearToJump(at)) break;
            run = Math.hypot(at.x + 0.5 - me.x, at.z + 0.5 - me.z);
            from = at;
        }
        if (!dir) return { dir: null, length: 0 };
        const n = Math.hypot(dir.x, dir.z);
        const unit = { x: dir.x / n, z: dir.z / n };
        // how far the bot is to the side of the line through the run's end
        const offLine = Math.abs((me.x - (from.x + 0.5)) * unit.z - (me.z - (from.z + 0.5)) * unit.x);
        return { dir: unit, offLine, y: level, length: clearToJump(me.floored().offset(0, level - Math.floor(me.y), 0)) ? run : 0 };
    }

    // Ground under it, and nothing at head height or just above (the top of a jump).
    function clearToJump(p) {
        const floor = bot.blockAt(p.offset(0, -1, 0));
        if (!floor || floor.boundingBox !== "block" || /magma|soul_sand|honey|slime|ice/.test(floor.name)) return false;
        for (let dy = 0; dy <= 2; dy++) {
            const b = bot.blockAt(p.offset(0, dy, 0));
            if (!b || b.boundingBox !== "empty" || /water|lava|cobweb|powder_snow|sweet_berry/.test(b.name)) return false;
        }
        return true;
    }
}

module.exports = { installSprintJump };
