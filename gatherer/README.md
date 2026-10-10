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

### Without a terminal (Windows)

Double-click **`Start Dashboard.vbs`** in the `gatherer` folder. It starts
Gatherer in the background and opens the dashboard
(http://localhost:3000) in your browser. From there:

- **Start** / **Stop** each bot (or **Start all** / **Stop all**). A bot that
  needs a Microsoft sign-in shows the code and link right on its card.
- **Update** downloads the latest version; **Restart** then runs it, and starts
  the bots that were running again. If it can't, it keeps running and says why.
- **Shut down** disconnects every bot and closes Gatherer.

Opening the launcher again while Gatherer is running just opens the
dashboard. Output is saved to `logs/gatherer.log`.

To start some bots right away, add `"autoStart": ["Miner"]` (or
`"autoStart": true` for all) to `config.json`. For an icon, right-click the
launcher → *Show more options* → *Send to* → *Desktop (create shortcut)*. To start
Gatherer with Windows, put that shortcut in the folder that opens with
**Win+R** → `shell:startup`.

You still edit `config.json` with Notepad (right-click → *Open with*).

### From a terminal

```
npm start                                  # runs the tasks in config.json
node gatherer.js oak_log:64 iron_pickaxe:1 # or pass tasks on the command line
node gatherer.js --config other.json torch:32
node gatherer.js --bot Miner               # only this bot from "bots" (or --bot Miner,Farmer)
```

Use item names as they appear in `/give`: `raw_iron`, `iron_ingot`,
`cobblestone`, `oak_log`, `torch`, `furnace`, `leather`, `cooked_beef`, …

### Dashboard

While the bots run, open **http://localhost:3000** in a browser on the same
computer. You get a card per bot with:
- its head (from its skin), health, food, position (click to copy), what it's
  holding and wearing, its level, its kills and deaths on this server, inventory;
- **Now**: the step it's on ("Walking to the crafting table", "Crafting 4 oak
  planks", "Fighting a zombie") and for how long, with what that step is for
  underneath ("for 3 diamond › 1 iron pickaxe › 3 iron ingot");
- the current task with a progress bar, and the queue;
- a "Get item" box with item-name suggestions, and buttons for status,
  inventory, eat, sleep, home, deposit, armor and stop;
- **All commands** (opens under the card): a button for every command, with
  dropdowns and boxes for the ones that take options (plan, plant, breed,
  brew, armor set, guard, bow, give, say). "Come to me", "Give me" and
  "Guard" with no name act on the owner.

The **World** panel shows the in-game day, time and weather, everyone online
(with their heads, ping, and how far they are from the nearest bot that can
see them), and a map: the bots (facing which way), the players they can see,
and their homes. Hover for coordinates; click a bot to jump to its card.
Skins come from Mojang's texture server, fetched by Gatherer itself.

**Alerts** (top bar) turns on desktop notifications for while the tab is in
the background: a bot died, finished its tasks, gave up on one, got badly
hurt, disconnected, or needs a Microsoft sign-in.

The bar at the top sends any command (the same ones as in chat, without the
`!`) to one bot, all bots, or the crew (which splits gathering jobs). The
Activity panel on the right shows what each bot is doing, live.

It only accepts connections from this computer. To open it from your phone
on the same Wi-Fi, set `"dashboard": { "port": 3000, "host": "0.0.0.0" }` in
`config.json`: the console then prints a link with an access token. Anyone
with that link can command the bots, so don't share it. `"dashboard": false`
turns it off.

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

**How long a login lasts:** Microsoft hands out a new long-term token (good
for about 90 days) every time the bot signs in, so a bot that runs at least
once every few months stays signed in for good. It only asks again if the
account's password changes, the login is removed from the Microsoft account,
or the bot goes unused for that long. The bot also guards the saved login:
- Files are saved whole (never half-written if the program stops or restarts
  mid-save), and the previous copy is kept as a `.bak`. A damaged file is
  set aside (`.damaged`) and the backup used, instead of being wiped.
- If Microsoft can't be reached when it starts (no network yet just after the
  PC boots, say), it keeps trying for 5 minutes (`Couldn't reach Microsoft to
  refresh the saved login …; trying again in 10 s`) instead of asking you to
  sign in. If it does ask, the log says why (`Microsoft no longer accepts the
  saved login (…)`).

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
It also fixes enchanted items for the libraries: they read an item's
enchantments the pre-1.20.5 way, so an enchanted tool couldn't dig at all
("enchantments.concat is not a function"). Enchantments are named from the
server's own list, so ones added by mods don't shift the vanilla ones.

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
| `!get <item> <count>` (also gather/craft/smelt) | Splits the count between the bots that are free (all bots if none are free), and sends each a different way: `!get oak_log 64` with two idle bots → 32 each, one to the north side and one to the south ("Splitting 64 oak_log: Alpha 32 (north), Bravo 32 (south)"); four bots take north, east, south and west. |
| `!come`, `!stop`, `!quit`, `!status`, `!inv`, `!home`, `!guard`, `!spin`, `!setchest`, `!eat`, `!sleep`, `!deposit`, `!give`, `!armor`, `!bow`, `!forget` | Every bot does it: e.g. `!guard` gives you a squad of bodyguards, `!give oak_log` has each bot bring you its logs. Bots with nothing to add stay quiet. |
| `!plan`, `!farm`, `!plant`, `!breed`, `!brew`, `!water`, `!bucket`, `!learned`, `!help` | One bot does it: a free one if there is one. |
| `!crew` | Lists the bots and whether each is idle, busy or offline. |
| `!all <command>` | Sends any command to every bot. |

