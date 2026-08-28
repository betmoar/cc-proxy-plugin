---
name: model-router
description: Triage work before doing it — decide whether the upcoming task needs a smarter, cheaper, faster, or specialist model, then route it (or fan independent pieces out across parallel subagents on different cc-proxy models). Use whenever the user is about to start real work — a feature, a refactor, a bug hunt, a review, a research sweep, a batch of similar items — or asks which model to use, wants to save quota, complains a task is overkill for the current model, or asks to parallelize. Trigger BEFORE writing the first line of code for any non-trivial request, even if the user didn't mention models at all.
---

# Model router

You are choosing models the way a tech lead staffs a project: by what the
work actually is, not by what happens to be loaded. The proxy exposes a
model catalog; this skill turns that catalog into a staffing decision.

**One boundary you must not cross:** the proxy itself never classifies
prompts — it is a transparent pipe. The triage in this skill happens in
YOUR judgment, here, before work starts. If you ever find yourself wanting
the proxy to route automatically per request, stop: that is a different
product, and the answer is a settings default or an explicit selector,
not proxy logic.

## 1. Load the catalog

Fetch the live catalog once per session (not per task):

```bash
curl -s http://127.0.0.1:4000/v1/models
```

Each entry carries:

| Field | Meaning |
|---|---|
| `id` | The exact id to give a subagent or `/model`. May carry a `<provider>:` lens — keep it, it names the route |
| `provider` | Which backend serves it |
| `tier` | Route cost: `1` OAuth/Anthropic, `2` prepaid plan, `3` metered credits, `4` reseller. Lower is cheaper |
| `grade` | Model capability, **only when assessed**: `Flagship` (hardest reasoning), `Strong` (solid general work), `Specialist` (narrow remit — cheap models, old generations, single-purpose builds). Absent = never assessed. `grade` and `tier` are independent axes — never derive one from the other |
| `context_window` | Integer tokens, when curated. Omitted when unknown |

Entries with `usable: false` cannot complete a turn — never staff them.
Ids with no `grade` are unknown quantity: do not staff them for anything
that matters without checking first.

## 2. Triage the task

Ask three questions, in order:

1. **What kind of work is this?** Judgment (architecture, design tradeoffs,
   tricky debugging, final review, anything where being wrong is expensive)
   · Implementation (writing code to a known spec) · Mechanical (edits a
   careful person could specify exactly — renames, formatting, verbatim
   changes, transcription) · Recon (searching, reading, summarizing,
   looking things up).
2. **What does it cost to be wrong?** A wrong refactor of core routing
   costs days. A wrong summary costs a re-run.
3. **Is it parallel?** Independent pieces — files that don't overlap,
   unrelated research questions, a batch of similar items — can fan out.
   Dependent steps cannot; do not fake parallelism by queuing subagents
   on one pool.

## 3. Match the work to a grade

Default mapping — deviate when the specific task earns it:

| Work class | Grade | Rationale |
|---|---|---|
| Judgment | `Flagship` | Being wrong is expensive; this is what flagship capacity is FOR |
| Implementation | `Strong` | Knows the spec, writes working code, costs less |
| Mechanical | `Specialist` | Cheapest capable model; a careful spec is the whole game |
| Recon | `Specialist` | Reading and summarizing rarely needs flagship reasoning |

Cost tiebreak, within the chosen grade: lower `tier` wins (plan capacity
beats metered credits beats reseller). Larger `context_window` wins when
the task carries big inputs. If the grade has several candidates, prefer
the one whose provider is already in use for the session — fewer moving
parts, same quality.

**The three overrides:**

- **Smarter**: escalate to `Flagship` when the Strong-tier draft keeps
  missing something, when the task silently grew judgment-level stakes
  (a "small fix" that turns out to touch the routing core), or when the
  user is about to make an irreversible call based on the answer.
- **Faster/cheaper**: drop a grade when the task turned out smaller than
  it looked — one file, one function, an obvious bug. Doing this out loud
  ("this is a Specialist task, running it there") teaches the user what
  to expect and keeps Flagship capacity free for work that needs it.
- **Specialist**: some models are narrow on purpose (a code-completion
  model, an old cheap generation). Staff them at what they are good at,
  never at whatever the id looks like it should be.

## 4. Fan out when it's parallel

For independent work, dispatch one subagent per piece. Say in the
subagent's prompt which model it runs on and why it was chosen — one
line, not a lecture:

```
TASK: <the piece of work>
MODEL: <id> (<grade>, <one-line reason>)
CONTEXT: <what the subagent needs; nothing more>
OUTPUT: <exactly what to report back>
```

Rules that keep fan-out honest:

- **Disjoint scope or no fan-out.** Two subagents editing the same file is
  not parallelism, it is a merge conflict with extra steps. Split by
  module, by directory, or by question — never by "they'll figure it out".
- **The main thread integrates.** Subagents return reports; YOU merge,
  resolve conflicts, and own the final result. Never let a fan-out become
  an unreviewed pile.
- **Verify each piece.** A subagent's "done" is a hypothesis — check the
  diff or the claim before counting it. Fan-out multiplies the surface
  that can silently fail.
- **Cap the width.** More than ~4 concurrent subagents usually means the
  task was one task. Split along real seams, not for its own sake.

## 5. Say the routing out loud

One line to the user before the work starts, so the choice is visible and
correctable:

> Routing: triage says Implementation on a Strong model (`glm-5.2`), 2
> parallel recon sweeps on Specialists (`qwen3.6-flash`, `glm-4.5-air`),
> integration stays here.

If the user overrules, comply immediately — they know their quota and
their preferences better than the triage does.

## 6. When NOT to route

- The task is trivial (a typo, a one-liner): just do it; routing costs
  more than it saves.
- The current model is already the right grade: say so in half a line and
  move on.
- The user explicitly picked a model: that decision outranks the triage.
- The catalog is unreachable: never guess at model ids — say the proxy
  isn't answering and let the user decide.
