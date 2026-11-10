---
name: "restructure-for-feedback"
description: "Rebuild a long, sprawling draft (often from a long agent session) into a readable early-feedback doc for one or two colleagues, checked by blind reader and fidelity evaluators."
---

# Restructure for feedback

The input is a draft that has the right information but the wrong shape. It usually came out of a long discussion with an agent, so it's organized the way the conversation went, it's sized by how long each topic was discussed, and it carries the session's shorthand. The output is a doc Jake can send to one or two colleagues to find out whether the idea is worth more of his time.

Those readers know the domain and the team's context. They don't expect polish. They do expect to understand the idea in a couple of minutes, see what he wants from them, and not have to dig for it. The doc isn't the final version. Jake will rewrite it himself before sharing it widely, so aim for clear and honest, not finished.

This is a rebuild, not an edit. Line edits on a badly structured draft give you a badly structured draft with nicer sentences. The core move is to pull the content out, throw away the original prose, and write again from the content.

## Ground rules

- It's Jake's idea. Don't add arguments, resolve questions the draft leaves open, or make the proposal sound more certain than it is. If the draft's unsure about something, the new doc should be too, and should say so plainly.
- Don't invent facts, numbers or names. If something's needed and missing, put it in the open questions.
- Cutting is expected, but every cut is reported at the end so Jake can put things back.
- Don't stop to ask questions unless the readers or the feedback he wants can't be inferred from the draft or the conversation. If he isn't around, make the call and say what you assumed at the top of the report.

## Steps

Keep working files in a scratch folder: `inventory.md`, `brief.md`, `outline.md`, `v0.md`, `v1.md`, and so on, plus a scorecard per version. Never overwrite a version.

### 1. Inventory the content

Read the whole draft and pull out every distinct item: proposals, decisions, constraints, facts and numbers, rejected alternatives, risks, open questions. One line each, in plain words, with where it came from in the draft. Tag each one:

- **core**: the reader can't evaluate the idea without it
- **supporting**: it helps the reader judge a specific part
- **background**: these readers already know it, or a link would do
- **residue**: it's about how the session went, not about the idea (dead ends that don't inform the decision, restated corrections, process notes)

Also list every named thing in the draft (components, patterns, labels) and mark where each name comes from: the vendor ("dead-letter topic"), the team, or the session. Session-coined names get replaced by the plain description or the vendor/team term. If a concept really needs a new name, keep it, define it once, and flag it in the report.

The inventory is the source of truth from here on. The original prose isn't used again except for the fidelity check.

### 2. Write the reader brief

Short, in `brief.md`:

- Who's reading, and what they already know.
- The feedback Jake wants: usually some mix of "is this worth pursuing", "what am I missing", and specific questions he's unsure about.
- Five to eight questions these readers will show up with, most important first. These become the reader test.

### 3. Outline from the inventory

Each heading should be a claim, not a topic: "Parity drifts because cell configs are copied by hand" rather than "Background". The usual shape for an early-feedback doc is below, but drop anything that'd be filler and reorder if the idea calls for it:

1. **The ask.** Two or three sentences at the very top: what this is, what feedback he wants, and that it's an early draft.
2. **The problem.** Why this matters now. Short. These readers know the territory.
3. **The proposal.** One paragraph a reader could repeat back.
4. **How it would work.** Spend the words where the trade-offs, risk and disagreement are, not where the session spent its time. Settled or obvious parts get a sentence.
5. **Alternatives considered.** Brief, including doing nothing, with why each lost.
6. **Open questions.** Where Jake is unsure, framed as questions a colleague could answer.

Aim for something readable in about ten minutes, usually one to three pages. Core items have to land somewhere. Supporting items go where they help or get cut. Background and residue are cut.

### 4. Draft from scratch

Write `v0.md` from the brief, outline and inventory only. If a subagent tool is available, hand those three files to a fresh subagent and don't give it the original draft. This is the step that breaks the old structure, so don't skip it by editing the original.

Writing guidance for the drafter:

- Write the way a senior engineer explains something to a peer: contractions, plain "X is Y" statements, a mix of short and long sentences.
- Put the point of each section in its first sentence.
- Use prose when ideas connect. Use lists only for parallel, independent items.
- State each rule or constraint once, as a fact about the thing it governs. Don't phrase it as an order to an implied implementer and then repeat it as a negation.
- Use the vendor's or team's terms. Don't coin labels.
- Say plainly when something's uncertain ("I'm not sure yet whether…"). Don't hedge everything else to match.
- No summary paragraphs at the end of sections, no significance claims, no bold scattered through the text.

### 5. Evaluate with two blind evaluators

Run both in parallel, each as a fresh subagent. Neither sees the conversation, the writer's reasoning, or earlier versions.

**Reader evaluator.** Give it the current draft, the reader description from the brief, and the reader questions. Nothing else. Ask it to:

- Answer each reader question from the draft alone, or say it can't.
- List any term it couldn't pin down.
- Say which sections it would skim or skip, and where it got lost.
- Score the rubric below, with a one-sentence reason per dimension.
- Name its top three fixes.

**Fidelity evaluator.** Give it the inventory and the current draft. Nothing else. Ask it to:

- Mark each core and supporting item as present, distorted (with how), or missing.
- List anything the draft claims that isn't in the inventory.

The fidelity check fails if any core item is missing or distorted, or the draft invents a claim. Missing supporting items are fine if they were cut on purpose. Note them for the report.

**Rubric** (1 to 5; 5 is the anchor):

- **Point first:** after the first screen, a reader can state the proposal and the ask.
- **Proportion:** detail sits where the risk and trade-offs are. Nothing important is a one-liner, and nothing settled gets a page.
- **Terms:** every term is standard, the team's, or defined on first use.
- **Plain prose:** reads like a person explaining it, without the patterns in step 4.
- **Honest uncertainty:** open questions are visible and specific, and settled things aren't hedged.

Don't change the rubric or the reader questions during the loop.

If no subagent tool is available, run the evaluators as separate passes using only the inputs listed above. Say in the report that the evaluation wasn't blind.

### 6. Revise, with a cap

At most two revision rounds after v0, so three versions total. Each revision fixes every fidelity failure plus the reader evaluator's top three fixes, working from the brief, inventory and current draft. Re-evaluate each new version with fresh evaluators.

Stop as soon as one of these happens:

- Fidelity passes and every rubric score is 4 or higher.
- The rubric total improves by less than 2 points over the previous version.
- Any dimension drops by 2 or more, or fidelity newly fails. Revert to the previous version and stop.
- The cap is reached.

The final doc is the best version that passed fidelity. If none passed, deliver the closest one and say what's still wrong.

### 7. Deliver

Deliver the doc in the same form as the input: a new doc artifact if the input was one, otherwise a markdown file. Never overwrite the original. Then give a short report:

- Assumptions made, if Jake wasn't around to ask.
- Rounds run, final scores, and why the loop stopped.
- What was cut, as a short list grouped by tag, so he can restore anything.
- Terms renamed or newly defined.
- Anything the evaluators still flagged that he should look at before sending.