While working together they:

- **Share what they learn.** Places, timings, failure rates, fighting styles,
  aim corrections, danger spots and unreachable blocks all reach every bot as
  they happen, so iron one bot finds is known to all.
- **Don't get in each other's way.** Each bot claims the block, crop or mob it's
  going for, and the others pick a different one, away from it (anything within
  10 blocks of where another bot is going counts as 30 blocks further).
- **Spread out on a shared job.** Each takes its own side of the compass from
  where it started and goes for the nearest there, middle of its side first.
  Something on another bot's side counts as at least 40 blocks further, so it
  only goes there when its own side is much further or has none. Exploring and
  heading back to remembered places, it takes its own side first too.
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
| **Run**    | Sprint-jumps on straight, flat stretches when it travels, as players do: about 7 blocks a second instead of 5.6 (a 69-block run took 10.0 s instead of 12.3). Only where it's safe: level ground, nothing to dig or place, room above its head, not on ice or slime, lined up with its path. `"sprintJump": false` turns it off (it uses a little more food). |
| **Climb**  | Out of holes and up cliffs, it does whichever is quicker: dig a staircase, put blocks under itself (dirt or cobblestone), or walk round. Underground (no daylight overhead), heading back up to the surface, it tunnels straight up with a block under itself at each step instead of a staircase (one block dug a step, not three); it leaves that to the pathfinder next to water, lava or gravel, in a pit open to the sky, and once a newer trip has started. Towering works the way a player does it: it steps to the middle of its block first (off-centre, its head catches the roof beside the hole and it can't jump), and lands on the block it put down without waiting for the server's answer, so lag doesn't make it fall back into the spot. If the server keeps refusing tower blocks, after three it climbs other ways for a minute. |
| **Craft**  | Uses the game's recipe list. Gathers ingredients recursively and places a crafting table if none is nearby. |
| **Plans ahead** | When it goes out to mine, hunt, farm or smelt something, it also gets what the tasks still in the queue will need of it, as far as its bag has room: `!armor diamond` mines all 24 diamonds in one trip, then crafts the four pieces. |
| **Tools**  | If a block needs a better pickaxe than it has, it makes one first (wood → stone → iron). |
| **Smelt**  | Ores, sand → glass, cobblestone → stone, logs → charcoal, raw meat → cooked, etc. Builds a furnace and collects fuel (coal or planks) if needed. |
| **Farm**   | Harvests ripe wheat, carrots, potatoes and beetroots and replants them. If there's no field, it makes a hoe, gets seeds (wheat seeds from grass), tills up to `farmSize` plots next to water and plants them, only where crops get enough light (daylight, or torchlight underground): a pool in a cave is passed over for water out in the open. It brings a bucket of water if there's none nearby. Then it waits for the crops to grow, using bone meal if it has any. |
| **Breed**  | Feeds pairs of adult cows, sheep, pigs, chickens, rabbits or goats the right food (wheat, carrots, seeds…), getting or growing the food first. |
| **Brew**   | Uses the water bottles it has (only fills, or makes, the ones it's short of), says what it still needs, and runs them through a brewing stand: water → awkward → healing, swiftness, night vision, etc. Can make them long, strong or splash. |
| **Sleep**  | Sleeps in a nearby bed at night or in thunderstorms. Beds someone is in (a player, a villager, another bot) are passed over, and so is one another bot of the crew is heading for; if someone gets in first, it tries the next. `!sleep` puts down its own bed when there's no free one (making it if needed: wool from sheep + planks), and picks it back up in the morning. |
| **Water**  | Makes a bucket, fills it, and places water: for new farms, or under itself to put out fire. |
| **Hunt**   | Items that come from mobs (leather, beef, wool, feathers, string, bones…). Animals always get critical hits (it stops sprinting, jumps, and hits on the way down). It skips babies (no drops) and anything with a name tag. It never hunts pets, horses, villagers, golems or creepers. |
| **Armor**  | Wears the best armor it carries (leather → gold → chainmail → iron → diamond → netherite) and a shield in its off-hand. Upgrades as soon as it picks up something better. |
| **Fight**  | Fights hostile mobs that come within `defendRadius` and can get at it (it's in their sight, or they just hurt it), dealing with creepers and archers first. It defends itself rather than starting fights: a mob on the other side of a wall is left alone, it never digs its way to one, and it gives up on one that goes out of sight or can't be reached. It hits from up to `attackReach` (5 blocks from its eyes to the mob; a player gets 3, the server accepts up to 6) and keeps about that far off, stepping back while its weapon recharges, so most mobs never get close enough to hit it. It times swings to the weapon's cooldown and picks its weapon by damage per second. It can land critical hits (jump and strike while falling) and blocks arrows with a shield while closing in. It backs off to eat (golden apples first) when health drops to `fleeHealth`. It runs from creepers and wardens and leaves endermen and piglins alone. It checks for mobs five times a second and drops a half-dug block to run. A creeper it ran from that stays put (they don't burn in daylight) gets shot if it has a bow; otherwise it keeps away from it: it won't walk anywhere the creeper would see it again, and if the creeper is by its crafting table or furnace it uses or puts down another one. |
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
table, furnace or brewing stand instead of making a new one: the nearest one in
sight within `workbenchRange` (64 blocks), or one it knows of further off. To
smelt it uses the nearest blast furnace (ores, raw metal), smoker (food) or
furnace. One with a creeper it ran from nearby is passed over (the log says so),
unless the bot is right next to it. Every
workbench it uses or puts down becomes its own and is remembered (in its memory
file, so across restarts, and shared with the crew); when none is in sight it
walks back to the nearest of those. One that's been taken away is forgotten.
The dashboard map shows them as small squares (hover for which and where).

## Water

- It watches its air every tick. When there's only just enough left to get
  to air (deeper water, sooner), it drops whatever it's doing, even mid-dig,
  and swims up, and nothing else moves it until it has a full breath. Under
  ice or a cave roof it times that by the way out: it breaks through if the
  block is quick to break, otherwise it swims through the water to the
  nearest gap (a hole in the ice, an air pocket). Then it carries on.
- Blocks under water: it swims to the water above them, dives (pushing down
  like a player holding sneak), stands on the bottom and digs (slower under
  water, as in the game). It only dives for a block when down, digging it
  and back up fits in one breath with a few seconds spare, and it goes down
  with a full breath (it comes up first rather than start a dig it would
  have to leave). Deeper blocks are left alone (it says so if that's all
  there is), and it would rather have them from dry land or shallow water.
- Magma under water: its bubbles drag anything touching them down, faster
  than it can swim up, onto the magma (which burns). The game counts the
  bubbles at its eyes as air, so in the middle of them it burned, and at
  the edge of them (head in plain water) it was dragged down drowning. It
  doesn't go through them or walk on magma, doesn't dive for anything
  within a couple of blocks of magma, and if it's caught anyway it drops
  what it's doing and swims out of them sideways before going up. Its
  timing for getting to air and its way up both go round them.
- Left idle in deep water it keeps its head up, then swims to where it can
  climb out (a bank no higher than the water). If every bank is a block too
  high, it digs the edge of the nearest one down and climbs out there.
- Paths prefer land and bridges to long swims. Swimming, it keeps to the top
  of the water (its planned steps go there too, so it doesn't keep turning
  back for one it passed over), climbs out where the bank is level with the
  top of the water, and can make its way upstream against a current. A bank
  a block higher can't be climbed straight out of (in the game either): it
  goes along to a lower place, or digs the edge down.

## Getting unstuck

A watch on the pathfinder for when it stops getting anywhere: a block it's
putting down (bridging, towering) that takes more than 8 s, the same next
step for 12 s while not digging, or three failed steps over at least 5 s
with no progress in between (nothing dug, not 3 blocks further on: pushed
off them by water, a jump it can't make, a block it can't place or dig).
The step it kept failing on is left out of its plans for two minutes and it
tries another way; the third time in a row without getting anywhere it gives
up on getting there ("I got stuck on the way at ...") and the job skips that
target or tries something else, rather than hang. A failed step now and
then among ones that work isn't being stuck, and neither are the few
seconds after it replans (that stirs up a failure or two itself). When it's
a dig that keeps failing, the log says which block and why. Going round in
circles counts as stuck however busy it looks: putting a block down and
digging it out again, twice over at the same spot, and that spot is left
alone (no placing, digging or standing there) for two minutes, with no
tunnelling straight up meanwhile ("Going round in circles ..."). Following or
fighting something that moves, it only goes another way. The log says each
time it happens. A trip that fails while it's in the water ends with it
getting out first (onto a bank it can climb, or digging the edge of a high
one down) rather than trying the next thing from the river.

## How it learns (no LLM)

It's plain statistics, saved to `memory.json` (one section per server):

| What it learns | How it uses it |
|----------------|----------------|
| **How long and how reliably mining, hunting and farming work.** It times each one per item (all wood types together) and counts failures. | The planner swaps its built-in cost guesses for real ones. If mining iron keeps failing around here, it gets "expensive" and other options win. |
| **Where things are.** Every ~45 s it notes ores, logs, sand, clay, water, beds, stations and animals nearby, and anything it mines or hunts. | When nothing is in sight, it heads back to the nearest remembered spot instead of wandering. If the spot is empty, it forgets it. The planner also treats remembered resources as cheaper. |
| **Which way to explore.** When it has to wander, it picks one of 8 compass directions per item and area. | Directions that led to the resource score higher. It picks with UCB1: mostly the best so far, sometimes another to check. |
| **How to fight each mob.** Styles are `crit` (jump attacks), `fast` (swing on cooldown), `kite` (hit and step back) and `bow` (when it has one). Each is scored per mob and per weapon (fist, sword, axe, with or without a bow) by whether it won and how much damage it took. | Each new fight against that mob uses the best style so far (UCB1 again), so it settles on what works for your setup. |
| **Its own aim.** After each arrow it watches where the arrow actually flew, and how far above or below the target it passed. | It keeps a running correction for each distance (0–10, 10–20, 20–30, 30–40, 40+ blocks) and aims that much lower or higher next time. `!learned` shows the corrections and the hit rate. |
| **Danger.** Where it died or took big damage (fades over a day). | It won't explore towards dangerous areas. |
| **Unreachable blocks.** Spots the pathfinder couldn't get to. | Skips them for 6 hours instead of retrying every time. |

**Crafting and smelting have no memory.** Which recipe to use is worked out
fresh each time from what's in its bag and what's around it: each recipe costs
what's still missing (4 planks in the bag make a crafting table free; 1 of the
4 still means fetching wood, from the nearest tree of any kind), and getting
the rest costs by distance.

`!learned` shows a summary and `!forget` wipes it. Set `"learn": false` to turn
learning off.

## Commands

In game chat, commands start with `!` and only the owner (`Zentyre` by default)
and the players listed in `"admins"` are obeyed. Whispers (`/msg Gatherer get oak_log`) and the terminal work with or
without the `!`. **A command sent by `/msg` gets its answers by `/msg`**,
including the progress of a task queued that way, so nothing shows in public
chat.

When a bot dies it sends the owner a private message with where it happened,
e.g. `I died at -390 70 1310 in the overworld (Zyntharic was slain by Zombie).`
(`"deathWhisper": false` turns that off.)

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
| `!give [item\|all] [count]`      | Walk to you and drop items. `all` is everything it has: bag, hotbar, the armor it's wearing and its off-hand. A named item comes from the bag first, then off its body (`!give iron_chestplate` takes off the one it wears if it has no spare). `!drop` does the same |
| `!bow [arrows]`                  | Get a bow and arrows (16 by default) to use in fights |
| `!armor`                         | Put on the best armor it has and say what it's wearing |
| `!armor <material>`              | Get and wear a full set: `leather`, `golden`, `iron` or `diamond` |
| `!spin [player] [radius]`        | Walk round and round a player (you, if no name), 3 blocks out unless you give a radius. Several bots spinning round the same player spread out evenly on one circle and go round together, so they never bump into each other; one joining or leaving makes the rest spread out again. `!spin stop` or `!stop` ends it. Said to the crew, every bot joins in |
| `!learned`                       | What it has learned so far                    |
| `!forget`                        | Erase everything it learned on this server   |
| `!stop`                          | Stop now (and wake up), clear the queue       |
| `!status` / `!queue`             | Show progress, health and food / queued tasks |
| `!inv`                           | List inventory                                |
| `!eat`                           | Eat now if hungry                             |
| `!come`                          | Walk to you (chat only)                       |
| `!deposit [item\|all] [count]`   | Put things in its chest: with nothing after it, everything but its tools, weapons, armor, arrows, buckets and food; `all`, its whole bag; or that item (`!deposit oak_log 62`). It says what went in, counted from its bag. When its bag fills up during a task, it unloads what the task is collecting |
| `!setchest [x y z\|clear]`        | Set the chest (or barrel) it unloads into: the one you're looking at (or the nearest to you, within 5 blocks), or the one at x y z. Remembered across restarts (in `memory/<bot>.chest.json`) and used instead of `"chest"` in config.json; `!setchest clear` goes back to that. Said to the crew, every bot uses it |
| `!home`                          | Return to where it spawned                    |
| `!say <text>`                    | Say something in chat                         |
| `!help`                          | List commands                                 |
| `!quit`                          | Disconnect                                    |
| `!profile [name]`                | Show or switch the profile (`default`, `builder`, or your own) |
| `!build <schematic> [x y z\|here] [rotate 90\|180\|270] [clear]` | Build a schematic (builder profile) |
| `!build` / `!build list`         | What it's building / the schematics it has    |
| `!build materials <schematic> ...` | What it needs, carries and finds in chests nearby |
| `!build resume` / `!build stop`  | Carry on with the last build / stop           |

Potions: `awkward`, `healing`, `swiftness`, `strength`, `night_vision`,
`fire_resistance`, `regeneration`, `water_breathing`, `leaping`,
`slow_falling`, `poison`, `turtle_master`, `weakness`, `invisibility`,
`harming`, `slowness`.

## Profiles and building

A **profile** is what a bot is for, switched while it runs: `!profile builder`,
and `!profile default` to go back (or the Profile box on its dashboard card).
`default` is the bot's own settings; another profile lays its settings on top.
Each bot remembers its profile across restarts. Make your own as
`profiles/<name>.json`:

```json
{ "description": "Quiet miner", "settings": { "chatter": false, "returnHome": false } }
```

The **builder** profile builds schematics: Litematica `.litematic`, WorldEdit
`.schem`, or structure block `.nbt` files, put in the `schematics` folder (or
uploaded with the dashboard's Upload button).

```
!profile builder
!build house                      builds where you stand
!build house 120 64 -300 rotate 90
!build materials house            what it needs before starting
```

- **Where:** the schematic's lowest north-west corner goes at the coordinates,
  or where the player who asked is standing (the bot's own spot with `here`, or
  if it can't see you). Litematica keeps its placement in your game, not in the
  file, so read the corner's coordinates off your placement. `rotate` turns it
  clockwise, facings included.
- **Materials:** it looks in the chests and barrels within 24 blocks of the
  build and of its home (and any listed in `"build": { "chests": [...] }`), takes
  what it needs from them, and gathers or crafts the rest like `!get` does.
  What it can't get is listed when it's done, and the rest is built anyway.
- **Placing:** bottom up, solid blocks before what hangs on them, each turned
  the way the schematic says: stairs, slabs, logs, doors, beds, trapdoors,
  torches, signs, chests, furnaces, pistons, buttons and so on. Blocks with
  nothing next to them (the edge of a roof, an overhang) are placed in mid-air:
  it clicks the empty spot itself, which the game allows, with the facing and
  halves still right. Only on a server that refuses that (an anti-cheat plugin)
  does it fall back to a temporary dirt pillar, taken away afterwards.
- **High up:** where it can't stand within reach (the top of a tall wall), it
  puts up a tower beside it and builds from the top, then breaks the tower
  on the way down and picks the blocks up again. It uses **scaffolding** when
  it has some (or a chest nearby does), otherwise dirt or cobblestone. Towers
  never go where the build has a block. Blocks it put down just to climb or
  bridge on its way round (pillars, steps) are broken and picked up again when
  the build is done; ones filling a shaft it climbed out of a mine are left, so
  no hole opens up.
- **What's in the way:** grass, flowers, leaves and natural ground (dirt,
  stone, sand...) are dug out. Anything else is left alone and reported,
  unless you add `clear`. It never digs through the build on its way around.
- Things it can't place from an item (water, lava, portals, spawners,
  bedrock, farmland...) are skipped and listed when it starts.

On the dashboard, a bot on the builder profile gets a **Build** panel: pick or
upload a schematic, where, turned how, then Build / Materials / Resume / Stop,
with its progress and what's still to place (what it has and what's in chests).

