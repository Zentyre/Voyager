// Spreading a crew out over a job it shares ("!get oak_log 64" between
// three bots). Each one used to go for the nearest of it that nobody had
// claimed, and starting from the same place they all went to the same
// spot, taking the blocks side by side, and on to the same remembered
// places when exploring.
//
// Now each takes its own slice of the compass round where it was when the
// job started (two bots: the north and south halves; three: a third each;
// four: a quarter, ...), and goes for the nearest in its slice: anything
// outside it counts as further away (40 blocks, more the further round it
// is), so it only goes there when its own side is much further or empty;
// and towards the edge of its side, a little further (up to 8 blocks).
// Anything within 10 blocks of what another bot is going for counts as 30
// blocks further too (crew or not), so they don't bunch up even then. When
// it has to look further afield, it explores its own side first.

const NAMES = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

function compassName(angle) {
    const i = Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
    return NAMES[i];
}

// Bot `index` of `size`: which way it heads (radians, 0 = north, clockwise).
const headingFor = (index, size) => (2 * Math.PI * index) / size;

function installSpread(ctx) {
    const { bot } = ctx;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

    // The job's team: { names, index, size, origin, heading, half }, or null.
    let team = null;
    ctx.joinTeam = (t) => {
        team = null;
        if (!t || !(t.size > 1) || !bot.entity) return;
        const heading = headingFor(t.index, t.size);
        team = { ...t, origin: bot.entity.position.clone(), heading, half: Math.PI / t.size };
        const others = (t.names || []).filter((n) => n !== bot.username);
        ctx.log(`Sharing this with ${others.join(", ") || "the crew"}: I'll take the ${compassName(heading)} side.`);
    };
    ctx.leaveTeam = () => (team = null);

    // How far round from its heading `pos` is, seen from where the job
    // started (radians); null when there's no team or it's too close to tell.
    function offHeading(pos) {
        if (!team) return null;
        const dx = pos.x - team.origin.x, dz = pos.z - team.origin.z;
        if (Math.hypot(dx, dz) < 6) return null;
        return Math.abs(wrap(Math.atan2(dx, -dz) - team.heading));
    }
    // An explore direction (radians) on its side (a compass point either side counts).
    ctx.headingOnMySide = (angle) => !team || Math.abs(wrap(angle - team.heading)) <= team.half + Math.PI / 8 + 1e-9;

    // Where the rest of the crew is going: the blocks they've claimed.
    function othersAt() {
        const out = [];
        for (const c of ctx.crew?.claimed?.("block:") || []) {
            if (c.owner === ctx.crew.name) continue;
            const m = /\((-?\d+), (-?\d+), (-?\d+)\)/.exec(c.key);
            if (m) out.push({ x: +m[1], y: +m[2], z: +m[3] });
        }
        return out;
    }

    // What going for something at `pos` costs on top of the walk (in blocks).
    ctx.spreadCost = (pos) => {
        if (!pos) return 0;
        let cost = 0;
        const off = offHeading(pos);
        if (off !== null) cost += off > team.half ? 40 + 30 * (off - team.half) : 8 * (off / team.half); // (the middle of its side first)
        if (othersAt().some((o) => Math.abs(o.x - pos.x) <= 10 && Math.abs(o.z - pos.z) <= 10 && Math.abs(o.y - pos.y) <= 10)) cost += 30;
        return cost;
    };
}

module.exports = { installSpread, headingFor, compassName };
