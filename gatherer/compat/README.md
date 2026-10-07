# Minecraft 26.3 support

The libraries the bot is built on (`minecraft-data`, `minecraft-protocol`,
`mineflayer`) support Minecraft up to **26.1** as of October 2026. This folder
adds **26.3** (protocol 777) so the bot can join 26.3 servers directly,
without ViaVersion/ViaBackwards on the server.

## What's here

- `26.3/`: generated data in minecraft-data's format: protocol, blocks
  (all 35,723 block states), collision shapes, items, entities, recipes, foods,
  materials, loot tables, particles, sounds.
- `build-26.3.js`: the generator that produced `26.3/`.
- `../lib/compat.js`: loads it at startup and adapts mineflayer to the
  26.2/26.3 packet changes.

## How it was built

All from public sources, nothing hand-typed from memory:

| Source | Used for |
|--------|----------|
| [minecraft-data](https://github.com/PrismarineJS/minecraft-data) branch `pc_26_2` | The hand-made 26.2 dataset and protocol (the starting point) |
| [ViaVersion](https://github.com/ViaVersion/ViaVersion) `protocols/v26_2to26_3` | Every 26.2 → 26.3 protocol change: packet ids, entity movement, chunk light masks, teleport confirmation, item components, particles, signs, advancements, game modes, command parsers, recipe displays |
| ViaVersion `identifiers-26.3.nbt` | Exact protocol order of blocks, items, entities, particles, sounds, item components and command parsers |
| [misode/mcmeta](https://github.com/misode/mcmeta) tag `26.3-summary` | Mojang's block property lists (to number every block state) and default item components |

New 26.3 blocks and items (the poplar wood set, wool and concrete stairs and
slabs, straw bed, red shrub, shelf mushroom, cushions) copy hardness, tool and
collision shape from the closest existing block (oak for poplar, oak or stone
stairs and slabs for shape, wool or concrete for hardness).

## Checks

- **Block numbering:** the same rule applied to 26.2 reproduces
  minecraft-data's 26.2 block-state IDs for all 1,196 blocks, with no
  mismatches. The 26.3 total (35,723 states) equals ViaVersion's.
- **Protocol:** every changed packet encodes and decodes correctly.
- **Live test:** against a minimal 26.3 test server, the bot logs in,
  spawns, confirms teleports in the new format, walks, digs with the new action
  codes, and swings with the new `punch` packet.

It has **not** been tested against a real Minecraft 26.3 server yet. If
something disconnects, the kick message in the console says which packet. Please
report it.

## Rebuilding

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/ViaVersion/ViaVersion
(cd ViaVersion && git sparse-checkout set common/src/main/resources/assets/viaversion/data common/src/main/java/com/viaversion/viaversion/protocols)
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/PrismarineJS/minecraft-data
(cd minecraft-data && git fetch --depth 1 origin pc_26_2 && mkdir -p ../md262 && for f in $(git ls-tree -r --name-only FETCH_HEAD data/pc/26.2); do git show FETCH_HEAD:$f > ../md262/$(basename $f); done)
mkdir mcmeta && (cd mcmeta && git init -q && git fetch --depth 1 https://github.com/misode/mcmeta refs/tags/26.3-summary && git checkout -q FETCH_HEAD)

node compat/build-26.3.js md262 ViaVersion mcmeta
```

Once minecraft-data publishes official 26.3 data, `lib/compat.js` steps aside
automatically: it only adds 26.3 if minecraft-data doesn't already have it.
