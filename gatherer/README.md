# Gatherer: LLM-free Minecraft bot

A small Minecraft bot that gets you the items you ask for. It mines, crafts,
smelts, farms, breeds and hunts as needed, and can brew potions. It also wears
armor, fights, eats, sleeps through the night and handles water. **It learns
from experience** and remembers what it learned between runs. It uses the same
Mineflayer libraries as Voyager, but nothing else:

- **No LLM / no API key.** Decisions come from Minecraft's own data tables
  (`minecraft-data`), a small cost-based search, and statistics the bot keeps
  about its own experience. To get you an iron pickaxe it works out logs →
  planks → sticks → crafting table → wooden pickaxe → cobblestone → stone
  pickaxe → furnace → raw iron → iron ingots.
- **No Python, no bundled Minecraft launcher, no 3D viewer.** One Node process
  that joins the world you're already playing in.
- **Light on resources.** About 150 MB RAM and under 15% of one CPU core in testing.
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

| Ability    | How                                                                                       |
|------------|-------------------------------------------------------------------------------------------|
| **Mine**   | Finds the nearest natural block that drops the item, digs to it, and picks up the drop. Goes back to places it remembers, or explores. |
| **Craft**  | Uses the game's recipe list. Gathers ingredients recursively and places a crafting table if none is nearby. |
| **Tools**  | If a block needs a better pickaxe than it has, it makes one first (wood → stone → iron). |
| **Smelt**  | Ores, sand → glass, cobblestone → stone, logs → charcoal, raw meat → cooked, etc. Builds a furnace and collects fuel (coal or planks) if needed. |
| **Farm**   | Harvests ripe wheat, carrots, potatoes and beetroots and replants them. If there's no field, it makes a hoe, gets seeds (wheat seeds from grass), tills up to `farmSize` plots next to water and plants them. It brings a bucket of water if there's none nearby. Then it waits for the crops to grow, using bone meal if it has any. |
| **Breed**  | Feeds pairs of adult cows, sheep, pigs, chickens, rabbits or goats the right food (wheat, carrots, seeds…), getting or growing the food first. |
| **Brew**   | Fills water bottles and runs them through a brewing stand: water → awkward → healing, swiftness, night vision, etc. Can make them long, strong or splash. |
| **Sleep**  | Sleeps in a nearby bed at night or in thunderstorms. `!sleep` makes and places a bed if needed (wool from sheep + planks). |
| **Water**  | Makes a bucket, fills it, and places water: for new farms, or under itself to put out fire. |
| **Hunt**   | Items that come from mobs (leather, beef, wool, feathers, string, bones…). It always leaves `keepAnimals` adults of each farm animal alive. It skips babies (no drops) and anything with a name tag. It never hunts pets, horses, villagers, golems or creepers. |
| **Armor**  | Wears the best armor it carries (leather → gold → chainmail → iron → diamond → netherite) and a shield in its off-hand. Upgrades as soon as it picks up something better. |
| **Fight**  | Fights hostile mobs that come within `defendRadius`, dealing with creepers and archers first. It times swings to the weapon's cooldown and picks its weapon by damage per second. It can land critical hits (jump and strike while falling) and blocks arrows with a shield while closing in. It backs off to eat (golden apples first) when health drops to `fleeHealth`. It runs from creepers and wardens and leaves endermen and piglins alone. |
| **Eat**    | Eats the best food it carries when hunger drops to `eatBelow`. If it has none and gets hungry (`findFoodBelow`), it gets the easiest food: meat, bread or carrots. |

Use `!plan <item>` to see what it would do without doing it:

