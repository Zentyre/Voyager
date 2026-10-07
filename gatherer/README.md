# Gatherer: LLM-free resource bot

A small Minecraft bot that collects the resources you ask for. It uses the same
Mineflayer pathfinding and block-collecting libraries as Voyager, but nothing else:

- **No LLM / no API key.** Item → block lookup comes from `minecraft-data`
  (e.g. `coal` → `coal_ore`, `deepslate_coal_ore`; `cobblestone` → `stone`).
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
node gatherer.js oak_log:64 cobblestone:32 # or pass tasks on the command line
node gatherer.js --config other.json coal:16
```

Use **item** names, not block names: `raw_iron` (not `iron_ore`),
`cobblestone`, `oak_log`, `coal`, `diamond`, `dirt`, `sand`, …
The bot only mines blocks it can harvest with the tools in its inventory.
For iron, give it a stone pickaxe. For diamonds, give it an iron pickaxe.

## Commands

Type these in game chat (only `owner` is obeyed if set) or in the terminal:

| Command                 | What it does                                  |
|-------------------------|-----------------------------------------------|
| `gather <item> [count]` | Add a task to the queue and start             |
| `stop`                  | Stop now and clear the queue                  |
| `status` / `queue`      | Show progress / queued tasks                  |
| `come`                  | Walk to you (chat only)                       |
| `deposit`               | Put gathered items in the configured chest    |
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
| `searchRadius`       | `48`          | How far (blocks) to look for resources                            |
| `exploreDistance`    | `64`          | How far to wander when nothing is in range                        |
| `maxExploreAttempts` | `8`           | Give up on an item after this many fruitless wanders              |
| `chest`              | `null`        | `{ "x": 0, "y": 64, "z": 0 }`: where to unload when full / done   |
| `returnHome`         | `true`        | Walk back to the spawn point after the queue is done              |
| `quitWhenDone`       | `false`       | Disconnect when the queue is done                                 |
| `tasks`              | `[]`          | `[{ "item": "oak_log", "count": 32 }, …]`                         |

## Limits

It is a simple bot, not an agent. It does **not** craft, smelt, fight, or eat.
It only gathers items that come from mining blocks (logs, stone, ores, dirt,
sand, gravel/flint, …), not mob drops. It can die if left alone at night. Run it
with `/gamerule keepInventory true`, or on Peaceful, if that matters.
