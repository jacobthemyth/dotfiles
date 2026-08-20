---
name: fifty-centify
description: Use when editing technical prose for readability: when sentences read like database schemas, when set notation has crept into paragraphs, when phrasing is borrowed from log fields or query plans, when em-dashes or fancy unicode survived avoid-ai-writing, or when the author asked to make a doc "simpler," "less academic," or "easier to read without context."
---

# fifty-centify

Don't use a five-dollar word when a fifty-centify one will do. An editing pass for technical prose: keep the precise terms that carry information; swap the abstract nouns, math notation, and internal jargon that don't.

## When to use

- The prose is dense with set/math notation, ranges, or code-fenced field names mid-sentence.
- The doc reads as if the author is still inside the codebase. A reader who Cmd-F's the system shouldn't *also* need the team's slang to parse the prose around the results.
- The author asked for "plainer," "less jargon," "readable for someone who doesn't already know this."
- You're moving the doc to Notion, a PR description, a Slack post, or anywhere outside the original repo.

**Don't** when the doc is already plain (don't paraphrase to look busy), when the author deliberately chose a precise term you'd soften (ask first), or when it isn't prose (a query, filter, log line, config block).

## How to apply

For each sentence, ask: could a smart reader who isn't inside this codebase parse it on first read? If not, replace the machinery with English - without changing what the sentence means or which numbers it cites.

| Five-dollar form | fifty-centify form |
|---|---|
| `N ∈ {6, 7}` (in prose) | "6 or 7", "of length 6 or 7" |
| "the X bucket / set / population" | "X" |
| "exhibits a non-trivial fraction of" | "many of" |
| "in the absence of" / "subsequent to" / "in order to" | "without" / "after" / "to" |
| "leverage / utilize" / "facilitates" / "demonstrates" | "use" / "lets" / "shows" |
| nominalized verbs ("performs an aggregation") | the verb ("aggregates") |
| "the fact that" | (delete) |
| field/schema name mid-sentence (`p99_latency_ms`) | the noun phrase ("p99 latency"), field name in parens if the reader must grep it |
| flat hedge with no content ("works pretty well") | a sharper phrase of the same strength ("earned its keep"). Sparingly; don't invent metaphors that change the claim |

These are examples, not a checklist - the point is the *move*. Obvious typos and missing words in the prose are fair game too.

## The pass isn't done until you produce the audit

Stripping symbols is the easy half; it fires on every doc because it's a lookup over a closed list. The judgment half - renaming coined terms, dedup, deletions, flagging - tends to fire only when the doc happens to resemble an example here. So turn *recognition* ("did I notice a coined term?") into *enumeration* ("list every term, then judge each"). Produce these four lists before reporting done. They are **required output**; an empty list is a claim ("I scanned the whole doc and found none"), so you must have scanned. On a real doc, lists 1-3 are almost never legitimately empty.

1. **Abbreviations and coined terms.** List every acronym, abbreviation, and coined or hyphenated term in the prose (not code, not quotes). For each, give the Cmd-F verdict (below): *rename* (with the replacement) or *preserve* (naming the external surface that would break). "Didn't notice any" is not a verdict.
2. **Headings and table columns.** List each. Does the surrounding section already establish a qualifier sitting inside it (scope, time, env)? If so, drop it.
3. **Compact and math-in-prose forms.** List every duration prefix (`5d`, `9h`, `1m`), `X=Y` / set / interval notation, and `sub-` or `ex-` prefix. Rename or preserve each.
4. **Judgment flags.** The 3-5 items you left for the author to decide (see "Make a list" below).

If you're a subagent with no way to follow up, these four lists ARE your report. The hard half should leave checkable evidence, the same way a stripped em-dash does.

## Hard-to-type characters

**First, fence off every direct quote** - text inside quotation marks, a `>` blockquote, a log line, an alert, or tool/CLI output. It reproduces someone else's words and is not yours to edit; every swap in this skill operates *only on the doc's own prose*. A glyph inside a quote stays exactly as written, em-dash and all. This is structural, not a case-by-case call: settle what is quoted first, then swap only outside those spans.

In the doc's own prose, replace any character that takes more than SHIFT on a US keyboard - nobody types them by accident and they read as ostentatious. Be strict even after `avoid-ai-writing`; it leaves em-dashes that look "earned," and this skill removes them.

| Character | Replace with |
|---|---|
| em-dash (`—`) | ` - `, or split the sentence, or `,` / `:` / `(...)` |
| en-dash (`–`) | `-` for ranges, or "to" |
| arrows (`→ ← ⇒ ↔`) | `-> <- => <->` |
| section symbols (`§ ¶`) | drop; for a section pointer use a markdown anchor link |
| curly quotes (`“ ” ‘ ’`) | straight `" '` |
| ellipsis `…`→`...` · multiplication `×`→`x` · middle dot/bullet `· •`→drop or list syntax · nbsp/zero-width→space or delete |

Outside direct quotes there's no edge case where an em-dash survives; inside one it always does, because the quote is not yours to touch. **Carve-out:** leave emoji (✅ ⚠️ 🚀) alone.

## Don't touch

The default for any candidate is to swap. Preservation needs a reason from this list - "doc-internal consistency," "compact in a cell," "the linked doc uses it," and "domain idiom" are not reasons.