## Config

| Key                  | Default       | Meaning                                                          |
|----------------------|---------------|------------------------------------------------------------------|
| `host`, `port`       | `localhost`, `25565` | Server address                                            |
| `username`, `auth`   | `Gatherer`, `offline` | Bot account. `auth`: `microsoft` for online-mode servers (each bot needs its own account that owns Minecraft; `username` is then just the label its login is saved under), `offline` for offline-mode ones. With a `bots` list, the top-level `username` isn't used |
| `version`            | `false`       | Minecraft version, `false` = auto-detect                          |
| `owner`              | `"Zentyre"`   | Only take commands from this player (`null` = anyone, unless `admins` is set). Gets the death `/msg` |
| `admins`             | `[]`          | More players the bots take commands from, e.g. `["Friend1", "Friend2"]`. Can be set per bot too |
| `commandPrefix`      | `"!"`         | Chat commands must start with this                                |
| `viewDistance`       | `"normal"`    | Chunks requested from the server: `tiny` 6, `short` 8, `normal` 10, `far` 12, or a number (e.g. `16`). More = sees further, more RAM. Capped by the server's own view-distance |
| `searchRadius`       | `110`         | How far (blocks) to look for resources and mobs (keep under view distance × 16) |
| `stationRadius`      | `24`          | Beds: it looks for one to sleep in within four times this (96 blocks) |
| `workbenchRange`     | `64`          | Use a crafting table / furnace / brewing stand within this distance (seen or remembered) instead of making one |
| `exploreDistance`    | `64`          | How far to wander when nothing is in range                        |
| `maxExploreAttempts` | `8`           | Give up on an item after this many fruitless wanders              |
| `chest`              | `null`        | `{ "x": 0, "y": 64, "z": 0 }`: where to unload when full / done (a chest or barrel; `!setchest` in game overrides it) |
| `protectRadius`      | `0`           | Don't mine natural blocks within this many blocks of where it logged in or of its chest (keeps it off log and cobblestone builds). Only what it chooses to mine: passing through, it never breaks chests, beds, doors, glass, torches or farms, but may dig plain blocks |
| `extraMineable`      | `[]`          | Extra block names it may mine besides natural ones                |
| `hunt`               | `true`        | Allow killing animals and mobs for drops (leather, food, string…)  |
| `defend`             | `true`        | Fight back against hostile mobs                                   |
| `defendRadius`       | `8`           | How close a hostile mob must be before it reacts                  |
| `sprintJump`         | `true`        | Jump while sprinting on straight, flat stretches (faster; uses a little more food) |
| `attackReach`        | `5`           | Melee reach, eyes to the mob's hitbox (2 to 5.5). A player gets 3; vanilla servers accept up to 6. Lower it if an anti-cheat plugin complains |
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
| `autoSleep`          | `true`        | Sleep at night or in a thunderstorm if a free bed is nearby (bots are players: never sleeping brings phantoms) |
| `bringBed`           | `false`       | With `autoSleep`: when no free bed is nearby, put down its own (making one if needed) and pick it back up in the morning |
| `farm`               | `true`        | Allow farming for crops                                           |
| `farmSize`           | `9`           | How many plots to till and plant when starting a field            |
| `farmWaitMinutes`    | `30`          | Give up waiting for crops to grow after this long                 |
| `placeWater`         | `true`        | Bring water in a bucket to start a farm where there's none        |
| `learn`              | `true`        | Learn from experience (what works, how long things take) and remember places; shared with the crew |
| `memoryFile`         | `memory/<username>.json` | Where learned data is saved                            |
| `memoryRange`        | `400`         | How far away remembered places are worth travelling to            |
| `returnHome`         | `true`        | Walk back to where it logged in after the queue is done (with a chest set, it goes there to unload anyway) |
| `quitWhenDone`       | `false`       | Disconnect when the queue is done                                 |
| `chatter`            | `true`        | Post progress messages and replies in game chat (they always show on the dashboard) |
| `deathWhisper`       | `true`        | `/msg` the owner where the bot died                               |
| `build`              | `{ "chests": [], "chestRadius": 24, "maxChests": 16, "clear": false }` | Builder: extra chests (`[{ "x": 0, "y": 64, "z": 0 }]`), how far to look for chests, and always clearing what's in the way |
| `dashboard`          | `{ "port": 3000, "host": "127.0.0.1" }` | Web dashboard; `127.0.0.1` = only this PC can open it, `false` to turn it off |
| `autoStart`          | `[]`          | With `Start Dashboard.vbs`: bots to start right away (names, or `true` for all) |
| `tasks`              | `[]`          | Jobs to start on every launch: `[{ "item": "oak_log", "count": 32 }, …]` |
| `bots`               | `[]`          | Crew members: `[{ "username": "Miner" }, …]`, each may override any setting |
| `reconnect`          | `true`        | Crew: rejoin automatically after being kicked or disconnected     |

