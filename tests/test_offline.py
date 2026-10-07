"""Offline tests: no Minecraft server and no API calls.

The language model is replaced by canned replies chosen from the system
prompt, and the Minecraft environment by a fake that returns recorded-style
events. Run with: python -m unittest discover tests
"""

import copy
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from voyager import llm  # noqa: E402
from voyager.llm import ChatModel, Embeddings, HumanMessage, SystemMessage  # noqa: E402
from voyager.vectorstore import VectorStore  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def observation(inventory=None, chat=None):
    obs = {
        "status": {
            "health": 20.0,
            "food": 20.0,
            "biome": "plains",
            "timeOfDay": "day",
            "entities": {"cow": 5.0},
            "position": {"x": 1.0, "y": 64.0, "z": 2.0},
            "equipment": [None] * 6,
            "inventoryUsed": len(inventory or {}),
            "elapsedTime": 20,
            "version": "26.1",
        },
        "voxels": ["grass_block", "oak_log", "dirt"],
        "blockRecords": ["oak_log", "stone"],
        "inventory": inventory or {},
        "nearbyChests": {},
    }
    events = []
    if chat:
        events.append(("onChat", dict(copy.deepcopy(obs), onChat=chat)))
    events.append(("observe", obs))
    return events


class FakeEnv:
    def __init__(self):
        self.steps = []
        self.inventory = {}

    def reset(self, options=None):
        return observation(self.inventory)

    def step(self, code, programs=""):
        self.steps.append(code)
        if "craftItem" in code and "crafting_table" in code:
            self.inventory = dict(self.inventory, crafting_table=1)
        if "mineBlock" in code:
            self.inventory = dict(self.inventory, oak_log=1)
        return observation(self.inventory, chat="done")

    def close(self):
        pass


class FakeLLM:
    """Replies keyed on the system prompt; records every request."""

    def __init__(self):
        self.calls = []
        self.critic_replies = []

    def __call__(self, model, messages):
        system = messages[0].content
        self.calls.append(system[:60])
        if system.startswith("You are a helpful assistant that tells me the next"):
            return "Reasoning: have wood.\nTask: Craft 1 crafting table"
        if system.startswith("You are a helpful assistant that answer my question"):
            return "Answer: Craft it from 4 planks."
        if system.startswith("You are a helpful assistant that asks questions"):
            return "Question 1: How to craft planks in Minecraft?\nConcept 1: planks"
        if system.startswith("You are a helpful assistant that writes Mineflayer"):
            human = messages[1].content
            if "Task: Mine 1 wood log" in human:
                body = 'await mineBlock(bot, "oak_log", 1);'
                name = "mineWoodLog"
            else:
                body = 'await craftItem(bot, "crafting_table", 1);'
                name = "craftCraftingTable"
            return (
                "Explain: ...\nPlan: ...\nCode:\n```javascript\n"
                f"async function {name}(bot) {{\n  {body}\n}}\n```"
            )
        if "assesses my progress" in system:
            if self.critic_replies:
                return self.critic_replies.pop(0)
            return json.dumps({"reasoning": "ok", "success": True, "critique": ""})
        if "reviewing a Minecraft bot's attempts" in system:
            return "Craft planks from the log before crafting the table."
        # skill description
        return "Crafts the item using a crafting table."


class LLMTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = FakeLLM()
        fake = self.fake
        patcher = mock.patch.object(
            ChatModel,
            "__call__",
            lambda self, messages: llm.AIMessage(fake(self, messages)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)


class TestEmbeddingsAndStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_local_embeddings_rank_related_text_first(self):
        store = VectorStore(f"{self.tmp}/idx.json", Embeddings("local"))
        store.add(
            ["mine a wood log from a tree", "craft an iron pickaxe", "kill a zombie"],
            ids=["wood", "pick", "zombie"],
        )
        self.assertEqual(store.search("mineWoodLog", k=1)[0][0], "wood")
        self.assertEqual(store.search("craft iron pickaxe", k=1)[0][0], "pick")

    def test_persistence_and_sync(self):
        path = f"{self.tmp}/idx.json"
        store = VectorStore(path, Embeddings("local"))
        store.add(["a b c", "d e f"], ids=["x", "y"])
        reloaded = VectorStore(path, Embeddings("local"))
        self.assertEqual(reloaded.ids, ["x", "y"])
        reloaded.sync({"y": ("d e f", {}), "z": ("g h i", {})})
        self.assertEqual(sorted(reloaded.ids), ["y", "z"])
        store.delete(["x", "y"])
        self.assertEqual(len(store), 0)
        self.assertEqual(store.search("anything", 3), [])

    def test_index_rebuilt_when_embedding_model_changes(self):
        path = f"{self.tmp}/idx.json"
        VectorStore(path, Embeddings("local")).add(["a"], ids=["a"])
        with open(path) as f:
            data = json.load(f)
        data["embedding_model"] = "some-other-model"
        with open(path, "w") as f:
            json.dump(data, f)
        self.assertEqual(len(VectorStore(path, Embeddings("local"))), 0)


class TestChatModelRequests(unittest.TestCase):
    def test_anthropic_request_shape(self):
        model = ChatModel("claude-opus-5-5", effort="high", temperature=0)
        response = mock.Mock(
            stop_reason="end_turn",
            content=[mock.Mock(type="thinking"), mock.Mock(type="text", text="hi")],
        )
        model.client = mock.Mock()
        model.client.beta.messages.create.return_value = response
        out = model([SystemMessage("sys"), HumanMessage("q")])
        self.assertEqual(out.content, "hi")
        kwargs = model.client.beta.messages.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "claude-opus-5-5")
        self.assertEqual(kwargs["system"], "sys")
        self.assertEqual(kwargs["messages"], [{"role": "user", "content": "q"}])
        self.assertEqual(kwargs["output_config"], {"effort": "high"})
        self.assertEqual(kwargs["fallbacks"], "default")
        self.assertEqual(kwargs["betas"], ["server-side-fallback-2026-07-01"])
        self.assertNotIn("temperature", kwargs)

    def test_anthropic_refusal_raises(self):
        model = ChatModel("claude-opus-5-5")
        model.client = mock.Mock()
        model.client.beta.messages.create.return_value = mock.Mock(
            stop_reason="refusal", stop_details=mock.Mock(category="cyber"), content=[]
        )
        with self.assertRaises(llm.RefusalError):
            model([HumanMessage("q")])

    def test_openai_request_shape(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test"}):
            model = ChatModel("some-openai-model", temperature=0.2, effort="low")
        self.assertEqual(model.provider, "openai")
        model.client = mock.Mock()
        model.client.chat.completions.create.return_value = mock.Mock(
            choices=[mock.Mock(message=mock.Mock(content="hello"))]
        )
        self.assertEqual(model([SystemMessage("s"), HumanMessage("u")]).content, "hello")
        kwargs = model.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["messages"][0], {"role": "system", "content": "s"})
        self.assertEqual(kwargs["temperature"], 0.2)
        self.assertEqual(kwargs["reasoning_effort"], "low")


class TestSkillManager(LLMTestCase):
    def test_loads_bundled_skill_library_and_migrates_index(self):
        from voyager.agents import SkillManager

        lib = f"{self.tmp}/trial1"
        shutil.copytree(f"{REPO}/skill_library/trial1", lib)
        manager = SkillManager(
            ckpt_dir=lib, resume=True, embeddings=Embeddings("local")
        )
        self.assertEqual(len(manager.vectordb), len(manager.skills))
        self.assertGreater(len(manager.skills), 10)
        skills = manager.retrieve_skills("mine wood log")
        self.assertEqual(len(skills), 5)
        self.assertTrue(any("mineWoodLog" in s for s in skills))
        # second load reuses the index instead of re-embedding
        again = SkillManager(ckpt_dir=lib, resume=True, embeddings=Embeddings("local"))
        self.assertEqual(again.vectordb.ids, manager.vectordb.ids)

    def test_reuse_counts_boost_retrieval(self):
        from voyager.agents import SkillManager

        manager = SkillManager(ckpt_dir=self.tmp, embeddings=Embeddings("local"))
        manager.add_new_skill(
            {
                "task": "Mine 1 wood log",
                "program_name": "mineWoodLog",
                "program_code": "async function mineWoodLog(bot) { await mineBlock(bot, 'oak_log', 1); }",
            }
        )
        manager.add_new_skill(
            {
                "task": "Craft 4 planks",
                "program_name": "craftPlanks",
                "program_code": "async function craftPlanks(bot) { await mineWoodLog(bot); await craftItem(bot, 'oak_planks', 1); }",
            }
        )
        self.assertEqual(manager.skills["mineWoodLog"]["uses"], 1)
        self.assertEqual(manager.skills["craftPlanks"]["uses"], 0)
        # redefining a skill locally is not reuse
        manager.add_new_skill(
            {
                "task": "Craft sticks",
                "program_name": "craftSticks",
                "program_code": "async function mineWoodLog(bot) {}\nasync function craftSticks(bot) { await mineWoodLog(bot); }",
            }
        )
        self.assertEqual(manager.skills["mineWoodLog"]["uses"], 1)
        with open(f"{self.tmp}/skill/skills.json") as f:
            saved = json.load(f)
        self.assertEqual(saved["mineWoodLog"]["uses"], 1)


