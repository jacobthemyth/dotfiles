# Slack summary prompt

Use this to produce the weekly `slack-<START_DATE>.md` file that the status-report skill reads
in step 5. Run it in a session that has Slack access (e.g. Claude with the Slack connector),
then save the result to `<slack_export_directory>/slack-<START_DATE>.md`.

Before sending, substitute:

- `<SLACK_USER_NAME>` — the `slack_user_name` value from `~/.config/status-report/config.json`
- `<START_DATE>` / `<END_DATE>` — the reporting period (Monday and Sunday, `YYYY-MM-DD`)

---

I need you to export Slack thread summaries for me (<SLACK_USER_NAME>) for <START_DATE> through <END_DATE>.

## What to collect

Find all Slack threads where **@<SLACK_USER_NAME>** participated (sent at least one message or was
specifically mentioned) during the date range. Include the full thread context with all
participants, not just my messages.

## Output format

Write the output to a single markdown file.

Each thread must follow this exact format, separated by `---`:

```
Summary of thread in #channel-name
Mon DD
NN messagesNN
N usersN
@User1 does X, @User2 provides Y. (one-line summary of the full thread)
Less detail

    @User1 shares info about the problem [1]
    @User2 explains the solution [2]
    @User3 confirms the fix worked [3]

---
```

### Format rules

- **Line 1:** `Summary of thread in #channel-name` (include the `#` before channel name)
- **Line 2:** Date or date range (e.g., `Mar 15` or `Mar 14 - 15`)
- **Line 3:** Message count in format `NN messagesNN` (number repeated with no space before the word)
- **Line 4:** User count in format `N usersN` (number repeated with no space before the word)
- **Line 5:** One-line summary of the entire thread, mentioning participants as `@Display Name`
- **Line 6:** `Less detail` (literal text)
- **Line 7:** Blank line
- **Lines 8+:** Indented (4 spaces) detail bullets, each starting with `@Display Name`, ending with `[N]` reference numbers
- **Last line of thread:** Blank line, then `---` separator before the next thread

### Example

```
Summary of thread in #eng-support
Mar 12
8 messages8
2 users2
@Alex Chen is investigating a deployment failure, and @<SLACK_USER_NAME> identifies the root cause as a misconfigured health check.
Less detail

    @Alex Chen reports that the staging deployment is failing with timeout errors [1]
    @<SLACK_USER_NAME> checks the pod logs and finds the health check endpoint returning 503 [2]
    @Alex Chen confirms the health check path was changed in a recent PR but not updated in the Helm values [3]
    @<SLACK_USER_NAME> suggests updating the readiness probe path and redeploying [4]
    @Alex Chen applies the fix and confirms the deployment succeeds [5]

---
```

## Important notes

- Include threads from **all channels** I participated in during this period
- Include **every thread** where I sent at least one message, even if my contribution was minor
- Preserve the **original display names** of all participants exactly as they appear in Slack
  (e.g., `@Alex Chen`, not `@alex.chen`)
- Each detail bullet should summarize **one message or a small cluster of related messages**
- Keep the one-line summary factual and concise
- Order threads **chronologically by date, newest first**
- The deliverable should be attached as a text snippet in Markdown format named
  `slack-<START_DATE>.md` e.g. `slack-2026-06-22.md` (for the week starting 6/22).
