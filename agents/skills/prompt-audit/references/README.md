# Rubric file contract

Both bundled model guides (this directory) and custom criteria
(`$XDG_CONFIG_HOME/prompt-audit/`) are Markdown files with frontmatter:

- `model:` — a model id (`claude-opus-4-8`), a list (`[claude-opus-4-8, claude-sonnet-4-6]`),
  or `"*"` / omitted for model-agnostic. Matched **strictly** against the model
  that answered each prompt.
- `kind:` — `judgment` (default) sends the file's prose to the `claude -p` pass;
  `deterministic` supplies parameters to the free rule checks.

Deterministic files may set these keys (all optional):

- `max_words:` <int> — flag prompts longer than this.
- `banned_words:` [list] — flag these words.
- `enable:` [list] — turn on additional built-in checks by id
  (`late_constraint`, `faulty_premise`, `ambiguous_referent`, `max_words`,
  `banned_words`). `late_constraint`, `faulty_premise`, `ambiguous_referent`
  are on by default. `max_words` and `banned_words` auto-enable whenever the
  matching key is present in a file's frontmatter, so they need no `enable`
  entry; listing them there is redundant but harmless.

Judgment files carry free prose: the guidance/criteria the model should judge
against.