## Safety and limits

- It only mines blocks that generate naturally (stone, ores, logs, dirt, sand…).
  It won't take your house apart for planks or glass, or dig up your chests.
  But a cabin built from logs or cobblestone looks the same as natural blocks.
  Set `protectRadius` to keep it away from your base.
- When the pathfinder digs its way somewhere, it never breaks farmland,
  crops, chests, furnaces, crafting tables, beds, doors, glass or torches.
- It skips name-tagged animals (pets) and babies.
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
| `lib/spread.js`     | Each bot of a shared job to its own side of the compass   |
| `lib/crew-worker.js`| Worker-thread entry point for a crew member               |
| `lib/dashboard.js`  | Web dashboard server (status stream, commands, start/stop) |
| `lib/updater.js`    | Dashboard Update/Restart (git pull, npm install)          |
| `Start Dashboard.vbs`| Windows launcher: runs Gatherer hidden, opens the dashboard |
| `dashboard/index.html` | The dashboard page                                     |
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
| `lib/profiles.js`   | Profiles: switching what a bot is for while it runs        |
| `lib/schematic.js`  | Reading .litematic / .schem / .nbt schematics, rotating them |
| `lib/building.js`   | Builder: materials from chests, placing with the right facing, towers |
| `lib/swimming.js`   | Water: air, swimming up, diving, getting out                |
| `lib/climbing.js`   | Getting up: towers, tunnelling straight up                |
| `lib/unstuck.js`    | Noticing it's stuck, and going another way                |
| `lib/sprinting.js`  | Sprint-jumping on straight runs                           |
| `lib/spin.js`       | Spinning round a player, spaced out with the rest of the crew |
| `lib/chests.js`     | The unload chest set in game (`setchest`)                 |
| `lib/accounts.js`   | Saved Microsoft logins: written safely, refreshed patiently |
