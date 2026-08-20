"""Semantic clustering via a local ollama embedding model, with a stdlib
token-signature fallback when ollama is unavailable. Stdlib only (urllib for
ollama's HTTP API)."""
from __future__ import annotations

import json
import math
import re
import urllib.error
import urllib.request

OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings"
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
EMBED_MODEL = "nomic-embed-text"


class EmbeddingUnavailable(Exception):
    pass


def _embed_one(text, url, model, timeout=30):
    payload = json.dumps({"model": model, "prompt": text}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise EmbeddingUnavailable(str(exc)) from exc
    vec = data.get("embedding")
    if not vec:
        raise EmbeddingUnavailable("no embedding in response")
    return vec


def embed(texts, url=OLLAMA_EMBED_URL, model=EMBED_MODEL):
    return [_embed_one(t, url, model) for t in texts]


def ollama_available(url=OLLAMA_TAGS_URL, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError):
        return False


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return 0.0 if na == 0 or nb == 0 else dot / (na * nb)


def greedy_cluster(vectors, threshold=0.83):
    clusters = []
    for i, v in enumerate(vectors):
        for c in clusters:
            if _cosine(v, c["seed"]) >= threshold:
                c["members"].append(i)
                break
        else:
            clusters.append({"members": [i], "seed": v})
    return [{"members": c["members"], "representative": c["members"][0], "size": len(c["members"])}
            for c in clusters]


_WORD = re.compile(r"[a-z0-9]+")
def token_signature_cluster(texts, k=2):
    groups: dict = {}
    for i, t in enumerate(texts):
        sig = tuple(_WORD.findall(t.lower())[:k])
        groups.setdefault(sig, []).append(i)
    return [{"members": m, "representative": m[0], "size": len(m)} for m in groups.values()]


def cluster(texts, threshold=0.83, use_embeddings=True):
    if use_embeddings and ollama_available():
        try:
            return greedy_cluster(embed(texts), threshold=threshold), "embeddings"
        except EmbeddingUnavailable:
            pass
    return token_signature_cluster(texts), "token-signature"
