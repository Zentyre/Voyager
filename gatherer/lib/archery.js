// Bow combat: ballistic aiming with target leading, keeping a safe distance,
// picking arrows back up, and learning its own aim error from where its
// arrows actually fly (no LLM: it watches each arrow and keeps a running
// average of how far above/below the target it went, per distance band).

const { goals } = require("mineflayer-pathfinder");

const ARROWS = ["arrow", "spectral_arrow", "tipped_arrow"];
const ARROW_SPEED = 3.0; // blocks/tick at full draw
const GRAVITY = 0.05;
const DRAG = 0.99;
const FULL_DRAW_TICKS = 20;
const EYE_HEIGHT = 1.62;

function installArchery(ctx) {
    const { bot, config, learn } = ctx;

    function hasBow() {
        return (
            config.useBow !== false &&
            bot.inventory.items().some((i) => i.name === "bow") &&
            bot.inventory.items().some((i) => ARROWS.includes(i.name))
        );
    }

    function arrowCount() {
        return bot.inventory.items().filter((i) => ARROWS.includes(i.name)).reduce((s, i) => s + i.count, 0);
    }

    // Fly an arrow at `pitch` and report its height when it has covered
    // `horizontal` blocks, plus how many ticks that took.
    function simulate(pitch, horizontal) {
        let vx = Math.cos(pitch) * ARROW_SPEED;
        let vy = Math.sin(pitch) * ARROW_SPEED;
        let x = 0;
        let y = 0;
        for (let tick = 1; tick <= 200; tick++) {
            const px = x;
            const py = y;
            x += vx;
            y += vy;
            vx *= DRAG;
            vy = vy * DRAG - GRAVITY;
            if (x >= horizontal) {
                const f = (horizontal - px) / (x - px);
                return { y: py + (y - py) * f, ticks: tick - 1 + f };
            }
            if (y < -64) return null;
        }
        return null;
    }

    // Pitch that lands the arrow `dy` blocks above the eye at `horizontal`.
    function solvePitch(horizontal, dy) {
        let lo = -Math.PI / 3;
        let hi = Math.PI / 4; // past ~45° the flatter shot is always better
        const high = simulate(hi, horizontal);
        if (!high || high.y < dy) return null; // out of range
        for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            const s = simulate(mid, horizontal);
            if (!s || s.y < dy) lo = mid;
            else hi = mid;
        }
        const s = simulate(hi, horizontal);
        return s ? { pitch: hi, ticks: s.ticks } : null;
    }

    function band(distance) {
        return Math.min(4, Math.floor(distance / 10)); // 0-10, 10-20, 20-30, 30-40, 40+
    }

    // Yaw/pitch to hit `mob`, leading it by its measured velocity and
    // correcting by the learned aim error for this distance.
    function aim(mob, velocity) {
        const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
        const center = mob.position.offset(0, (mob.height || 1.8) * 0.5, 0);
        let ticks = 0;
        let solution = null;
        for (let i = 0; i < 3; i++) {
            const p = center.plus(velocity.scaled(ticks));
            const dx = p.x - eye.x;
            const dz = p.z - eye.z;
            const horizontal = Math.hypot(dx, dz);
            const correction = learn.value(`aim:${band(horizontal)}`, 0);
            const s = solvePitch(horizontal, p.y - eye.y - correction);
            if (!s) return null;
            ticks = s.ticks;
            solution = { yaw: Math.atan2(-dx, -dz), pitch: s.pitch, horizontal, targetY: p.y, ticks };
        }
        return solution;
    }

    function clearShot(mob) {
        const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
        const target = mob.position.offset(0, (mob.height || 1.8) * 0.5, 0);
        const distance = target.distanceTo(eye);
        const hit = bot.world.raycast(eye, target.minus(eye).normalize(), distance);
        return !hit;
    }

    // Watch the arrow we just fired and learn how far off our aim was.
    function trackArrow(shot) {
        const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
        let arrow = null;
        const findArrow = () =>
            Object.values(bot.entities).find(
                (e) => e.name === "arrow" && e.position.distanceTo(eye) < 8 && !seenArrows.has(e.id)
            );
        let ticks = 0;
        const onTick = () => {
            ticks++;
            if (!arrow) {
                arrow = findArrow();
                if (arrow) seenArrows.add(arrow.id);
            }
            if (arrow) {
                const travelled = Math.hypot(arrow.position.x - eye.x, arrow.position.z - eye.z);
                if (travelled >= shot.horizontal) {
                    const error = arrow.position.y - shot.targetY; // + = went high
                    if (Math.abs(error) < 6) learn.ema(`aim:${band(shot.horizontal)}`, error, 0.2);
                    return stop();
                }
            }
            if (ticks > shot.ticks + 20 || (arrow && !arrow.isValid)) stop();
        };
        const stop = () => bot.removeListener("physicsTick", onTick);
        bot.on("physicsTick", onTick);
    }
    const seenArrows = new Set();

    // Shoot at `mob` until it dies, keeping our distance; switch to melee
    // if it gets close.
    async function shoot(mob, { timeoutMs = 30000, maxDistance = Infinity, leash = null } = {}) {
        const before = ctx.interrupts;
        const start = Date.now();
        ctx.target = mob;
        let last = { pos: mob.position.clone(), time: Date.now() };
        let velocity = mob.position.minus(mob.position); // zero vector
        let charging = false;
        let hits = 0;
        const onHurt = (entity) => {
            if (entity === mob) {
                hits++;
                learn.count("arrowHits");
            }
        };
        bot.on("entityHurt", onHurt);
        try {
            while (mob.isValid && bot.entities[mob.id]) {
                ctx.checkStop();
                if (ctx.interrupts !== before) throw new Error("interrupted");
                if (Date.now() - start > timeoutMs) throw new Error(`couldn't kill the ${mob.name} in time`);
                if (!hasBow()) throw new Error("out of arrows");
                const distance = mob.position.distanceTo(bot.entity.position);
                if (distance > maxDistance || ctx.offLeash(leash)) return;
                if (distance < 4) {
                    // Too close for a bow.
                    ctx.target = null;
                    return await ctx.attack(mob, {
                        style: "fast",
                        timeoutMs: timeoutMs - (Date.now() - start),
                        maxDistance,
                        leash,
                    });
                }

                // Keep at a comfortable range: back off if close, close in if far.
                if (distance < 7) bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 9)), true);
                else if (distance > config.bowRange) bot.pathfinder.setGoal(new goals.GoalFollow(mob, config.bowRange - 6), true);
                else bot.pathfinder.setGoal(null);

                // No clear line of sight (wall, hill): move closer instead of wasting arrows.
                if (!clearShot(mob)) {
                    bot.pathfinder.setGoal(new goals.GoalFollow(mob, 3), true);
                    await bot.waitForTicks(10);
                    continue;
                }

                const bow = bot.inventory.items().find((i) => i.name === "bow");
                if (bot.heldItem?.name !== "bow") await bot.equip(bow, "hand");

                // Draw, keep re-aiming while the bow charges, then release.
                bot.activateItem();
                charging = true;
                let solution = null;
                for (let t = 0; t < FULL_DRAW_TICKS + 2; t++) {
                    await bot.waitForTicks(1);
                    const now = Date.now();
                    const dt = (now - last.time) / 50;
                    if (dt >= 2) {
                        const v = mob.position.minus(last.pos).scaled(1 / dt);
                        velocity = velocity.scaled(0.5).plus(v.scaled(0.5));
                        last = { pos: mob.position.clone(), time: now };
                    }
                    solution = aim(mob, velocity);
                    if (solution) await bot.look(solution.yaw, solution.pitch, true);
                    if (!mob.isValid) break;
                }
                if (!solution) {
                    // Out of range or no clear shot: walk closer.
                    bot.deactivateItem();
                    charging = false;
                    bot.pathfinder.setGoal(new goals.GoalFollow(mob, 6), true);
                    await bot.waitForTicks(10);
                    continue;
                }
                bot.deactivateItem();
                charging = false;
                learn.count("arrowsShot");
                trackArrow(solution);
                await bot.waitForTicks(3);
            }
            learn.count("kills");
        } finally {
            if (charging) bot.deactivateItem();
            bot.removeListener("entityHurt", onHurt);
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            ctx.target = null;
            if (hits) ctx.log(`Hit the ${mob.name} ${hits} time${hits === 1 ? "" : "s"}.`);
            await collectArrows().catch(() => {});
        }
    }

    // Walk over arrows lying nearby to pick them back up.
    async function collectArrows(radius = 16) {
        const me = bot.entity.position;
        const arrows = Object.values(bot.entities)
            .filter((e) => e.name === "arrow" && e.position.distanceTo(me) <= radius)
            .filter((e) => e.velocity ? e.velocity.norm() < 0.05 : true)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
            .slice(0, 8);
        for (const arrow of arrows) {
            if (!arrow.isValid) continue;
            await ctx.withTimeout(ctx.goTo(arrow.position, 1), 6000).catch(() => {});
        }
    }

    Object.assign(ctx, { hasBow, arrowCount, shoot, collectArrows, solveBowPitch: solvePitch });
}

module.exports = { installArchery };
