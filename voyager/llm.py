"""Chat models and embeddings for Voyager's agents.

Replaces the old langchain/OpenAI-only layer with a small wrapper that talks to
either Anthropic (Claude) or OpenAI through their official SDKs. The provider
is picked from the model name ("claude-..." means Anthropic) unless set
explicitly.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
from dataclasses import dataclass
from typing import List, Optional, Sequence

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"


@dataclass
class Message:
    role: str  # "system", "user" or "assistant"
    content: str


def SystemMessage(content: str) -> Message:
    return Message("system", content)


def HumanMessage(content: str) -> Message:
    return Message("user", content)


def AIMessage(content: str) -> Message:
    return Message("assistant", content)


class RefusalError(RuntimeError):
    """The model declined the request (Anthropic stop_reason "refusal")."""


def infer_provider(model_name: str) -> str:
    return "anthropic" if model_name.startswith("claude") else "openai"


class ChatModel:
    """A chat model callable as ``llm(messages) -> AIMessage``.

    :param model_name: e.g. "claude-opus-5-5", or an OpenAI chat model
    :param temperature: sampling temperature; ignored for current Claude
    models, which do not accept it
    :param effort: "low" | "medium" | "high" | "xhigh" | "max"; how much the
    model thinks before answering (Claude effort / OpenAI reasoning_effort)
    :param request_timeout: seconds per request
    :param provider: "anthropic" or "openai"; inferred from model_name if None
    :param max_tokens: output token cap
    :param max_retries: SDK retries for rate limits, overload and network errors
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        temperature: Optional[float] = None,
        effort: Optional[str] = None,
        request_timeout: float = 240,
        provider: Optional[str] = None,
        max_tokens: int = 16000,
        max_retries: int = 4,
    ):
        self.model_name = model_name
        self.temperature = temperature
        self.effort = effort
        self.max_tokens = max_tokens
        self.provider = provider or infer_provider(model_name)
        if self.provider == "anthropic":
            import anthropic

            self.client = anthropic.Anthropic(
                timeout=request_timeout, max_retries=max_retries
            )
        elif self.provider == "openai":
            import openai

            self.client = openai.OpenAI(
                timeout=request_timeout, max_retries=max_retries
            )
        else:
            raise ValueError(f"Unknown LLM provider: {self.provider}")

    def __call__(self, messages: Sequence[Message]) -> Message:
        if self.provider == "anthropic":
            return AIMessage(self._call_anthropic(messages))
        return AIMessage(self._call_openai(messages))

    def _call_anthropic(self, messages: Sequence[Message]) -> str:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        turns = [
            {"role": m.role, "content": m.content}
            for m in messages
            if m.role != "system"
        ]
        kwargs = {}
        if system:
            kwargs["system"] = system
        if self.effort:
            kwargs["output_config"] = {"effort": self.effort}
        # On a safety-classifier decline, the API retries the request on the
        # fallback model Anthropic recommends for that refusal category.
        response = self.client.beta.messages.create(
            model=self.model_name,
            max_tokens=self.max_tokens,
            messages=turns,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **kwargs,
        )
        if response.stop_reason == "refusal":
            category = getattr(response.stop_details, "category", None)
            raise RefusalError(f"{self.model_name} declined the request ({category})")
        text = "".join(b.text for b in response.content if b.type == "text")
        if response.stop_reason == "max_tokens":
            print(
                f"\033[31mWarning: {self.model_name} hit max_tokens={self.max_tokens}; "
                "the response is truncated.\033[0m"
            )
        return text

    def _call_openai(self, messages: Sequence[Message]) -> str:
        kwargs = {}
        if self.temperature is not None:
            kwargs["temperature"] = self.temperature
        if self.effort:
            kwargs["reasoning_effort"] = self.effort
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            max_completion_tokens=self.max_tokens,
            **kwargs,
        )
        return response.choices[0].message.content or ""


class Embeddings:
    """Text embeddings for skill and question retrieval.

    provider "openai" uses the OpenAI embeddings API. provider "local" uses a
    hashed bag-of-words vector that needs no API: it only matches shared words,
    so retrieval is weaker, but it lets Voyager run with just an Anthropic key.
    provider "auto" picks "openai" when OPENAI_API_KEY is set, else "local".
    """

    def __init__(self, provider: str = "auto", model_name: Optional[str] = None):
        if provider == "auto":
            provider = "openai" if os.environ.get("OPENAI_API_KEY") else "local"
        self.provider = provider
        if provider == "openai":
            import openai

            self.client = openai.OpenAI()
            self.model_name = model_name or DEFAULT_OPENAI_EMBEDDING_MODEL
        elif provider == "local":
            self.model_name = "local-hash-v1"
        else:
            raise ValueError(f"Unknown embedding provider: {provider}")

    def embed(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        if self.provider == "openai":
            vectors = []
            for i in range(0, len(texts), 256):
                res = self.client.embeddings.create(
                    model=self.model_name, input=texts[i : i + 256]
                )
                vectors.extend(d.embedding for d in res.data)
            return vectors
        return [_hash_embedding(t) for t in texts]


_TOKEN = re.compile(r"[a-z0-9]+")
_LOCAL_DIM = 1024


def _hash_embedding(text: str) -> List[float]:
    # camelCase and snake_case names split into words: mineWoodLog -> mine wood log
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text).replace("_", " ").lower()
    vec = [0.0] * _LOCAL_DIM
    tokens = _TOKEN.findall(text)
    features = tokens + [f"{a} {b}" for a, b in zip(tokens, tokens[1:])]
    for feature in features:
        h = int.from_bytes(hashlib.md5(feature.encode()).digest()[:4], "little")
        vec[h % _LOCAL_DIM] += 1.0 if (h >> 31) & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]
