"""A small persistent vector store for skill and question retrieval.

Replaces chromadb. Voyager stores at most a few thousand short texts, so a
JSON file and brute-force cosine similarity are plenty. The index records
which embedding model built it and re-embeds everything when that changes,
so the source of truth stays in skills.json / qa_cache.json and the index can
always be rebuilt from them.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, Optional, Tuple

import numpy as np

from .llm import Embeddings


class VectorStore:
    def __init__(self, path: str, embeddings: Embeddings):
        self.path = path
        self.embeddings = embeddings
        self.ids: List[str] = []
        self.texts: List[str] = []
        self.metadatas: List[dict] = []
        self._matrix = np.zeros((0, 0), dtype=np.float32)
        self._load()

    def __len__(self):
        return len(self.ids)

    def _load(self):
        if not os.path.exists(self.path):
            return
        with open(self.path) as f:
            data = json.load(f)
        if data.get("embedding_model") != self.embeddings.model_name:
            # built by a different embedding model; the caller re-syncs
            return
        self.ids = data["ids"]
        self.texts = data["texts"]
        self.metadatas = data["metadatas"]
        self._matrix = np.asarray(data["vectors"], dtype=np.float32)

    def save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(
                {
                    "embedding_model": self.embeddings.model_name,
                    "ids": self.ids,
                    "texts": self.texts,
                    "metadatas": self.metadatas,
                    "vectors": np.round(self._matrix, 6).tolist(),
                },
                f,
            )
        os.replace(tmp, self.path)

    def add(
        self,
        texts: List[str],
        ids: Optional[List[str]] = None,
        metadatas: Optional[List[dict]] = None,
    ):
        if not texts:
            return
        ids = ids or texts
        metadatas = metadatas or [{} for _ in texts]
        self.delete(ids)
        vectors = np.asarray(self.embeddings.embed(texts), dtype=np.float32)
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-12
        self.ids.extend(ids)
        self.texts.extend(texts)
        self.metadatas.extend(metadatas)
        self._matrix = (
            vectors if self._matrix.size == 0 else np.vstack([self._matrix, vectors])
        )
        self.save()

    def delete(self, ids: List[str]):
        drop = set(ids)
        keep = [i for i, id_ in enumerate(self.ids) if id_ not in drop]
        if len(keep) == len(self.ids):
            return
        self.ids = [self.ids[i] for i in keep]
        self.texts = [self.texts[i] for i in keep]
        self.metadatas = [self.metadatas[i] for i in keep]
        self._matrix = self._matrix[keep] if keep else np.zeros((0, 0), np.float32)
        self.save()

    def sync(self, entries: Dict[str, Tuple[str, dict]]):
        """Make the index hold exactly ``entries`` ({id: (text, metadata)}),
        embedding only what is missing or changed."""
        current = dict(zip(self.ids, self.texts))
        stale = [i for i in self.ids if i not in entries or current[i] != entries[i][0]]
        self.delete(stale)
        missing = [i for i in entries if i not in set(self.ids)]
        if missing:
            print(f"\033[33mEmbedding {len(missing)} entries into {self.path}\033[0m")
            self.add(
                texts=[entries[i][0] for i in missing],
                ids=missing,
                metadatas=[entries[i][1] for i in missing],
            )

    def search(self, query: str, k: int) -> List[Tuple[str, str, dict, float]]:
        """Return up to k (id, text, metadata, cosine similarity), best first."""
        if not self.ids or k <= 0:
            return []
        q = np.asarray(self.embeddings.embed([query])[0], dtype=np.float32)
        q /= np.linalg.norm(q) + 1e-12
        scores = self._matrix @ q
        order = np.argsort(-scores)[:k]
        return [
            (self.ids[i], self.texts[i], self.metadatas[i], float(scores[i]))
            for i in order
        ]
