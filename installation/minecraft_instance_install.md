# Minecraft Setup

Voyager needs a Minecraft Java Edition world to play in, and the bot needs operator rights there (Voyager uses commands like `/give`, `/tp` and `/tick freeze`). No mods are required anymore: older versions of Voyager needed Fabric with the Multiplayer Server Pause and Better Respawn mods, and those features now use vanilla commands.

There are three ways to connect. Option 1 is the easiest.

## Option 1: Voyager runs a dedicated server (recommended)

Voyager downloads the official Minecraft server for the version you choose and runs it in offline mode, so the bot can log in without a Microsoft account. You need Java installed: Minecraft 26.1 and later need **Java 25**; 1.20.5 to 1.21.11 need Java 21.

```python
voyager = Voyager(
    minecraft_server={
        "version": "26.1",
        "accept_eula": True,  # you accept the Minecraft EULA: https://aka.ms/MinecraftEULA
    },
)
```

Options you can add to `minecraft_server`:

| Option | Default | Meaning |
|---|---|---|
| `version` | `"26.1"` | Minecraft version to download and run; `"26.3"` needs the [unreleased 26.3 setup](../README.md#optional-minecraft-263-unreleased) first |
| `server_dir` | `"minecraft_server"` | where server files and worlds are kept (one subfolder per version) |
| `port` | `25565` | server port |
| `ops` | `()` | extra player names to make operators, e.g. your own |
| `memory` | `"4G"` | Java heap size |
| `java` | `"java"` | path to the Java executable, if Java 25 is not the default one |
| `level_seed` | `""` | world seed |
| `server_properties` | `{}` | extra `server.properties` entries, e.g. `{"view-distance": 8}` |

**Watching the bot:** open Minecraft, choose Multiplayer, and connect to `localhost` (or `localhost:PORT`). Add your player name to `ops` if you want to use commands too. The world is saved in `minecraft_server/<version>/world` and is reused on the next run.

Because the server runs in offline mode, don't open its port to the internet.

## Option 2: Your own world or server (`mc_port`)

Join any world that is already running:

1. Start Minecraft, select the version you want to play, and create a singleplayer world.
2. Press `Esc` and select `Open to LAN`.
3. Set `Allow cheats: ON` and press `Start LAN World`.
4. The port number appears in the chat; pass it as `mc_port`.

```python
voyager = Voyager(mc_port=PORT)
```

For a server on another machine, also pass `mc_host="SERVER_ADDRESS"`. The server must accept offline-mode players (the bot has no Microsoft account) and the bot (named `bot`) must be an operator.

## Option 3: Microsoft Azure login (`azure_login`)

Voyager launches the Minecraft client itself, logged in to your Microsoft account. After a request timeout it can restart the game automatically. This is dependent on the [minecraft-launcher-lib](https://minecraft-launcher-lib.readthedocs.io/en/stable/tutorial/microsoft_login.html#let-the-user-log-in) library. Option 1 can also recover from timeouts and needs no account, so prefer it unless you specifically want the client launched for you.

1. Sign in to [Azure Portal](https://portal.azure.com/).
2. Go to [Azure Active Directory](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/Overview).
3. Click on the `App Registrations` tab on the left panel.
4. Click on the `New registration` button.
5. Fill the form with the following values:
    - Name: `YOUR_APP_NAME`
    - Supported account types: `Accounts in any organizational directory (Any Azure AD directory - Multitenant) and personal Microsoft accounts`
    - Redirect URI Type: `Public client/native (mobile & desktop)`, Value: `https://127.0.0.1/auth-response` (If you get `KeyError: 'access_token'` in the end, you can try to change the type to `Web`, see [FAQ](../FAQ.md) for more information)
6. Click on the `Register` button.
7. The `Application (client) ID` will be your `client_id`.
8. [Optional] Go to the `Certificates & Secrets` tab and click on the `New client secret` button. Fill the description by yourself. After you click `Add`, you will see your value, this will be your `secret_value`.
9. Go to your Minecraft install location `YOUR_MINECRAFT_GAME_LOCATION/versions`, and check all the versions you have. All the folder names are your valid `version` value.

```python
azure_login = {
    "client_id": "CLIENT_ID FROM STEP 7",
    "redirect_url": "https://127.0.0.1/auth-response",
    "secret_value": "[OPTIONAL] SECRET_KEY FROM STEP 8",
    "version": "26.1",
}
voyager = Voyager(azure_login=azure_login)
```

The first run asks you to follow a login link and saves the result to `voyager/env/config.json`. When the game opens, create a singleplayer world and open it to LAN with cheats on, as in Option 2; the bot joins automatically.
