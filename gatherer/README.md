# Gatherer: LLM-free Minecraft bot

A small Minecraft bot that gets you the items you ask for. It mines, crafts,
smelts, farms, breeds and hunts as needed, and can brew potions. It also wears
armor, fights with sword or bow, can act as a bodyguard, eats, sleeps through
the night and handles water. **It learns
from experience** and remembers what it learned between runs. It uses the same
Mineflayer libraries as Voyager, but nothing else:

- **No LLM / no API key.** Decisions come from Minecraft's own data tables
  (`minecraft-data`), a small cost-based search, and statistics the bot keeps
  about its own experience. To get you an iron pickaxe it works out logs →
  planks → sticks → crafting table → wooden pickaxe → cobblestone → stone
  pickaxe → furnace → raw iron → iron ingots.
- **No Python, no bundled Minecraft launcher, no 3D viewer.** One Node process
  that joins the world you're already playing in.
- **Light on resources.** About 150–300 MB RAM per bot and a fraction of a CPU
  core. It caps pathfinding time per tick.
- **One bot or a crew.** Run several bots that work separately or together:
  they split jobs, share what they learn, and stay out of each other's way.

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
node gatherer.js --bot Miner               # only this bot from "bots" (or --bot Miner,Farmer)
```

Use item names as they appear in `/give`: `raw_iron`, `iron_ingot`,
`cobblestone`, `oak_log`, `torch`, `furnace`, `leather`, `cooked_beef`, …

## Accounts (online-mode servers)

On a server with `online-mode=true` every bot needs **its own Minecraft Java
Edition account** (a Microsoft account that owns the game). One account can't
be online twice, so a bot can't share your account while you're playing.

1. **Get one account per bot.** For four bots, that's four Microsoft accounts,
   each with Java Edition.
2. **Make your config:** `cp config.online.example.json config.json`, then set
   `host` and `port`. The `username` values (`Miner`, `Farmer`, `Hunter`,
   `Guard`) are just labels for each saved login. In game, each bot uses its
   account's name. You can address it by either: `!Miner status`, or its in-game name.
3. **Sign each bot in once:** run `npm start`. The bots start one at a time, and
   each new one prints:

   ```
   ===== Sign in the Minecraft account for bot "Miner": open https://www.microsoft.com/link and enter code ABCD1234 (expires in 15 min). =====
   ```

   Open the link on any device, enter the code, and sign in with **that bot's**
   Microsoft account. Use a private/incognito window so you don't sign in as
   yourself by accident. The next bot's code appears once the first has joined.
4. **That's it.** Logins are saved in `gatherer/accounts/` and renew
   themselves, so later starts need no codes. To switch a bot to another
   account, delete its files in `accounts/` and sign in again.

Keep `accounts/` private: it holds login tokens. It's in `.gitignore`, so it
never gets committed. Never put passwords in the config. Sign-in always goes
through Microsoft's page.

**Server side:**
- If you use a whitelist, add each bot by its in-game name (`/whitelist add <name>`).
- Don't op the bots; they don't need it.
- Set `view-distance` in `server.properties` to 10 or more so they can see
  as far as `"normal"` asks for.
- With `online-mode=true`, names are verified, so only the real Zentyre can
  command the bots.

**Minecraft 26.3:** the libraries the bot uses only go up to 26.1, so the bot
ships its own 26.3 support (`compat/`). It connects to 26.3 servers directly, with
no ViaVersion needed. See [compat/README.md](compat/README.md) for how it was built
and tested. For anything newer than 26.3, the bot connects as the newest version
it knows and tells you; ViaVersion + ViaBackwards on the server can bridge the gap.

**Modded servers (Fabric, NeoForge):** the bot can't load mods; they are Java
code for the real game client. It joins as a vanilla client, so the server must
let vanilla clients in. Blocks added by mods are treated as solid blocks the bot
never breaks, and after joining it lists the mods the server announces
(`Server: fabric. Mods it announces: ...`).

On a LAN world or an `online-mode=false` server, leave `"auth": "offline"` and
any names work with no accounts. Anyone can then join as any name, including
yours, though.

## Crews: several bots at once

List bots under `"bots"` in `config.json`. Everything else in the file is shared,
and each entry can override any setting (its own `tasks`, `defendRadius`…). See
`config.crew.example.json`:

```json
{
    "host": "localhost", "port": 25565, "owner": "Zentyre",
    "bots": [
        { "username": "Miner" },
        { "username": "Farmer", "tasks": [{ "item": "wheat", "count": 32 }] },
        { "username": "Guard", "defendRadius": 12 }
    ]
}
```

`npm start` then launches all of them in one process. Each bot runs in its own
worker thread, so each gets its own CPU core. Logins are spaced 3 s apart, and a
bot that gets kicked or disconnected rejoins by itself (`"reconnect": false`
turns that off).

**Working separately:** put the bot's name after the prefix and only that bot
listens:

```
!Miner get iron_ingot 8
!Farmer plant wheat 16
!Guard guard
```

**Working together:** commands without a name go to the crew:

| Command | What the crew does |
|---------|--------------------|
| `!get <item> <count>` (also gather/craft/smelt) | Splits the count between the bots that are free (all bots if none are free). `!get oak_log 64` with two idle bots → 32 each. |
| `!come`, `!stop`, `!quit`, `!status`, `!inv`, `!home`, `!guard`, `!eat`, `!sleep`, `!deposit`, `!give`, `!armor`, `!bow`, `!forget` | Every bot does it: e.g. `!guard` gives you a squad of bodyguards, `!give oak_log` has each bot bring you its logs. Bots with nothing to add stay quiet. |
| `!plan`, `!farm`, `!plant`, `!breed`, `!brew`, `!water`, `!bucket`, `!learned`, `!help` | One bot does it: a free one if there is one. |
| `!crew` | Lists the bots and whether each is idle, busy or offline. |
| `!all <command>` | Sends any command to every bot. |

While working together they:

- **Share what they learn.** Places, timings, failure rates, fighting styles,
  aim corrections, danger spots and unreachable blocks all reach every bot as
  they happen, so iron one bot finds is known to all.
- **Don't get in each other's way.** Each bot claims the block, crop or mob it's
  going for, and the others pick a different one.
- **Spread out when exploring.** Each bot takes a different direction.
- **Leave each other alone.** Bots ignore each other's chat and never treat a
  crewmate as an attacker.

The terminal takes the same commands without the `!`: `Miner status`,
`all come`, `get dirt 10`, `crew`.

You can also run bots as completely separate processes, each with its own config
(`node gatherer.js --config miner.json`). They then work independently and don't
coordinate. Each keeps its own memory file (`memory/<username>.json`) either way.

## What it can do

| Ability    | How                                                                                       |
|------------|-------------------------------------------------------------------------------------------|
| **Mine**   | Finds the nearest natural block that drops the item, digs to it, and picks up the drop. Goes back to places it remembers, or explores. Prefers blocks near its own height. For one out of reach overhead (a treetop), it gets dirt, builds a pillar up, takes what's in reach, knocks drops off the leaves, and digs the pillar back down. Gives up on any block after a time limit and moves on. |
| **Craft**  | Uses the game's recipe list. Gathers ingredients recursively and places a crafting table if none is nearby. |
| **Tools**  | If a block needs a better pickaxe than it has, it makes one first (wood → stone → iron). |
| **Smelt**  | Ores, sand → glass, cobblestone → stone, logs → charcoal, raw meat → cooked, etc. Builds a furnace and collects fuel (coal or planks) if needed. |
| **Farm**   | Harvests ripe wheat, carrots, potatoes and beetroots and replants them. If there's no field, it makes a hoe, gets seeds (wheat seeds from grass), tills up to `farmSize` plots next to water and plants them. It brings a bucket of water if there's none nearby. Then it waits for the crops to grow, using bone meal if it has any. |
| **Breed**  | Feeds pairs of adult cows, sheep, pigs, chickens, rabbits or goats the right food (wheat, carrots, seeds…), getting or growing the food first. |
| **Brew**   | Fills water bottles and runs them through a brewing stand: water → awkward → healing, swiftness, night vision, etc. Can make them long, strong or splash. |
| **Sleep**  | Sleeps in a nearby bed at night or in thunderstorms. `!sleep` makes and places a bed if needed (wool from sheep + planks). |
| **Water**  | Makes a bucket, fills it, and places water: for new farms, or under itself to put out fire. |
| **Hunt**   | Items that come from mobs (leather, beef, wool, feathers, string, bones…). Animals always get critical hits (it stops sprinting, jumps, and hits on the way down). It always leaves `keepAnimals` adults of each farm animal alive. It skips babies (no drops) and anything with a name tag. It never hunts pets, horses, villagers, golems or creepers. |
| **Armor**  | Wears the best armor it carries (leather → gold → chainmail → iron → diamond → netherite) and a shield in its off-hand. Upgrades as soon as it picks up something better. |
| **Fight**  | Fights hostile mobs that come within `defendRadius`, dealing with creepers and archers first. It times swings to the weapon's cooldown and picks its weapon by damage per second. It can land critical hits (jump and strike while falling) and blocks arrows with a shield while closing in. It backs off to eat (golden apples first) when health drops to `fleeHealth`. It runs from creepers and wardens and leaves endermen and piglins alone. |
| **Bow**    | Shoots with a bow when it has one and arrows: always for creepers (before they get close) and for anything more than 10 blocks away, otherwise when the learner rates it best. It works out the arc from arrow speed, drag and gravity, and leads moving targets. It keeps 7–24 blocks away and switches to its sword if something closes within 4. It walks closer when a wall blocks the shot, and picks its arrows back up afterwards. `!bow` makes a bow and arrows (string from spiders, arrows from skeletons or flint + feathers). |
| **Bodyguard** | `!guard <player>` follows that player and fights anything that threatens them. It goes for whatever hurts them first (the server reports the attacker on 1.20+), then hostile mobs within `guardRadius` of them. It uses the bow for far threats, never strays more than `guardRadius + 8` blocks during a fight, and keeps eating and wearing armor. It won't sleep or wander off for food while on duty. |
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
| **How to fight each mob.** Styles are `crit` (jump attacks), `fast` (swing on cooldown), `kite` (hit and step back) and `bow` (when it has one). Each is scored per mob and per weapon (fist, sword, axe, with or without a bow) by whether it won and how much damage it took. | Each new fight against that mob uses the best style so far (UCB1 again), so it settles on what works for your setup. |
| **Its own aim.** After each arrow it watches where the arrow actually flew, and how far above or below the target it passed. | It keeps a running correction for each distance (0–10, 10–20, 20–30, 30–40, 40+ blocks) and aims that much lower or higher next time. `!learned` shows the corrections and the hit rate. |
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
| `!guard [player]`                | Bodyguard a player (you, if no name). `!stop` dismisses it. Also `!bodyguard`, `!protect` |
| `!give [item\|all] [count]`      | Walk to you and drop items (`all` = everything except its tools, armor, weapons and arrows) |
| `!bow [arrows]`                  | Get a bow and arrows (16 by default) to use in fights |
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
| `viewDistance`       | `"normal"`    | Chunks requested from the server: `tiny` 6, `short` 8, `normal` 10, `far` 12. More = sees further, more RAM. Capped by the server's own view-distance |
| `searchRadius`       | `110`         | How far (blocks) to look for resources and mobs (keep under view distance × 16) |
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
| `useBow`             | `true`        | Use a bow and arrows in fights when it has them                   |
| `bowRange`           | `24`          | Furthest it likes to shoot from (it closes in beyond this)        |
| `guardRadius`        | `12`          | Bodyguard: attack hostile mobs this close to the player           |
| `followDistance`     | `3`           | Bodyguard: how close it stays to the player                       |
| `guardAgainstPlayers`| `false`       | Bodyguard: also fight *players* who hurt the person it guards     |
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
| `memoryFile`         | `memory/<username>.json` | Where learned data is saved                            |
| `memoryRange`        | `400`         | How far away remembered places are worth travelling to            |
| `returnHome`         | `true`        | Walk back to the spawn point after the queue is done              |
| `quitWhenDone`       | `false`       | Disconnect when the queue is done                                 |
| `chatter`            | `true`        | Post progress messages in game chat                               |
| `tasks`              | `[]`          | `[{ "item": "oak_log", "count": 32 }, …]`                         |
| `bots`               | `[]`          | Crew members: `[{ "username": "Miner" }, …]`, each may override any setting |
| `reconnect`          | `true`        | Crew: rejoin automatically after being kicked or disconnected     |

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
  doesn't enchant, build, or use crossbows or tridents. `!plan` will say "no
  known way to get this".
- The bodyguard can only follow someone it can see (within the server's view
  distance) and can't teleport. If you run off, it waits and picks up again
  when you come back.
- Combat is better but not great, and it can still die. Use
  `/gamerule keepInventory true` if that matters.
- Learning needs repetition: a few runs of a task before timings settle, a few
  fights per mob type and weapon before a style clearly wins.

## Code layout

| File                | Role                                                      |
|---------------------|-----------------------------------------------------------|
| `gatherer.js`       | Entry point: one bot, or a crew                           |
| `lib/config.js`     | Defaults, config file, per-bot settings                   |
| `lib/bot.js`        | One bot: connection, task queue, commands                 |
| `lib/crew.js`       | Crew coordinator (main thread) and its link to each bot   |
| `lib/crew-worker.js`| Worker-thread entry point for a crew member               |
| `lib/compat.js`     | Minecraft 26.3 support: registers `compat/26.3` data, adapts packets |
| `lib/mods.js`       | Modded servers: unknown modded blocks, list of the server's mods |
| `compat/`           | Generated 26.3 data and the script that builds it         |
| `lib/knowledge.js`  | Lookup tables: drops, recipes, smelting, crops, breeding food, potions, fuel, food, mobs |
| `lib/planner.js`    | Cost-based choice between mine / craft / smelt / farm / hunt |
| `lib/learning.js`   | Experience statistics, place memory, bandits, danger map, saving |
| `lib/actions.js`    | Mining, crafting, smelting, hunting, exploring, chests    |
| `lib/combat.js`     | Weapons, armor, melee styles, shield, fleeing, fire       |
| `lib/archery.js`    | Bow aiming, shooting, learned aim correction, arrow pickup |
| `lib/bodyguard.js`  | Following and protecting a player                         |
| `lib/survival.js`   | When to fight, eat and sleep                              |
| `lib/farming.js`    | Harvesting, replanting, planting new fields               |
| `lib/animals.js`    | Breeding, babies, name tags, keeping herds alive          |
| `lib/water.js`      | Buckets and placing water                                 |
| `lib/brewing.js`    | Water bottles and the brewing stand                       |
| `lib/context.js`    | Shared state and helpers                                  |
