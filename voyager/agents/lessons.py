import voyager.utils as U
from voyager.llm import ChatModel, Embeddings, HumanMessage, SystemMessage
from voyager.prompts import load_prompt
from voyager.vectorstore import VectorStore


class LessonMemory:
    """Lessons distilled from past attempts, retrieved for similar tasks.

    The original Voyager forgot everything it learned from a failed task: the
    critiques and execution errors were dropped once the task ended, so the
    next attempt at a similar task often repeated the same mistakes. After
    each task that failed or needed retries, this asks the model for a short
    lesson (what went wrong, what worked), and the action agent sees the
    lessons from the most similar earlier tasks.
    """

    def __init__(
        self,
        model_name="claude-opus-5-5",
        temperature=None,
        effort="low",
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
        embeddings: Embeddings = None,
        top_k=3,
        min_similarity=0.3,
    ):
        self.llm = ChatModel(
            model_name=model_name,
            temperature=temperature,
            effort=effort,
            request_timeout=request_timout,
        )
        self.ckpt_dir = ckpt_dir
        self.top_k = top_k
        self.min_similarity = min_similarity
        U.f_mkdir(f"{ckpt_dir}/lessons")
        path = f"{ckpt_dir}/lessons/lessons.json"
        self.lessons = U.load_json(path) if resume and U.f_exists(path) else []
        self.vectordb = VectorStore(
            f"{ckpt_dir}/lessons/lesson_index.json", embeddings or Embeddings()
        )
        self.vectordb.sync(
            {str(i): (entry["task"], {}) for i, entry in enumerate(self.lessons)}
        )

    def record(self, *, task, success, attempts):
        """Distill and store a lesson from a finished task.

        :param attempts: one dict per attempt with "code", "errors" and
        "critique" from that attempt
        """
        if success and len(attempts) <= 1:
            return  # solved first try: nothing new was learned
        if not attempts:
            return
        lesson = self.distill(task=task, success=success, attempts=attempts)
        if not lesson:
            return
        print(f"\033[36mLesson for {task}: {lesson}\033[0m")
        self.lessons.append({"task": task, "success": success, "lesson": lesson})
        U.dump_json(self.lessons, f"{self.ckpt_dir}/lessons/lessons.json")
        self.vectordb.add(texts=[task], ids=[str(len(self.lessons) - 1)])

    def distill(self, *, task, success, attempts):
        trail = []
        for i, a in enumerate(attempts, 1):
            trail.append(
                f"Attempt {i}:\n"
                f"Code:\n{a.get('code') or 'None'}\n"
                f"Execution errors: {a.get('errors') or 'None'}\n"
                f"Critique: {a.get('critique') or 'None'}"
            )
        outcome = "succeeded on the last attempt" if success else "failed"
        messages = [
            SystemMessage(content=load_prompt("lesson")),
            HumanMessage(
                content=f"Task: {task}\nOutcome: {outcome}\n\n" + "\n\n".join(trail)
            ),
        ]
        try:
            return self.llm(messages).content.strip()
        except Exception as e:
            print(f"\033[31mFailed to distill lesson: {e}\033[0m")
            return ""

    def retrieve(self, task):
        hits = self.vectordb.search(task, k=self.top_k)
        return [
            self.lessons[int(id_)]
            for id_, _, _, score in hits
            if score >= self.min_similarity
        ]

    def render(self, task):
        lessons = self.retrieve(task)
        if not lessons:
            return ""
        lines = "\n".join(
            f"- ({'succeeded' if l['success'] else 'failed'}: {l['task']}) {l['lesson']}"
            for l in lessons
        )
        return f"Lessons from similar past tasks:\n{lines}\n\n"
