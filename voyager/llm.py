"""Chat models and embeddings for Voyager's agents.

Replaces the old langchain/OpenAI-only layer with a small wrapper that talks to
Anthropic (Claude) or OpenAI through their official SDKs, or to models running
on your own machine with Ollama. The provider is picked from the model name
unless set explicitly: "claude-..." is Anthropic, "ollama/<model>" is Ollama,
anything else is OpenAI (or any OpenAI-compatible server set with
OPENAI_BASE_URL, such as LM Studio, llama.cpp or vLLM).
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import time
from dataclasses import dataclass
from typing import List, Optional, Sequence

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text"
# Voyager's prompts (skill code, observations, critiques) run to several
# thousand tokens; Ollama's default context window would silently cut them off.
DEFAULT_LOCAL_CONTEXT_LENGTH = 32768
OLLAMA_PREFIX = "ollama/"


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
    if model_name.startswith(OLLAMA_PREFIX):
        return "ollama"
    return "anthropic" if model_name.startswith("claude") else "openai"


def ollama_url(path: str) -> str:
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    if not host.startswith(("http://", "https://")):
        host = "http://" + host
    return host + path


def ollama_post(path: str, payload: dict, timeout: float, retries: int = 3):
    """POST to the local Ollama server, with clear errors for common setups."""
    import requests

    for attempt in range(retries + 1):
        try:
            res = requests.post(ollama_url(path), json=payload, timeout=timeout)
        except requests.ConnectionError:
            if attempt == retries:
                raise RuntimeError(
                    f"Cannot reach Ollama at {ollama_url('')}. Start it with "
                    "`ollama serve` (or the Ollama app), or set OLLAMA_HOST."
                )
            time.sleep(2 ** attempt)
            continue
        if res.status_code == 404:
            raise RuntimeError(
                f"Ollama has no model '{payload.get('model')}'. "
                f"Download it with: ollama pull {payload.get('model')}"
            )
        if res.status_code >= 500 and attempt < retries:
            time.sleep(2 ** attempt)
            continue
        if res.status_code != 200:
            raise RuntimeError(f"Ollama error {res.status_code}: {res.text[:500]}")
        return res.json()


_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)


class ChatModel:
    """A chat model callable as ``llm(messages) -> AIMessage``.

    :param model_name: e.g. "claude-opus-5-5", "ollama/qwen2.5-coder:32b", or
    an OpenAI chat model
    :param temperature: sampling temperature; ignored for current Claude
    models, which do not accept it
    :param effort: "low" | "medium" | "high" | "xhigh" | "max"; how much the
    model thinks before answering (Claude effort / OpenAI reasoning_effort)
    :param request_timeout: seconds per request
    :param provider: "anthropic", "openai" or "ollama"; inferred from
    model_name if None
    :param max_tokens: output token cap
    :param max_retries: SDK retries for rate limits, overload and network errors
    :param context_length: context window to request from Ollama
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
        context_length: Optional[int] = None,
    ):
        self.model_name = model_name
        self.request_timeout = request_timeout
        self.context_length = context_length or int(
            os.environ.get("VOYAGER_LLM_CONTEXT_LENGTH", DEFAULT_LOCAL_CONTEXT_LENGTH)
        )
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
            # LM Studio, llama.cpp, vLLM, ... behind OPENAI_BASE_URL
            self.openai_compatible = "api.openai.com" not in str(self.client.base_url)
        elif self.provider == "ollama":
            self.client = None
        else:
            raise ValueError(f"Unknown LLM provider: {self.provider}")

    def __call__(self, messages: Sequence[Message]) -> Message:
        if self.provider == "anthropic":
            return AIMessage(self._call_anthropic(messages))
        if self.provider == "ollama":
            return AIMessage(self._call_ollama(messages))
        return AIMessage(self._call_openai(messages))

    def _call_ollama(self, messages: Sequence[Message]) -> str:
        model = self.model_name[len(OLLAMA_PREFIX):] if self.model_name.startswith(
            OLLAMA_PREFIX
        ) else self.model_name
        response = ollama_post(
            "/api/chat",
            {
                "model": model,
                "messages": [{"role": m.role, "content": m.content} for m in messages],
                "stream": False,
                "options": {
                    "num_ctx": self.context_length,
                    "temperature": 0 if self.temperature is None else self.temperature,
                    "num_predict": min(self.max_tokens, self.context_length),
                },
            },
            # local generation can be slow, especially without a GPU
            timeout=max(self.request_timeout, 900),
        )
        prompt_tokens = response.get("prompt_eval_count") or 0
        if prompt_tokens >= self.context_length - 64:
            print(
                f"\033[31mWarning: the prompt filled {model}'s {self.context_length}-token "
                "context and may have been cut off; raise llm_context_length.\033[0m"
            )
        content = response.get("message", {}).get("content", "")
        # reasoning models without separate thinking output put it inline
        return _THINK_BLOCK.sub("", content).strip()

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
        if self.openai_compatible:
            # local servers implement the older parameter names only
            kwargs["max_tokens"] = self.max_tokens
        else:
            kwargs["max_completion_tokens"] = self.max_tokens
            if self.effort:
                kwargs["reasoning_effort"] = self.effort
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            **kwargs,
        )
        content = response.choices[0].message.content or ""
        return _THINK_BLOCK.sub("", content).strip() if self.openai_compatible else content


class Embeddings:
    """Text embeddings for skill and question retrieval.

    provider "openai" uses the OpenAI embeddings API. provider "ollama" uses an
    embedding model running in Ollama (default nomic-embed-text; download it
    with `ollama pull nomic-embed-text`). provider "local" uses a
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
        elif provider == "ollama":
            self.model_name = model_name or DEFAULT_OLLAMA_EMBEDDING_MODEL
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
        if self.provider == "ollama":
            vectors = []
            for i in range(0, len(texts), 64):
                res = ollama_post(
                    "/api/embed",
                    {"model": self.model_name, "input": texts[i : i + 64]},
                    timeout=600,
                )
                vectors.extend(res["embeddings"])
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
