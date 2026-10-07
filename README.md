# Voyager: An Open-Ended Embodied Agent with Large Language Models
<div align="center">

[[Website]](https://voyager.minedojo.org/)
[[Arxiv]](https://arxiv.org/abs/2305.16291)
[[PDF]](https://voyager.minedojo.org/assets/documents/voyager.pdf)
[[Tweet]](https://twitter.com/DrJimFan/status/1662115266933972993?s=20)

[![Python Version](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://github.com/MineDojo/Voyager)
[![GitHub license](https://img.shields.io/github/license/MineDojo/Voyager)](https://github.com/MineDojo/Voyager/blob/main/LICENSE)
______________________________________________________________________


https://github.com/MineDojo/Voyager/assets/25460983/ce29f45b-43a5-4399-8fd8-5dd105fd64f2

![](images/pull.png)


</div>

We introduce Voyager, the first LLM-powered embodied lifelong learning agent
in Minecraft that continuously explores the world, acquires diverse skills, and
makes novel discoveries without human intervention. Voyager consists of three
key components: 1) an automatic curriculum that maximizes exploration, 2) an
ever-growing skill library of executable code for storing and retrieving complex
behaviors, and 3) a new iterative prompting mechanism that incorporates environment
feedback, execution errors, and self-verification for program improvement.
Voyager interacts with GPT-4 via blackbox queries, which bypasses the need for
model parameter fine-tuning. The skills developed by Voyager are temporally
extended, interpretable, and compositional, which compounds the agent’s abilities
rapidly and alleviates catastrophic forgetting. Empirically, Voyager shows
strong in-context lifelong learning capability and exhibits exceptional proficiency
in playing Minecraft. It obtains 3.3× more unique items, travels 2.3× longer
distances, and unlocks key tech tree milestones up to 15.3× faster than prior SOTA.
Voyager is able to utilize the learned skill library in a new Minecraft world to
solve novel tasks from scratch, while other techniques struggle to generalize.

In this repo, we provide Voyager code. This codebase is under [MIT License](LICENSE).

# Installation
Voyager requires Python ≥ 3.10, Node.js ≥ 20.10, and Minecraft Java Edition. It has been updated for Minecraft 26.1. Versions from 1.20.3 on should also work (pausing needs `/tick`, added in 1.20.3); 26.1 and 1.21.4 are the versions tested. See [What's new in this version](#whats-new-in-this-version) for the changes from the original release.

## Python Install
```
git clone https://github.com/MineDojo/Voyager
cd Voyager
pip install -e .
```

## Node.js Install
```
cd voyager/env/mineflayer
npm install
```
This also builds the bundled `mineflayer-collectblock` plugin. To check the install, run `npm test`, which starts the bot against a simulated Minecraft 26.1 server.

### Optional: Minecraft 26.3 (unreleased)
No mineflayer release supports 26.3 yet. To try it anyway, run this after `npm install`:
```
cd voyager/env/mineflayer
npm run setup:26.3
npm test -- 26.3
```
This patches the installed packages with the open, unmerged upstream PrismarineJS pull requests for 26.3, and downloads the 26.2/26.3 data from an open minecraft-data pull request, pinned to a fixed commit. The upstream work isn't reviewed yet and has known gaps: a few item components can't be decoded and some recipes are incomplete. Expect bugs. Then use `"version": "26.3"`. Note:
- `npm install` undoes the patches, so run `npm run setup:26.3` again after it.
- To go back to plain 26.1, run `rm -rf node_modules && npm install`.
- See [`mc-26.3/setup.js`](voyager/env/mineflayer/mc-26.3/setup.js) for the exact list of pull requests.

## Minecraft Setup
The simplest setup lets Voyager download and run a vanilla Minecraft server for you; it needs Java 25 for Minecraft 26.1. No mods are needed. You can also connect to a world you opened to LAN or to your own server. See [Minecraft Setup](installation/minecraft_instance_install.md) for all options.

# Getting Started
Voyager uses Claude by default. You need an [Anthropic API key](https://console.anthropic.com/) (set `ANTHROPIC_API_KEY` or pass `anthropic_api_key`). OpenAI models work too: pass an OpenAI model name for any agent along with `openai_api_key`. To avoid API costs entirely, [run the models locally](#running-models-locally-no-api-costs).

```python
from voyager import Voyager

voyager = Voyager(
    minecraft_server={
        "version": "26.1",
        "accept_eula": True,  # accepts the Minecraft EULA: https://aka.ms/MinecraftEULA
    },
    anthropic_api_key="YOUR_API_KEY",  # or set ANTHROPIC_API_KEY
)

# start lifelong learning
voyager.learn()
```

To watch the bot, connect your Minecraft client to `localhost` in Multiplayer.

### Choosing models
Every agent defaults to `claude-opus-5-5`. Model names starting with `claude` use Anthropic; anything else uses OpenAI. Each agent also has an effort setting (`low`, `medium`, `high`, `xhigh` or `max`) that controls how much the model thinks before answering:

```python
voyager = Voyager(
    ...,
    action_agent_model_name="claude-opus-5-5",   # writes the code; effort "high" by default
    curriculum_agent_model_name="claude-opus-5-5",
    critic_agent_model_name="claude-opus-5-5",
    curriculum_agent_qa_model_name="claude-opus-5-5",  # effort "low" by default
    skill_manager_model_name="claude-opus-5-5",        # skill descriptions and lessons
    action_agent_effort="high",
)
```

Claude requests opt into Anthropic's server-side fallback: if a safety classifier declines a request, it is retried on a fallback model instead of failing.

### Running models locally (no API costs)
Voyager can run every model on your own computer with [Ollama](https://ollama.com), so learning costs nothing per token. Install Ollama, download a model, and pass `local_model`:

```bash
ollama pull qwen2.5-coder:32b      # the model that plays
ollama pull nomic-embed-text       # optional: better skill search
```
```python
voyager = Voyager(
    minecraft_server={"version": "26.1", "accept_eula": True},
    local_model="qwen2.5-coder:32b",
    embedding_model="nomic-embed-text",  # leave out to use the built-in keyword index
)
```

No API key is needed. Things to know:
- **Model quality matters more than anything else.** The action agent has to write working Mineflayer JavaScript, and the original paper found that weaker models learn far fewer skills. Use the strongest coding model your hardware can run; `qwen2.5-coder:32b` is one example, and newer or larger models do better. Expect slower progress and more failed tasks than with Claude.
- **Hardware.** A 32B model needs roughly 20–24 GB of GPU memory (or a lot of RAM and patience on CPU). 14B models need about 10 GB, and 7–8B models about 6 GB, but those small models struggle with this task.
- **Context window.** Voyager requests a 32768-token context from Ollama on every call, because its prompts are long and Ollama's default window would silently cut them off. Change it with `llm_context_length` if your model or memory needs a different size. Voyager warns you if a prompt filled the whole window.
- **Mixing local and paid models.** Any agent's model can be set separately, and an explicit `*_model_name` overrides `local_model`. For example, `local_model="qwen2.5-coder:32b", action_agent_model_name="claude-opus-5-5"` pays only for the code-writing agent and runs everything else locally.
- **Other local servers.** LM Studio, llama.cpp and vLLM work through their OpenAI-compatible endpoint: `openai_base_url="http://localhost:1234/v1"` and `action_agent_model_name="<model name in that server>"` (and likewise for the other agents).
- **Ollama on another machine:** set `OLLAMA_HOST`, e.g. `OLLAMA_HOST=http://192.168.1.20:11434`.

### Skill retrieval
Skills and cached questions are retrieved by embedding similarity. With an OpenAI key, Voyager uses OpenAI's `text-embedding-3-small`; without one it falls back to a local keyword-based index, so Voyager runs with only an Anthropic key. Choose explicitly with `embedding_provider="openai"` or `"local"`. The index is rebuilt automatically from `skills.json` when the embedding model changes, so the bundled skill libraries load either way.

### Playing as a normal player on a server
By default the bot is an operator. It uses commands to reset its inventory, unstick itself, freeze the world while the model thinks, and so on. To have it play like any other survival player instead, for example on a server you share with others, turn cheats off. To join an online-mode server, give it its own Minecraft account:

```python
voyager = Voyager(
    mc_host="your.server.address",
    mc_port=25565,
    bot_auth="microsoft",          # log in to the bot's own Minecraft account
    bot_username="bot-account",    # any label for the cached login
    cheats=False,                  # play as a normal player, no operator commands
)
voyager.learn()
```

On the first connection, the console prints a link (microsoft.com/link) and a code. Sign in there with the bot's account. The login is then cached in `~/.voyager/auth`, so later runs connect without asking. The bot doesn't need to be an operator.

What changes with `cheats=False`:
- **No commands at all.** If the model's code tries one, the bot refuses and tells the model it has no commands.
- **The starting inventory is whatever the account already has.** Nothing is cleared or given, and the bot isn't teleported.
- **The world doesn't pause** while the model thinks. The bot stands still in the meantime, so at night it can be attacked. Time, weather and difficulty are left to the server.
- **Deaths drop items** unless the server has `keep_inventory` on. The bot respawns at its bed or the world spawn.
- **It picks up its own blocks.** Crafting tables and furnaces it places during a task are mined back afterwards. Blocks that were already there, like other players' blocks, are left alone, and the model is told not to break or take from other players' builds.
- **Its messages stay off the server chat.** The bot's progress messages only go to Voyager's log; pass `bot_chat_to_server=True` to show them in chat.
- **It stays connected between tasks** instead of rejoining after each one.

## What's new in this version
- **Modern Minecraft:** mineflayer 4.39 with Minecraft 26.1 support, plus opt-in [unreleased 26.3 support](#optional-minecraft-263-unreleased). Game-rule names follow 1.21.11's snake_case renames, and old versions still get the old names.
- **No mods or Microsoft login needed:** Voyager can run its own vanilla dedicated server. Pausing the world while the model thinks uses vanilla `/tick freeze` instead of the Multiplayer Server Pause mod, and the bot's respawn point follows it with `/spawnpoint` instead of the Better Respawn mod.
- **Current models:** Anthropic and OpenAI through their official SDKs, replacing the old langchain/GPT-4 code. chromadb is replaced by a small built-in vector store.
- **Better self-learning:**
  - *Lesson memory.* After a task fails or needs retries, Voyager writes a short lesson about what went wrong and what worked. The action agent sees lessons from similar past tasks, so it stops repeating the same mistakes. Turn off with `lesson_memory=False`.
  - *Failed tasks get a second chance.* Failed tasks are listed for the curriculum with the reason they failed, and drop off the "too hard" list after `curriculum_agent_retry_failed_after` (default 10) more completed tasks, so the agent can retry them once it is better equipped. A task that fails 3 times stays listed.
  - *Proven skills rank higher.* Each skill counts how often later skills build on it, and retrieval favors skills that have been reused.
  - *A better-informed critic.* The critic also sees the bot's chat log, so it can verify tasks that leave no trace in the inventory, such as killing a mob.
  - *Version awareness.* The agents are told which Minecraft version they are playing, so they only suggest blocks and items that exist in it.
- **Local models:** `local_model="..."` runs every agent on your own machine with Ollama, so there are no API costs; OpenAI-compatible local servers work too.
- **Normal-player mode:** `cheats=False` plays without operator commands, and `bot_auth="microsoft"` lets the bot join online-mode servers with its own account.

# Resume from a checkpoint during learning

If you stop the learning process and want to resume from a checkpoint later, you can instantiate Voyager by:
```python
from voyager import Voyager

voyager = Voyager(
    minecraft_server={"version": "26.1", "accept_eula": True},
    ckpt_dir="YOUR_CKPT_DIR",
    resume=True,
)
```

# Run Voyager for a specific task with a learned skill library

If you want to run Voyager for a specific task with a learned skill library, you should first pass the skill library directory to Voyager:
```python
from voyager import Voyager

# First instantiate Voyager with skill_library_dir.
voyager = Voyager(
    minecraft_server={"version": "26.1", "accept_eula": True},
    skill_library_dir="./skill_library/trial1", # Load a learned skill library.
    ckpt_dir="YOUR_CKPT_DIR", # Feel free to use a new dir. Do not use the same dir as skill library because new events will still be recorded to ckpt_dir. 
    resume=False, # Do not resume from a skill library because this is not learning.
)
```
Then, you can run task decomposition. Notice: Occasionally, the task decomposition may not be logical. If you notice the printed sub-goals are flawed, you can rerun the decomposition.
```python
# Run task decomposition
task = "YOUR TASK" # e.g. "Craft a diamond pickaxe"
sub_goals = voyager.decompose_task(task=task)
```
Finally, you can run the sub-goals with the learned skill library:
```python
voyager.inference(sub_goals=sub_goals)
```

For all valid skill libraries, see [Learned Skill Libraries](skill_library/README.md).

# FAQ
If you have any questions, please check our [FAQ](FAQ.md) first before opening an issue.

# Paper and Citation

If you find our work useful, please consider citing us! 

```bibtex
@article{wang2023voyager,
  title   = {Voyager: An Open-Ended Embodied Agent with Large Language Models},
  author  = {Guanzhi Wang and Yuqi Xie and Yunfan Jiang and Ajay Mandlekar and Chaowei Xiao and Yuke Zhu and Linxi Fan and Anima Anandkumar},
  year    = {2023},
  journal = {arXiv preprint arXiv: Arxiv-2305.16291}
}
```

Disclaimer: This project is strictly for research purposes, and not an official product from NVIDIA.
