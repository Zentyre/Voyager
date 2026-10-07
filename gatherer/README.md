# Gatherer: LLM-free Minecraft bot

A small Minecraft bot that gets you the items you ask for. It mines, crafts,
smelts and hunts as needed, fights off mobs and eats when hungry. It uses the
same Mineflayer libraries as Voyager, but nothing else:

- **No LLM / no API key.** Decisions come from Minecraft's own data tables
  (`minecraft-data`) plus a small cost-based search. To get you an iron pickaxe it
  works out logs → planks → sticks → crafting table → wooden pickaxe →
  cobblestone → stone pickaxe → furnace → raw iron → iron ingots.
- **No Python, no bundled Minecraft launcher, no 3D viewer.** One Node process
  that joins the world you're already playing in.
- **Light on resources.** About 150 MB RAM and a fraction of one CPU core in testing.
  It asks the server for a "tiny" view distance and caps pathfinding time per tick.

## Setup

Requires Node.js ≥ 22.

```
cd gatherer
npm install
cp config.example.json config.json   # then edit it
```

Open your world to LAN (or use a server) and set `host`/`port` in `config.json`.
For a LAN world the port is printed in chat when you open it. The default
`"auth": "offline"` works for LAN worlds and offline-mode servers. Use
`"microsoft"` for online-mode servers (you'll be prompted to sign in once).

## Running

```
npm start                                  # runs the tasks in config.json
node gatherer.js oak_log:64 iron_pickaxe:1 # or pass tasks on the command line
node gatherer.js --config other.json torch:32
```

Use item names as they appear in `/give`: `raw_iron`, `iron_ingot`,
`cobblestone`, `oak_log`, `torch`, `furnace`, `leather`, `cooked_beef`, …

## What it can do

| Ability   | How                                                                                       |
|-----------|-------------------------------------------------------------------------------------------|
| **Mine**  | Finds the nearest natural block that drops the item, digs to it, and picks up the drop. Explores if none are in range. |
| **Craft** | Uses the game's recipe list. Gathers ingredients recursively and places a crafting table if none is nearby. |
| **Tools** | If a block needs a better pickaxe than it has, it makes one first (wood → stone → iron).    |
| **Smelt** | Ores, sand → glass, cobblestone → stone, logs → charcoal, raw meat → cooked, etc. Builds and places a furnace and collects fuel (coal or planks) if needed. |
| **Hunt**  | Items that come from mobs (leather, beef, wool, feathers, string, bones…). It hunts cows, pigs, sheep, chickens, rabbits, goats, spiders, zombies, skeletons and slimes. It never hunts pets, horses, villagers, golems or creepers. |
| **Fight** | Attacks hostile mobs that come within `defendRadius`. Runs from creepers, and runs from anything when health drops to `fleeHealth`. Leaves endermen and piglins alone. |
| **Eat**   | Eats the best food it carries when hunger drops to `eatBelow`. If it has none and gets hungry (`findFoodBelow`), it hunts an animal for meat. |

Use `plan <item>` to see what it would do without doing it:

```
plan stone_pickaxe
stone_pickaxe: craft from 3 cobblestone, 2 stick (crafting table)
  crafting_table: craft from 4 birch_planks
    birch_planks: craft from 1 birch_log
      birch_log: mine birch_log
  cobblestone: mine stone
    wooden_pickaxe: craft from 3 birch_planks, 2 stick (crafting table)
    ...
```

The plan adapts to your inventory and surroundings. It uses birch if birch trees
are what's nearby, skips steps for things it already has, and reuses a crafting
table or furnace within `stationRadius`.

## Commands

Type these in game chat (only `owner` is obeyed if set) or in the terminal:

| Command                 | What it does                                  |
|-------------------------|-----------------------------------------------|
| `get <item> [count]`    | Add a task to the queue and start (`gather`, `craft`, `smelt` also work) |
| `plan <item>`           | Show how it would get the item, without doing it |
| `stop`                  | Stop now and clear the queue                  |
| `status` / `queue`      | Show progress, health and food / queued tasks |
| `inv`                   | List inventory                                |
| `eat`                   | Eat now if hungry                             |
| `come`                  | Walk to you (chat only)                       |
| `deposit`               | Put requested items in the configured chest   |
| `home`                  | Return to where it spawned                    |
| `quit`                  | Disconnect                                    |

## Config

| Key                  | Default       | Meaning                                                          |
|----------------------|---------------|------------------------------------------------------------------|
| `host`, `port`       | `localhost`, `25565` | Server address                                            |
| `username`, `auth`   | `Gatherer`, `offline` | Bot account                                              |
| `version`            | `false`       | Minecraft version, `false` = auto-detect                          |
| `owner`              | `null`        | Only take chat commands from this player                          |
| `viewDistance`       | `"tiny"`      | Chunks requested from server, lower = less RAM                    |
| `searchRadius`       | `48`          | How far (blocks) to look for resources and mobs                   |
| `stationRadius`      | `24`          | Reuse a crafting table / furnace within this distance             |
| `exploreDistance`    | `64`          | How far to wander when nothing is in range                        |
| `maxExploreAttempts` | `8`           | Give up on an item after this many fruitless wanders              |
| `chest`              | `null`        | `{ "x": 0, "y": 64, "z": 0 }`: where to unload when full / done   |
| `protectRadius`      | `0`           | Never dig within this many blocks of the spawn point or chest     |
| `extraMineable`      | `[]`          | Extra block names it may mine besides natural ones                |
| `hunt`               | `true`        | Allow hunting mobs for drops and food                             |
| `defend`             | `true`        | Fight back against hostile mobs                                   |
| `defendRadius`       | `8`           | How close a hostile mob must be before it reacts                  |
| `fleeHealth`         | `6`           | Run away instead of fighting at or below this health (of 20)      |
| `eatBelow`           | `14`          | Eat when hunger is at or below this (of 20)                       |
| `findFoodBelow`      | `8`           | Go hunting for food when hungry with nothing to eat               |
| `returnHome`         | `true`        | Walk back to the spawn point after the queue is done              |
| `quitWhenDone`       | `false`       | Disconnect when the queue is done                                 |
| `chatter`            | `true`        | Post progress messages in game chat                               |
| `tasks`              | `[]`          | `[{ "item": "oak_log", "count": 32 }, …]`                         |

## Safety and limits

- It only mines blocks that generate naturally (stone, ores, logs, dirt, sand…).
  It won't take your house apart for planks or glass, or dig up your chests.
  But a cabin built from logs or cobblestone looks the same as natural blocks.
  Set `protectRadius` to keep it away from your base.
- It can't tell farm animals from wild ones. Turn `hunt` off if your pens are within `searchRadius`.
- It can't craft items whose ingredients only come from farming (bread, cake…),
  trading, or the Nether/End. `plan` will say "no known way to get this".
- It can't brew, enchant, build, or put on armour. Its melee combat is simple
  and it can still die, so keep valuables out of its inventory or use
  `/gamerule keepInventory true`.

## Code layout

| File                | Role                                                      |
|---------------------|-----------------------------------------------------------|
| `gatherer.js`       | Config, connection, task queue, commands                  |
| `lib/knowledge.js`  | Lookup tables: drops, recipes, smelting, fuel, food, mobs |
| `lib/planner.js`    | Cost-based choice between mine / craft / smelt / hunt     |
| `lib/actions.js`    | Doing it: mining, crafting, smelting, hunting, chests     |
| `lib/survival.js`   | Fighting, fleeing, eating                                 |
| `lib/context.js`    | Shared state and helpers                                  |
