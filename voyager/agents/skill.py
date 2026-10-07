import math
import os
import re

import voyager.utils as U
from voyager.llm import ChatModel, Embeddings, HumanMessage, SystemMessage
from voyager.vectorstore import VectorStore

from voyager.prompts import load_prompt
from voyager.control_primitives import load_control_primitives


class SkillManager:
    def __init__(
        self,
        model_name="claude-opus-5-5",
        temperature=None,
        effort="low",
        retrieval_top_k=5,
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
        embeddings: Embeddings = None,
        reuse_weight=0.02,
    ):
        """
        :param reuse_weight: how much a skill's reuse count boosts it in
        retrieval, added to cosine similarity as reuse_weight * ln(1 + uses)
        """
        self.llm = ChatModel(
            model_name=model_name,
            temperature=temperature,
            effort=effort,
            request_timeout=request_timout,
        )
        U.f_mkdir(f"{ckpt_dir}/skill/code")
        U.f_mkdir(f"{ckpt_dir}/skill/description")
        # programs for env execution
        self.control_primitives = load_control_primitives()
        if resume:
            print(f"\033[33mLoading Skill Manager from {ckpt_dir}/skill\033[0m")
            self.skills = U.load_json(f"{ckpt_dir}/skill/skills.json")
        else:
            self.skills = {}
        self.retrieval_top_k = retrieval_top_k
        self.reuse_weight = reuse_weight
        self.ckpt_dir = ckpt_dir
        self.vectordb = VectorStore(
            f"{ckpt_dir}/skill/skill_index.json", embeddings or Embeddings()
        )
        # skills.json is the source of truth; this also migrates checkpoints
        # whose index was built by the old chromadb store.
        self.vectordb.sync(
            {
                name: (entry["description"], {"name": name})
                for name, entry in self.skills.items()
            }
        )

    @property
    def programs(self):
        programs = ""
        for skill_name, entry in self.skills.items():
            programs += f"{entry['code']}\n\n"
        for primitives in self.control_primitives:
            programs += f"{primitives}\n\n"
        return programs

    def add_new_skill(self, info):
        if info["task"].startswith("Deposit useless items into the chest at"):
            # No need to reuse the deposit skill
            return
        program_name = info["program_name"]
        program_code = info["program_code"]
        skill_description = self.generate_skill_description(program_name, program_code)
        print(
            f"\033[33mSkill Manager generated description for {program_name}:\n{skill_description}\033[0m"
        )
        uses = 0
        if program_name in self.skills:
            print(f"\033[33mSkill {program_name} already exists. Rewriting!\033[0m")
            uses = self.skills[program_name].get("uses", 0)
            i = 2
            while f"{program_name}V{i}.js" in os.listdir(f"{self.ckpt_dir}/skill/code"):
                i += 1
            dumped_program_name = f"{program_name}V{i}"
        else:
            dumped_program_name = program_name
        self.record_reuse(program_name, program_code)
        self.vectordb.add(
            texts=[skill_description],
            ids=[program_name],
            metadatas=[{"name": program_name}],
        )
        self.skills[program_name] = {
            "code": program_code,
            "description": skill_description,
            "task": info["task"],
            "uses": uses,
        }
        assert len(self.vectordb) == len(self.skills), "vectordb is not synced with skills.json"
        U.dump_text(
            program_code, f"{self.ckpt_dir}/skill/code/{dumped_program_name}.js"
        )
        U.dump_text(
            skill_description,
            f"{self.ckpt_dir}/skill/description/{dumped_program_name}.txt",
        )
        U.dump_json(self.skills, f"{self.ckpt_dir}/skill/skills.json")

    def record_reuse(self, program_name, program_code):
        """Count each existing skill that a newly verified program calls.

        Skills that keep getting built upon have proven reliable, so retrieval
        ranks them higher.
        """
        called = set(re.findall(r"\b([A-Za-z_$][\w$]*)\s*\(", program_code))
        # a program that defines its own copy of a skill is not reusing it
        called -= set(re.findall(r"function\s+([A-Za-z_$][\w$]*)", program_code))
        for name in called & set(self.skills):
            if name != program_name:
                self.skills[name]["uses"] = self.skills[name].get("uses", 0) + 1

    def generate_skill_description(self, program_name, program_code):
        messages = [
            SystemMessage(content=load_prompt("skill")),
            HumanMessage(
                content=program_code
                + "\n\n"
                + f"The main function is `{program_name}`."
            ),
        ]
        skill_description = f"    // { self.llm(messages).content.strip()}"
        return f"async function {program_name}(bot) {{\n{skill_description}\n}}"

    def retrieve_skills(self, query):
        k = min(len(self.vectordb), self.retrieval_top_k)
        if k == 0:
            return []
        print(f"\033[33mSkill Manager retrieving for {k} skills\033[0m")
        # over-fetch, then re-rank by similarity plus a bonus for proven reuse
        candidates = self.vectordb.search(query, k=2 * k)
        ranked = sorted(
            candidates,
            key=lambda c: c[3]
            + self.reuse_weight * math.log1p(self.skills[c[0]].get("uses", 0)),
            reverse=True,
        )[:k]
        print(
            f"\033[33mSkill Manager retrieved skills: "
            f"{', '.join(name for name, *_ in ranked)}\033[0m"
        )
        return [self.skills[name]["code"] for name, *_ in ranked]