- **Load-bearing identifiers** naming a real thing in code or queries: error codes, span names, field names, file paths (`ECONNABORTED`, `RunActivity`, `p99_latency_ms`). Renaming them in prose breaks Cmd-F against the code, queries, and alerts.
- **Numbers, units, time windows.** "30 minutes" stays; don't paraphrase to "around half an hour." Math notation *around* numbers is fair game (`N ∈ {6,7}` → "6 or 7"). Interval notation like `(0.03, 0.06)` is math mid-sentence but a label in a table cell - leave it in the cell.
- **Terms load-bearing *outside* this doc** (apply the Cmd-F test). Where a coined term also appears in displayed copy-paste queries, rename it in both.
- **Direct quotes** from logs, alerts, or tools.

### The Cmd-F test

For each abbreviation, label, or coined term: **would renaming it break Cmd-F against an external surface - a query, dashboard, alert, code path, or thread someone might search?**

- **Yes** → preserve (clarify inline if needed).
- **No** → rename. If you can't answer without reading sibling docs, the answer is "no external use" → rename.

Doc- and docset-internal use is not external use - "load-bearing *within* the doc" and "the linked doc defines it" are the exact case this rule excludes. "Domain idiom" without a real external corpus you can cite is just doc-coined. "Judgment call: leaving as-is" with no Cmd-F answer is a rationalization.

## Default to shorter; rename instead of explaining

A good pass usually nets shorter. When a term confuses readers, a glossary is rarely the fix - it forces a context-switch and the term stays opaque. Prefer, in order: (1) rename the term so the label says what it measures; (2) define inline at first use in a brief parenthetical; (3) glossary, rarely. When renaming, prefer vocabulary the field already uses; don't coin a new label when a standard one fits.

## Heading and column dedup

Drop qualifiers from headings and columns when the context already establishes them: a `### ... at baseline` heading inside a `## Baseline` section drops "at baseline"; a column `` `p99_latency_ms` (us-east-1, prod) `` inside a section already scoped to us-east-1/prod becomes "p99 latency"; a heading with a precise-but-irrelevant timestamp the body already gives drops it. If the doc has an implicit default scope, label only the non-default sections. These aren't ambiguous - apply directly, don't flag.

## Deletions

After the word pass, switch frames and scan the doc *structure* - sentence-level thinking misses table rows, whole bullets, and cross-references. Read the intro for the headline question ("is X worth doing?" / "what's causing Y?"), then ask of each row, bullet, and reference: does it serve that question?

**Direct delete is fine** (high-confidence, unambiguous):
- Throat-clearing prose right before a table/list that makes the same point.
- Cross-references that don't support the local claim (removing them doesn't change what the sentence claims).
- Off-topic table rows or subsections when the intro names a specific subject (a "Rover" row in a Haiku-only doc). Only when the scoping is unambiguous from the intro.

**Flag, don't delete, for everything else** - long enumerations (15 org names "for completeness"), paragraph compressions, anything that changes voice or removes a claim. If the reader would notice the absence and miss something, flag it. In a live conversation, ask before deleting non-trivial content.

## When you can't decide: make a list, not a question

The list is the async version of a clarifying question. 3-5 items per doc; if you're flagging dozens, re-pass with a freer hand. Each entry: original text, why uncertain, what the aggressive edit would have been. **Only for preserved cases** - if you edited it, you made the call; don't flag a phrase that silently fell out of a rewrite, restore it or own the cut.

Belongs on the list:
- **Voice register** inconsistent across the doc - could be the author, could be agent residue. Don't flip it.
- **Hedges** ("roughly," "essentially") - could be earned humility, could be vagueness.
- **Verb shifts that change weight** ("validates" → "checks") when the original verb was load-bearing.
- **Terms used before they're defined.** Don't paraphrase (it breaks searchability and coins a new undefined term); flag with line-of-use and, if you can spot it, line-of-definition.
- **Candidate deletions** that didn't make the carve-out above.

## Worked example

Before:
> In the watchdog-corrected data, the `MAX(attempt) = N` buckets for `N ∈ {6, 7}` contain a large fraction of "single-event" retry-chains: workflows whose `Activity failed` log set has only 1 event (zero retry-chain duration).

After:
> The logs show many retry chains of length 6 or 7 with only one logged failure, so the measured duration is 0 s.

Math notation → plain English ("of length 6 or 7"); schema-shaped phrasing → natural noun phrase; the doc-coined "single-event" dropped (internal categorization, not load-bearing outside, and the description makes it self-evident). Preserved: "retry chain" (load-bearing term), the exact numbers, the logic chain. Cmd-F in action elsewhere: `evicts` → "evictions" (Redis uses `evicted_keys`, not `evicts`); `14d` → "14-day."

## Red flags: back out the edit

- **Lost information** - a quantity dropped ("99%" → "many"), a load-bearing distinction collapsed, the claim got softer even as the sentence got shorter.
- **Lost searchability** - an identifier renamed in prose; a defined term replaced with a synonym.
- **Silent emphasis loss** - `*`/`**` stripped as a side effect without flagging.
- **Vague-for-vague swap that drops a number** - "99% of requests" → "most requests." The "non-trivial fraction" → "many" swap is only OK when the original had no number. Test: does the original cite a number? Preserve it.

If any fire, revert that edit and try a smaller swap.
