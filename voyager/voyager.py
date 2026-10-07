import copy
import json
import os
import time
from typing import Dict

import voyager.utils as U
from .env import VoyagerEnv

from .agents import ActionAgent
from .agents import CriticAgent
from .agents import CurriculumAgent
from .agents import LessonMemory
from .agents import SkillManager
from .llm import DEFAULT_MODEL, OLLAMA_PREFIX, Embeddings


# TODO: remove event memory
class Voyager:
    def __init__(
        self,
        mc_port: int = None,
        azure_login: Dict[str, str] = None,
        minecraft_server: Dict = None,
        mc_host: str = "localhost",
        mc_version: str = None,
        bot_username: str = "bot",
        bot_auth: str = "offline",
        bot_auth_cache_dir: str = None,
        cheats: bool = True,
        bot_chat_to_server: bool = None,
        server_port: int = 3000,
        anthropic_api_key: str = None,
        openai_api_key: str = None,
        embedding_provider: str = "auto",
        embedding_model: str = None,
        local_model: str = None,
        llm_context_length: int = None,
        openai_base_url: str = None,
        env_wait_ticks: int = 20,
        env_request_timeout: int = 600,
        max_iterations: int = 160,
        reset_placed_if_failed: bool = False,
        action_agent_model_name: str = None,
        action_agent_temperature: float = None,
        action_agent_effort: str = "high",
        action_agent_task_max_retries: int = 4,
        action_agent_show_chat_log: bool = True,
        action_agent_show_execution_error: bool = True,
        curriculum_agent_model_name: str = None,
        curriculum_agent_temperature: float = None,
        curriculum_agent_effort: str = "medium",
        curriculum_agent_qa_model_name: str = None,
        curriculum_agent_qa_temperature: float = None,
        curriculum_agent_qa_effort: str = "low",
        curriculum_agent_warm_up: Dict[str, int] = None,
        curriculum_agent_core_inventory_items: str = r".*_log|.*_planks|stick|crafting_table|furnace"
        r"|cobblestone|dirt|coal|.*_pickaxe|.*_sword|.*_axe",
        curriculum_agent_mode: str = "auto",
        curriculum_agent_retry_failed_after: int = 10,
        critic_agent_model_name: str = None,
        critic_agent_temperature: float = None,
        critic_agent_effort: str = "medium",
        critic_agent_mode: str = "auto",
        skill_manager_model_name: str = None,
        skill_manager_temperature: float = None,
        skill_manager_retrieval_top_k: int = 5,
        lesson_memory: bool = True,
        llm_request_timeout: int = 240,
        openai_api_request_timeout: int = None,
        ckpt_dir: str = "ckpt",
        skill_library_dir: str = None,
        resume: bool = False,
    ):
        """
        The main class for Voyager.
        Action agent is the iterative prompting mechanism in paper.
        Curriculum agent is the automatic curriculum in paper.
        Critic agent is the self-verification in paper.
        Skill manager is the skill library in paper.
        :param mc_port: port of an already running Minecraft world or server
        :param azure_login: launch the Minecraft client with this Microsoft login config
        :param minecraft_server: run a vanilla dedicated server; dict of
        MinecraftServer options, e.g. {"version": "26.1", "accept_eula": True}
        :param mc_host: host of the server when using mc_port
        :param bot_username: the bot's player name (with bot_auth="microsoft",
        just a label for the cached login)
        :param bot_auth: "offline" or "microsoft"; with "microsoft" the bot logs
        in to its own Minecraft account and can join online-mode servers
        :param bot_auth_cache_dir: where Microsoft logins are cached
        (default ~/.voyager/auth)
        :param cheats: True (default) lets the bot use operator commands to
        reset its inventory, unstick itself, freeze the world while the model
        thinks, etc. False makes it play as a normal survival player
        :param bot_chat_to_server: send the bot's progress messages to the
        server chat (default: only when cheats is on)
        :param mc_version: Minecraft version to connect with; None detects it
        :param server_port: mineflayer port
        :param anthropic_api_key: Anthropic API key; defaults to ANTHROPIC_API_KEY
        :param openai_api_key: OpenAI API key; defaults to OPENAI_API_KEY
        :param embedding_provider: "openai", "ollama", "local" or "auto" for
        skill and question retrieval. "auto" picks ollama when embedding_model is
        set together with local_model, the free local index when running
        local_model, else openai when an OpenAI key is available
        :param embedding_model: embedding model name, e.g. "nomic-embed-text"
        :param local_model: run every agent on this Ollama model on your own
        machine (no API costs), e.g. "qwen2.5-coder:32b"; agents whose
        *_model_name you set explicitly keep that model. Any model name can
        also be given as "ollama/<model>"
        :param llm_context_length: context window requested from Ollama
        (default 32768)
        :param openai_base_url: use an OpenAI-compatible server instead of
        OpenAI, e.g. LM Studio at "http://localhost:1234/v1"
        Model names starting with "claude" use Anthropic; others use OpenAI.
        Effort ("low" to "max") sets how much each model thinks before answering.
        :param env_wait_ticks: how many ticks at the end each step will wait, if you found some chat log missing,
        you should increase this value
        :param env_request_timeout: how many seconds to wait for each step, if the code execution exceeds this time,
        python side will terminate the connection and need to be resumed
        :param reset_placed_if_failed: whether to reset placed blocks if failed, useful for building task
        :param action_agent_model_name: action agent model name
        :param action_agent_temperature: action agent temperature
        :param action_agent_task_max_retries: how many times to retry if failed
        :param curriculum_agent_model_name: curriculum agent model name
        :param curriculum_agent_temperature: curriculum agent temperature
        :param curriculum_agent_qa_model_name: curriculum agent qa model name
        :param curriculum_agent_qa_temperature: curriculum agent qa temperature
        :param curriculum_agent_warm_up: info will show in curriculum human message
        if completed task larger than the value in dict, available keys are:
        {
            "context": int,
            "biome": int,
            "time": int,
            "other_blocks": int,
            "nearby_entities": int,
            "health": int,
            "hunger": int,
            "position": int,
            "equipment": int,
            "chests": int,
            "optional_inventory_items": int,
        }
        :param curriculum_agent_core_inventory_items: only show these items in inventory before optional_inventory_items
        reached in warm up
        :param curriculum_agent_mode: "auto" for automatic curriculum, "manual" for human curriculum
        :param critic_agent_model_name: critic agent model name
        :param critic_agent_temperature: critic agent temperature
        :param critic_agent_mode: "auto" for automatic critic ,"manual" for human critic
        :param skill_manager_model_name: skill manager model name
        :param skill_manager_temperature: skill manager temperature
        :param skill_manager_retrieval_top_k: how many skills to retrieve for each task
        :param lesson_memory: distill lessons from failed or retried tasks and
        show them to the action agent on similar tasks
        :param curriculum_agent_retry_failed_after: completed tasks after which a
        failed task may be proposed again
        :param llm_request_timeout: how many seconds to wait for each model request
        :param openai_api_request_timeout: deprecated alias of llm_request_timeout
        :param ckpt_dir: checkpoint dir
        :param skill_library_dir: skill library dir
        :param resume: whether to resume from checkpoint
        """
        # init env
        self.env = VoyagerEnv(
            mc_port=mc_port,
            azure_login=azure_login,
            minecraft_server=minecraft_server,
            mc_host=mc_host,
            mc_version=mc_version,
            bot_username=bot_username,
            bot_auth=bot_auth,
            bot_auth_cache_dir=bot_auth_cache_dir,
            cheats=cheats,
            bot_chat_to_server=bot_chat_to_server,
            server_port=server_port,
            request_timeout=env_request_timeout,
        )
        self.env_wait_ticks = env_wait_ticks
        self.cheats = cheats
        if reset_placed_if_failed and not cheats:
            print(
                "\033[33mreset_placed_if_failed needs cheats; ignoring it\033[0m"
            )
        self.reset_placed_if_failed = reset_placed_if_failed and cheats
        self.max_iterations = max_iterations

        if anthropic_api_key:
            os.environ["ANTHROPIC_API_KEY"] = anthropic_api_key
        if openai_api_key:
            os.environ["OPENAI_API_KEY"] = openai_api_key
        if openai_base_url:
            os.environ["OPENAI_BASE_URL"] = openai_base_url
            # local servers ignore the key, but the SDK requires one
            os.environ.setdefault("OPENAI_API_KEY", "local")
        if llm_context_length:
            os.environ["VOYAGER_LLM_CONTEXT_LENGTH"] = str(llm_context_length)

        default_model = f"{OLLAMA_PREFIX}{local_model}" if local_model else DEFAULT_MODEL
        action_agent_model_name = action_agent_model_name or default_model
        curriculum_agent_model_name = curriculum_agent_model_name or default_model
        curriculum_agent_qa_model_name = curriculum_agent_qa_model_name or default_model
        critic_agent_model_name = critic_agent_model_name or default_model
        skill_manager_model_name = skill_manager_model_name or default_model
        if embedding_provider == "auto" and (local_model or openai_base_url):
            # don't send embeddings to a paid API in local mode
            embedding_provider = "ollama" if embedding_model and local_model else "local"
        print(
            f"\033[33mModels: action {action_agent_model_name}, curriculum "
            f"{curriculum_agent_model_name}, critic {critic_agent_model_name}\033[0m"
        )
        request_timeout = openai_api_request_timeout or llm_request_timeout
        embeddings = Embeddings(provider=embedding_provider, model_name=embedding_model)
        print(f"\033[33mUsing {embeddings.model_name} embeddings for retrieval\033[0m")

        # init agents
        self.action_agent = ActionAgent(
            model_name=action_agent_model_name,
            temperature=action_agent_temperature,
            effort=action_agent_effort,
            request_timout=request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            chat_log=action_agent_show_chat_log,
            execution_error=action_agent_show_execution_error,
            cheats=cheats,
        )
        self.action_agent_task_max_retries = action_agent_task_max_retries
        self.curriculum_agent = CurriculumAgent(
            model_name=curriculum_agent_model_name,
            temperature=curriculum_agent_temperature,
            effort=curriculum_agent_effort,
            qa_model_name=curriculum_agent_qa_model_name,
            qa_temperature=curriculum_agent_qa_temperature,
            qa_effort=curriculum_agent_qa_effort,
            request_timout=request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            mode=curriculum_agent_mode,
            warm_up=curriculum_agent_warm_up,
            core_inventory_items=curriculum_agent_core_inventory_items,
            embeddings=embeddings,
            retry_failed_after=curriculum_agent_retry_failed_after,
        )
        self.critic_agent = CriticAgent(
            model_name=critic_agent_model_name,
            temperature=critic_agent_temperature,
            effort=critic_agent_effort,
            request_timout=request_timeout,
            mode=critic_agent_mode,
        )
        self.skill_manager = SkillManager(
            model_name=skill_manager_model_name,
            temperature=skill_manager_temperature,
            retrieval_top_k=skill_manager_retrieval_top_k,
            request_timout=request_timeout,
            ckpt_dir=skill_library_dir if skill_library_dir else ckpt_dir,
            resume=True if resume or skill_library_dir else False,
            embeddings=embeddings,
        )
        self.lesson_memory = (
            LessonMemory(
                model_name=skill_manager_model_name,
                temperature=skill_manager_temperature,
                request_timout=request_timeout,
                ckpt_dir=ckpt_dir,
                resume=resume,
                embeddings=embeddings,
            )
            if lesson_memory
            else None
        )
        self.recorder = U.EventRecorder(ckpt_dir=ckpt_dir, resume=resume)
        self.resume = resume

        # init variables for rollout
        self.action_agent_rollout_num_iter = -1
        self.task = None
        self.context = ""
        self.messages = None
        self.conversations = []
        self.attempts = []
        self.lessons = ""
        self.last_events = None

    def reset(self, task, context="", reset_env=True):
        self.attempts = []
        self.action_agent_rollout_num_iter = 0
        self.task = task
        self.context = context
        # Reconnecting resyncs the bot after commands change its inventory;
        # a normal player uses no commands, so it stays connected.
        if reset_env and self.cheats:
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        difficulty = (
            "easy" if len(self.curriculum_agent.completed_tasks) > 15 else "peaceful"
        )
        # step to peek an observation
        if self.cheats:
            events = self.env.step(
                "bot.chat(`/time set ${getNextTime()}`);\n"
                + f"bot.chat('/difficulty {difficulty}');"
            )
        else:
            events = self.env.step("")
        skills = self.skill_manager.retrieve_skills(query=self.context)
        print(
            f"\033[33mRender Action Agent system message with {len(skills)} skills\033[0m"
        )
        self.lessons = self.lesson_memory.render(task) if self.lesson_memory else ""
        system_message = self.action_agent.render_system_message(skills=skills)
        human_message = self.action_agent.render_human_message(
            events=events,
            code="",
            task=self.task,
            context=context,
            critique="",
            lessons=self.lessons,
        )
        self.messages = [system_message, human_message]
        print(
            f"\033[32m****Action Agent human message****\n{human_message.content}\033[0m"
        )
        assert len(self.messages) == 2
        self.conversations = []
        return self.messages

    def close(self):
        self.env.close()

    def step(self):
        if self.action_agent_rollout_num_iter < 0:
            raise ValueError("Agent must be reset before stepping")
        ai_message = self.action_agent.llm(self.messages)
        print(f"\033[34m****Action Agent ai message****\n{ai_message.content}\033[0m")
        self.conversations.append(
            (self.messages[0].content, self.messages[1].content, ai_message.content)
        )
        parsed_result = self.action_agent.process_ai_message(message=ai_message)
        success = False
        critique = ""
        if isinstance(parsed_result, dict):
            code = parsed_result["program_code"] + "\n" + parsed_result["exec_code"]
            events = self.env.step(
                code,
                programs=self.skill_manager.programs,
            )
            self.recorder.record(events, self.task)
            self.action_agent.update_chest_memory(events[-1][1]["nearbyChests"])
            success, critique = self.critic_agent.check_task_success(
                events=events,
                task=self.task,
                context=self.context,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )

            if self.reset_placed_if_failed and not success:
                # revert all the placing event in the last step
                blocks = []
                positions = []
                for event_type, event in events:
                    if event_type == "onSave" and event["onSave"].endswith("_placed"):
                        block = event["onSave"].split("_placed")[0]
                        position = event["status"]["position"]
                        blocks.append(block)
                        positions.append(position)
                new_events = self.env.step(
                    f"await givePlacedItemBack(bot, {U.json_dumps(blocks)}, {U.json_dumps(positions)})",
                    programs=self.skill_manager.programs,
                )
                events[-1][1]["inventory"] = new_events[-1][1]["inventory"]
                events[-1][1]["voxels"] = new_events[-1][1]["voxels"]
            new_skills = self.skill_manager.retrieve_skills(
                query=self.context
                + "\n\n"
                + self.action_agent.summarize_chatlog(events)
            )
            system_message = self.action_agent.render_system_message(skills=new_skills)
            human_message = self.action_agent.render_human_message(
                events=events,
                code=parsed_result["program_code"],
                task=self.task,
                context=self.context,
                critique=critique,
                lessons=self.lessons,
            )
            self.last_events = copy.deepcopy(events)
            self.messages = [system_message, human_message]
            self.attempts.append(
                {
                    "code": parsed_result["program_code"],
                    "errors": "\n".join(
                        event["onError"]
                        for event_type, event in events
                        if event_type == "onError"
                    ),
                    "critique": critique,
                }
            )
        else:
            assert isinstance(parsed_result, str)
            self.recorder.record([], self.task)
            self.attempts.append({"code": "", "errors": parsed_result, "critique": ""})
            print(f"\033[34m{parsed_result} Trying again!\033[0m")
        assert len(self.messages) == 2
        self.action_agent_rollout_num_iter += 1
        done = (
            self.action_agent_rollout_num_iter >= self.action_agent_task_max_retries
            or success
        )
        info = {
            "task": self.task,
            "success": success,
            "critique": critique,
            "conversations": self.conversations,
        }
        if success:
            assert (
                "program_code" in parsed_result and "program_name" in parsed_result
            ), "program and program_name must be returned when success"
            info["program_code"] = parsed_result["program_code"]
            info["program_name"] = parsed_result["program_name"]
        else:
            print(
                f"\033[32m****Action Agent human message****\n{self.messages[-1].content}\033[0m"
            )
        return self.messages, 0, done, info

    def rollout(self, *, task, context, reset_env=True):
        self.reset(task=task, context=context, reset_env=reset_env)
        while True:
            messages, reward, done, info = self.step()
            if done:
                break
        return messages, reward, done, info

    def learn(self, reset_env=True):
        if self.resume:
            # keep the inventory
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        else:
            # clear the inventory
            self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
            self.resume = True
        self.last_events = self.env.step("")

        while True:
            if self.recorder.iteration > self.max_iterations:
                print("Iteration limit reached")
                break
            task, context = self.curriculum_agent.propose_next_task(
                events=self.last_events,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )
            print(
                f"\033[35mStarting task {task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            try:
                messages, reward, done, info = self.rollout(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except Exception as e:
                time.sleep(3)  # wait for mineflayer to exit
                info = {
                    "task": task,
                    "success": False,
                }
                # reset bot status here
                self.last_events = self.env.reset(
                    options={
                        "mode": "hard",
                        "wait_ticks": self.env_wait_ticks,
                        "inventory": self.last_events[-1][1]["inventory"],
                        "equipment": self.last_events[-1][1]["status"]["equipment"],
                        "position": self.last_events[-1][1]["status"]["position"],
                    }
                )
                # use red color background to print the error
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if info["success"]:
                self.skill_manager.add_new_skill(info)
            if self.lesson_memory:
                self.lesson_memory.record(
                    task=task, success=info["success"], attempts=self.attempts
                )

            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )

        return {
            "completed_tasks": self.curriculum_agent.completed_tasks,
            "failed_tasks": self.curriculum_agent.failed_tasks,
            "skills": self.skill_manager.skills,
        }

    def decompose_task(self, task):
        if not self.last_events:
            self.last_events = self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        return self.curriculum_agent.decompose_task(task, self.last_events)

    def inference(self, task=None, sub_goals=[], reset_mode="hard", reset_env=True):
        if not task and not sub_goals:
            raise ValueError("Either task or sub_goals must be provided")
        if not sub_goals:
            sub_goals = self.decompose_task(task)
        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.curriculum_agent.completed_tasks = []
        self.curriculum_agent.failed_tasks = []
        self.last_events = self.env.step("")
        while self.curriculum_agent.progress < len(sub_goals):
            next_task = sub_goals[self.curriculum_agent.progress]
            context = self.curriculum_agent.get_task_context(next_task)
            print(
                f"\033[35mStarting task {next_task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            messages, reward, done, info = self.rollout(
                task=next_task,
                context=context,
                reset_env=reset_env,
            )
            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )
