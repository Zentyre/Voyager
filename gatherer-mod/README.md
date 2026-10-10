# Gatherer Dashboard (Fabric mod)

The Gatherer dashboard in game, for Minecraft 26.3: press **J** to see what
the bots are doing and command them. The game doesn't pause while it's open.

- Bots down the left, or **Whole crew** (gathering jobs get shared out).
- What the chosen bot is doing, its health, food, position, job, queue and
  inventory.
- Buttons for come, stop, status, inventory, eat, sleep, home, deposit, armor
  and farm.
- A box for any other command (the same as in chat, without the prefix);
  Enter sends it.
- The log, newest at the bottom.

It talks to the dashboard Gatherer already runs (`GET /status`,
`POST /command`), so the website keeps working as before.

## Install

1. Install [Fabric Loader](https://fabricmc.net/use/installer/) 0.19.5 or
   newer for 26.3.
2. Put [Fabric API](https://modrinth.com/mod/fabric-api) (0.162.0+26.3 or
   newer) and `gatherer-dashboard-1.0.0.jar` (in this folder) in your `mods`
   folder. It's client-only: nothing goes on the server.
3. Start the bots, then the game, and press J.

If the game runs on another computer than the bots: press J, then
**Settings**, and paste the link the bots' console printed
(`http://100.x.y.z:3000/?token=...`; see "From your phone or another
computer" in `gatherer/README.md`). The token is taken out of the link. Both
are kept in `config/gatherer-dashboard.json`.

The key can be changed under Options → Controls → Key Binds → Gatherer.

## Building

Needs Java 25: `./gradlew build`, and the jar is in `build/libs/`.
