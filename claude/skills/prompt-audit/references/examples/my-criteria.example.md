---
model: "*"
kind: deterministic
max_words: 400
banned_words: [corpus, chain, cap, grain]
enable: [max_words, banned_words]
---

Copy this file to `$XDG_CONFIG_HOME/prompt-audit/` and edit. This example bans a
few coined words and flags overly long prompts, for every model.