class TestCurriculumFailedTasks(LLMTestCase):
    def make(self, **kw):
        from voyager.agents import CurriculumAgent

        return CurriculumAgent(
            ckpt_dir=self.tmp,
            embeddings=Embeddings("local"),
            core_inventory_items=r".*_log",
            **kw,
        )

    def test_failed_task_cools_down_then_reappears(self):
        agent = self.make(retry_failed_after=2, max_task_failures=3)
        agent.update_exploration_progress(
            {"task": "Mine 1 diamond", "success": False, "critique": "Need an iron pickaxe."}
        )
        self.assertIn("Mine 1 diamond (reason: Need an iron pickaxe.)", agent.render_failed_tasks())
        for t in ["Mine 1 wood log", "Craft 4 planks"]:
            agent.update_exploration_progress({"task": t, "success": True})
        self.assertEqual(agent.render_failed_tasks(), "None")

    def test_task_failed_too_often_stays_listed(self):
        agent = self.make(retry_failed_after=1, max_task_failures=2)
        for _ in range(2):
            agent.update_exploration_progress({"task": "Kill 1 warden", "success": False})
        for t in ["a", "b", "c"]:
            agent.update_exploration_progress({"task": t, "success": True})
        self.assertIn("Kill 1 warden", agent.render_failed_tasks())

    def test_resume_keeps_failure_info(self):
        agent = self.make()
        agent.update_exploration_progress({"task": "Mine 1 diamond", "success": False, "critique": "x"})
        resumed = self.make(resume=True)
        self.assertEqual(resumed.failed_task_info["Mine 1 diamond"]["failures"], 1)

    def test_proposes_task_and_shows_version(self):
        agent = self.make()
        agent.completed_tasks = ["Mine 1 wood log"]
        task, context = agent.propose_next_task(
            events=observation({"oak_log": 1}), chest_observation="Chests: None\n\n"
        )
        self.assertEqual(task, "Craft 1 crafting table")
        self.assertIn("Craft it from 4 planks", context)
        message = agent.render_human_message(
            events=observation(), chest_observation="Chests: None\n\n"
        )
        self.assertIn("Minecraft version: 26.1", message.content)


class TestLessonMemory(LLMTestCase):
    def test_records_and_retrieves_lessons(self):
        from voyager.agents import LessonMemory

        memory = LessonMemory(ckpt_dir=self.tmp, embeddings=Embeddings("local"))
        memory.record(task="Craft 1 crafting table", success=True, attempts=[{"code": "x"}])
        self.assertEqual(memory.lessons, [])  # first-try success: nothing to learn
        memory.record(
            task="Craft 1 crafting table",
            success=True,
            attempts=[{"code": "a", "errors": "no planks", "critique": "craft planks"}, {"code": "b"}],
        )
        self.assertEqual(len(memory.lessons), 1)
        rendered = memory.render("Craft 2 crafting table")
        self.assertIn("Craft planks from the log", rendered)
        self.assertEqual(memory.render("Kill 3 skeletons in the nether"), "")
        resumed = LessonMemory(ckpt_dir=self.tmp, resume=True, embeddings=Embeddings("local"))
        self.assertEqual(len(resumed.lessons), 1)


class TestCritic(LLMTestCase):
    def test_critic_sees_chat_log(self):
        from voyager.agents import CriticAgent

        critic = CriticAgent()
        message = critic.render_human_message(
            events=observation({"rotten_flesh": 1}, chat="Killed zombie!"),
            task="Kill 1 zombie",
            context="",
            chest_observation="Chests: None\n\n",
        )
        self.assertIn("Chat log:\nKilled zombie!", message.content)
        self.fake.critic_replies = ['{"reasoning": "r", "success": false, "critique": "c"}']
        success, critique = critic.check_task_success(
            events=observation(), task="t", context="", chest_observation=""
        )
        self.assertEqual((success, critique), (False, "c"))


class TestLearningLoop(LLMTestCase):
    def test_learn_loop_records_skills_lessons_and_progress(self):
        from voyager import Voyager

        voyager = Voyager(
            mc_port=25565,
            embedding_provider="local",
            ckpt_dir=self.tmp,
            max_iterations=3,
            action_agent_task_max_retries=3,
        )
        voyager.env = FakeEnv()
        # second task: the critic rejects the first attempt
        self.fake.critic_replies = [
            json.dumps({"reasoning": "r", "success": True, "critique": ""}),
            json.dumps({"reasoning": "r", "success": False, "critique": "Craft planks first."}),
            json.dumps({"reasoning": "r", "success": True, "critique": ""}),
        ]
        result = voyager.learn()
        self.assertEqual(result["completed_tasks"], ["Mine 1 wood log", "Craft 1 crafting table"])
        self.assertIn("mineWoodLog", result["skills"])
        self.assertIn("craftCraftingTable", result["skills"])
        with open(f"{self.tmp}/lessons/lessons.json") as f:
            lessons = json.load(f)
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["task"], "Craft 1 crafting table")
        self.assertTrue(any("craftItem" in s for s in voyager.env.steps))


if __name__ == "__main__":
    unittest.main()