```
!plan stone_pickaxe
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

## How it learns (no LLM)

It's plain statistics, saved to `memory.json` (one section per server):

| What it learns | How it uses it |
|----------------|----------------|
| **How long and how reliably each method works.** It times every mine, craft, smelt, farm, hunt, breed and brew, per item, and counts failures. | The planner swaps its built-in cost guesses for real ones. If mining iron keeps failing around here, it gets "expensive" and other options win. |
| **Where things are.** Every ~45 s it notes ores, logs, sand, clay, water, beds, stations and animals nearby, and anything it mines or hunts. | When nothing is in sight, it heads back to the nearest remembered spot instead of wandering. If the spot is empty, it forgets it. The planner also treats remembered resources as cheaper. |
| **Which way to explore.** When it has to wander, it picks one of 8 compass directions per item and area. | Directions that led to the resource score higher. It picks with UCB1: mostly the best so far, sometimes another to check. |
| **How to fight each mob.** Styles are `crit` (jump attacks), `fast` (swing on cooldown) and `kite` (hit and step back). Each is scored per mob and per weapon type by whether it won and how much damage it took. | Each new fight against that mob uses the best style so far (UCB1 again), so it settles on what works for your setup. |
| **Danger.** Where it died or took big damage (fades over a day). | It won't explore towards dangerous areas. |
| **Unreachable blocks.** Spots the pathfinder couldn't get to. | Skips them for 6 hours instead of retrying every time. |

`!learned` shows a summary and `!forget` wipes it. Set `"learn": false` to turn
learning off.

## Commands

In game chat, commands start with `!` and only the owner (`Zentyre` by default)
is obeyed. Whispers (`/msg Gatherer get oak_log`) and the terminal work with or
without the `!`.

| Command                          | What it does                                  |
|----------------------------------|-----------------------------------------------|
| `!get <item> [count]`            | Add a task to the queue and start (`!gather`, `!craft`, `!smelt` also work) |
| `!plan <item>`                   | Show how it would get the item, without doing it |
| `!farm`                          | Harvest and replant every ripe crop nearby    |
| `!plant <crop> [plots]`          | Till and plant a field: `wheat`, `carrot`, `potato` or `beetroot` |
| `!breed <animal> [pairs]`        | Breed `cow`, `mooshroom`, `sheep`, `goat`, `pig`, `chicken` or `rabbit` |
| `!brew <potion> [count] [mod]`   | Brew potions (default 3). `mod` is `long`, `strong`, `splash` or `lingering` |
| `!sleep`                         | Sleep now (makes and places a bed if needed)  |
| `!water`                         | Place a water source next to it               |
| `!bucket`                        | Get a filled water bucket                     |
| `!armor`                         | Put on the best armor it has and say what it's wearing |
| `!armor <material>`              | Get and wear a full set: `leather`, `golden`, `iron` or `diamond` |
| `!learned`                       | What it has learned so far                    |
| `!forget`                        | Erase everything it learned on this server   |
| `!stop`                          | Stop now (and wake up), clear the queue       |
| `!status` / `!queue`             | Show progress, health and food / queued tasks |
| `!inv`                           | List inventory                                |
| `!eat`                           | Eat now if hungry                             |
| `!come`                          | Walk to you (chat only)                       |
| `!deposit`                       | Put requested items in the configured chest   |
| `!home`                          | Return to where it spawned                    |
| `!help`                          | List commands                                 |
| `!quit`                          | Disconnect                                    |

Potions: `awkward`, `healing`, `swiftness`, `strength`, `night_vision`,
`fire_resistance`, `regeneration`, `water_breathing`, `leaping`,
`slow_falling`, `poison`, `turtle_master`, `weakness`, `invisibility`,
`harming`, `slowness`.

## Config

| Key                  | Default       | Meaning                                                          |
|----------------------|---------------|------------------------------------------------------------------|
| `host`, `port`       | `localhost`, `25565` | Server address                                            |
| `username`, `auth`   | `Gatherer`, `offline` | Bot account                                              |
| `version`            | `false`       | Minecraft version, `false` = auto-detect                          |
| `owner`              | `"Zentyre"`   | Only take commands from this player (`null` = anyone)             |
| `commandPrefix`      | `"!"`         | Chat commands must start with this                                |
| `viewDistance`       | `"tiny"`      | Chunks requested from server, lower = less RAM                    |
| `searchRadius`       | `48`          | How far (blocks) to look for resources and mobs                   |
| `stationRadius`      | `24`          | Reuse a crafting table / furnace / bed within this distance       |
| `exploreDistance`    | `64`          | How far to wander when nothing is in range                        |
| `maxExploreAttempts` | `8`           | Give up on an item after this many fruitless wanders              |
| `chest`              | `null`        | `{ "x": 0, "y": 64, "z": 0 }`: where to unload when full / done   |
| `protectRadius`      | `0`           | Never dig within this many blocks of the spawn point or chest     |
| `extraMineable`      | `[]`          | Extra block names it may mine besides natural ones                |
| `hunt`               | `true`        | Allow hunting mobs for drops and food                             |
| `keepAnimals`        | `2`           | Never hunt the last this-many adults of a farm animal nearby      |
| `defend`             | `true`        | Fight back against hostile mobs                                   |
| `defendRadius`       | `8`           | How close a hostile mob must be before it reacts                  |
| `fleeHealth`         | `6`           | Back off and eat at or below this health (of 20)                  |
| `useShield`          | `true`        | Block with a shield while closing in on archers                   |
| `autoArmor`          | `true`        | Wear the best armor and shield it carries                         |
| `eatBelow`           | `14`          | Eat when hunger is at or below this (of 20)                       |
| `findFoodBelow`      | `8`           | Go get food when hungry with nothing to eat                       |
| `autoSleep`          | `true`        | Sleep at night if a bed is nearby                                 |
| `bringBed`           | `false`       | At night, make and place a bed if none is nearby                  |
| `farm`               | `true`        | Allow farming for crops                                           |
| `farmSize`           | `9`           | How many plots to till and plant when starting a field            |
| `farmWaitMinutes`    | `30`          | Give up waiting for crops to grow after this long                 |
| `placeWater`         | `true`        | Bring water in a bucket to start a farm where there's none        |
| `learn`              | `true`        | Learn from experience and remember places                         |
| `memoryFile`         | `"memory.json"` | Where learned data is saved                                     |
| `memoryRange`        | `400`         | How far away remembered places are worth travelling to            |
| `returnHome`         | `true`        | Walk back to the spawn point after the queue is done              |
| `quitWhenDone`       | `false`       | Disconnect when the queue is done                                 |
| `chatter`            | `true`        | Post progress messages in game chat                               |
| `tasks`              | `[]`          | `[{ "item": "oak_log", "count": 32 }, …]`                         |

## Safety and limits

- It only mines blocks that generate naturally (stone, ores, logs, dirt, sand…).
  It won't take your house apart for planks or glass, or dig up your chests.
  But a cabin built from logs or cobblestone looks the same as natural blocks.
  Set `protectRadius` to keep it away from your base.
- When the pathfinder digs its way somewhere, it never breaks farmland,
  crops, chests, furnaces, crafting tables, beds, doors, glass or torches.
- It leaves `keepAnimals` adults of each kind and skips name-tagged animals.
  It still can't tell your pens from wild herds, so turn `hunt` off if that matters.
- **Brewing needs Nether items.** Nether wart and blaze powder only come from the
  Nether, which the bot doesn't visit. Give it those and it handles the rest
  (bottles, glass, brewing stand, melon slices, spider eyes, sugar…). Weakness
  needs no nether wart, but still needs blaze powder as fuel.
- Carrots and potatoes can't be found in the wild, so it needs at least one
  to start a field. Crops take 5–30 minutes to grow and the bot stays nearby.
- It can't get items that only come from trading or the Nether/End, and it
  doesn't enchant, build, or use bows. `!plan` will say "no known way to get this".
- Combat is better but not great, and it can still die. Use
  `/gamerule keepInventory true` if that matters.
- Learning needs repetition: a few runs of a task before timings settle, a few
  fights per mob type and weapon before a style clearly wins.

## Code layout

| File                | Role                                                      |
|---------------------|-----------------------------------------------------------|
| `gatherer.js`       | Config, connection, task queue, commands                  |
| `lib/knowledge.js`  | Lookup tables: drops, recipes, smelting, crops, breeding food, potions, fuel, food, mobs |
| `lib/planner.js`    | Cost-based choice between mine / craft / smelt / farm / hunt |
| `lib/learning.js`   | Experience statistics, place memory, bandits, danger map, saving |
| `lib/actions.js`    | Mining, crafting, smelting, hunting, exploring, chests    |
| `lib/combat.js`     | Weapons, armor, melee styles, shield, fleeing, fire       |
| `lib/survival.js`   | When to fight, eat and sleep                              |
| `lib/farming.js`    | Harvesting, replanting, planting new fields               |
| `lib/animals.js`    | Breeding, babies, name tags, keeping herds alive          |
| `lib/water.js`      | Buckets and placing water                                 |
| `lib/brewing.js`    | Water bottles and the brewing stand                       |
| `lib/context.js`    | Shared state and helpers                                  |
