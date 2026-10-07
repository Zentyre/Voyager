import hashlib
import json
import os
import re
import shutil
import subprocess
import urllib.request
import uuid

import voyager.utils as U

from .process_monitor import SubprocessMonitor

VERSION_MANIFEST_URL = (
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
)
EULA_URL = "https://aka.ms/MinecraftEULA"


def offline_uuid(username: str) -> str:
    """The UUID an offline-mode server assigns to a player name.

    Same as Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name).
    """
    digest = bytearray(hashlib.md5(f"OfflinePlayer:{username}".encode()).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as res:
        return json.load(res)


def java_major_version(java="java"):
    try:
        out = subprocess.run(
            [java, "-version"], capture_output=True, text=True, timeout=30
        )
    except FileNotFoundError:
        return None
    match = re.search(r'version "(\d+)(?:\.(\d+))?', out.stderr + out.stdout)
    if not match:
        return None
    major = int(match.group(1))
    # Java 8 and older report "1.8.0_xxx"
    return int(match.group(2)) if major == 1 else major


class MinecraftServer:
    """Downloads and runs a vanilla Minecraft dedicated server for Voyager.

    The server runs in offline mode so the bot can join without a Microsoft
    account, and the bot is made an operator so it can use the commands
    Voyager relies on (/give, /tp, /tick freeze, ...). You can watch the bot by
    joining localhost:<port> from your own Minecraft client.
    """

    def __init__(
        self,
        version="26.1",
        server_dir="minecraft_server",
        port=25565,
        accept_eula=False,
        bot_username="bot",
        op_bot=True,
        ops=(),
        memory="4G",
        java="java",
        level_seed="",
        server_properties=None,
        log_path="logs/minecraft",
    ):
        """
        :param version: Minecraft version to run, e.g. "26.1"
        :param server_dir: where server files and worlds are kept; each version
        gets its own subdirectory
        :param port: server port
        :param accept_eula: set True to accept the Minecraft EULA
        (https://aka.ms/MinecraftEULA); the server will not start otherwise
        :param bot_username: the bot's player name
        :param op_bot: make the bot an operator; False for a normal player
        :param ops: extra player names to make operators, e.g. your own
        :param memory: Java heap size for the server
        :param java: path to the java executable
        :param level_seed: world seed, empty for random
        :param server_properties: extra server.properties entries
        :param log_path: where server logs are written
        """
        self.version = version
        self.server_dir = os.path.abspath(U.f_join(server_dir, version))
        self.port = port
        self.accept_eula = accept_eula
        self.bot_username = bot_username
        self.ops = [bot_username, *ops] if op_bot else list(ops)
        self.memory = memory
        self.java = java
        self.level_seed = level_seed
        self.extra_properties = server_properties or {}
        self.log_path = log_path
        U.f_mkdir(self.server_dir)
        U.f_mkdir(log_path)
        self.process = None

    @property
    def jar_path(self):
        return U.f_join(self.server_dir, "server.jar")

    def prepare(self):
        """Download the server jar and write config files. Safe to call again."""
        if not self.accept_eula:
            raise RuntimeError(
                "Running a Minecraft server requires accepting the Minecraft EULA "
                f"({EULA_URL}). Pass accept_eula=True in minecraft_server to accept it."
            )
        version_info = self._version_info()
        self._check_java(version_info)
        self._download_jar(version_info)
        U.dump_text("eula=true\n", U.f_join(self.server_dir, "eula.txt"))
        self._write_properties()
        self._write_ops()

    def _version_info(self):
        cache = U.f_join(self.server_dir, "version.json")
        if U.f_exists(cache):
            return U.load_json(cache)
        manifest = _fetch_json(VERSION_MANIFEST_URL)
        entry = next(
            (v for v in manifest["versions"] if v["id"] == self.version), None
        )
        if entry is None:
            raise ValueError(
                f"Minecraft version {self.version} not found in Mojang's version "
                f"manifest. Latest release is {manifest['latest']['release']}."
            )
        info = _fetch_json(entry["url"])
        if "server" not in info.get("downloads", {}):
            raise ValueError(f"Minecraft {self.version} has no dedicated server")
        U.dump_json(info, cache)
        return info

    def _check_java(self, version_info):
        required = version_info.get("javaVersion", {}).get("majorVersion")
        found = java_major_version(self.java)
        if found is None:
            raise RuntimeError(
                f"Java not found (tried '{self.java}'). Minecraft {self.version} "
                f"needs Java {required or '21+'}; install it and/or pass "
                "minecraft_server={'java': '/path/to/java', ...}."
            )
        if required and found < required:
            raise RuntimeError(
                f"Minecraft {self.version} needs Java {required}, but "
                f"'{self.java}' is Java {found}."
            )

    def _download_jar(self, version_info):
        server = version_info["downloads"]["server"]
        if U.f_exists(self.jar_path) and self._sha1(self.jar_path) == server["sha1"]:
            return
        print(f"Downloading Minecraft {self.version} server...")
        tmp = self.jar_path + ".part"
        with urllib.request.urlopen(server["url"], timeout=300) as res, open(
            tmp, "wb"
        ) as f:
            shutil.copyfileobj(res, f)
        if self._sha1(tmp) != server["sha1"]:
            os.remove(tmp)
            raise RuntimeError("Downloaded server.jar failed its SHA-1 check")
        os.replace(tmp, self.jar_path)

    @staticmethod
    def _sha1(path):
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def _write_properties(self):
        path = U.f_join(self.server_dir, "server.properties")
        props = {}
        if U.f_exists(path):
            for line in U.load_text(path).splitlines():
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    props[key] = value
        else:
            props.update(
                {
                    "difficulty": "peaceful",
                    "gamemode": "survival",
                    "spawn-protection": "0",
                    "motd": "Voyager",
                    "level-seed": str(self.level_seed),
                    "view-distance": "10",
                    "simulation-distance": "10",
                }
            )
        # Always enforced: the bot logs in without a Microsoft account.
        props.update(
            {
                "online-mode": "false",
                "enforce-secure-profile": "false",
                "server-port": str(self.port),
            }
        )
        props.update({k: str(v) for k, v in self.extra_properties.items()})
        U.dump_text(
            "".join(f"{k}={v}\n" for k, v in props.items()),
            path,
        )

    def _write_ops(self):
        path = U.f_join(self.server_dir, "ops.json")
        ops = U.load_json(path) if U.f_exists(path) else []
        known = {op["name"] for op in ops}
        for name in self.ops:
            if name not in known:
                ops.append(
                    {
                        "uuid": offline_uuid(name),
                        "name": name,
                        "level": 4,
                        "bypassesPlayerLimit": False,
                    }
                )
        U.dump_json(ops, path)

    def run(self):
        self.prepare()
        self.process = SubprocessMonitor(
            commands=[
                self.java,
                f"-Xmx{self.memory}",
                f"-Xms{self.memory}",
                "-jar",
                "server.jar",
                "nogui",
            ],
            name="minecraft",
            ready_match=r"\]: Done \(",
            log_path=self.log_path,
            cwd=self.server_dir,
        )
        print(f"Starting Minecraft {self.version} server on port {self.port}...")
        self.process.run()
        if not self.process.is_running:
            raise RuntimeError(
                f"Minecraft server failed to start; see the log in {self.log_path}"
            )
        print(f"Minecraft server is ready on port {self.port}")

    def stop(self):
        if self.process and self.process.is_running:
            try:
                # save the world before exiting
                self.process.send("stop")
                self.process.process.wait(timeout=60)
            except Exception:
                self.process.stop()

    @property
    def is_running(self):
        return self.process is not None and self.process.is_running
