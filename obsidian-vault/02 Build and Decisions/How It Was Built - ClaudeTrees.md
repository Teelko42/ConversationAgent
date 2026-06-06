---
title: How It Was Built - ClaudeTrees
aliases: [ClaudeTrees, Build Process, How It Was Made]
tags: [process, meta]
created: 2026-06-05
---

# How It Was Built — ClaudeTrees

> [!abstract] In one paragraph
> A team of AI helpers (**ClaudeTrees**) split the job into independent pieces, worked
> on them at the same time, and stayed in sync by writing notes in **shared text files**
> — no database, just a folder acting as a whiteboard. A **conductor** sliced the work
> and integrated it; **workers** each owned one piece; a **scribe** kept the "things a
> human must still do" list. It produced first a design ([[The Blueprint Documents]]),
> then the working Phase-0 [[System Architecture|code spine]].

This is the meta-story of *how this repository came to exist*. The orchestration
scaffolding lives (git-ignored) under `.claudetrees/`.

---

## The three things that did the work

1. **ClaudeTrees** — the way the AI helpers split up and coordinated.
2. **The architecture docs** — the design plan written *before* any code ([[The Blueprint Documents]]).
3. **Worktrees** — a "separate workspace" trick that here was correctly judged *unnecessary*.

---

## How ClaudeTrees coordinates: just files

No fancy software. A **lead (conductor)** splits the job and reassembles it; one
**worker per piece** works in its own folder so two workers can never edit the same
file; a **scribe** consolidates every "a human must do this" item into one list.

```
.claudetrees/
└── runs/
    ├── 20260531-conversation-intel/   ← Round 1 (the design plan)
    └── 20260601-phase0-spine/         ← Round 2 (the working skeleton)
```

Each **run** is one complete job. Inside it:

**Shared files (the "public agreement", top level of a run):**

| File | Purpose |
|---|---|
| `IDEA.md` | the original request in full, plus scope (in/out) and assumptions |
| `DECISIONS.md` | the rulebook — shared choices (names, tools, speed targets) labeled D01, D02… |
| `FEATURES.md` | the master list of pieces ("lanes"): goal, owned files, deps, "done when" |
| `DISPATCH.md` | the job board — one row per worker (waiting / running / done / stuck) |
| `STATUS.md` | overall run progress |
| `BLOCKERS.md` | cross-worker blockers (stayed empty here) |
| `NEEDS_USER.md` | the merged "human must do this" list (the **27 tasks**) |
| `INTEGRATION*.md` | the lead's write-up of joining the pieces (incl. the famous bug) |
| `PHASES.md` | (Round 2) the roadmap of future rounds |

**Per-worker files (`features/<name>/`, the "private desk"):** `FEATURE.md`
(assignment + owned files), `PLAN.md`, `STATUS.md`, `RESULT.md`, `MANUAL.md`
(human-only tasks — **never contains secret values, only which key is needed**),
`NOTES.md` (scratch, e.g. a disagreement with a shared rule).

> [!info] The whole coordination model
> The shared files at the top are the **public agreement**; each worker's folder is its
> **private desk**. Workers read the public files, work on their own desk, and never
> reach onto anyone else's. That convention *is* the entire sync mechanism.

---

## The two rounds

### Round 1 — write the plan (`20260531-conversation-intel`)
The brief: design an app that listens and explains. Round 1 produced the **design, not
code**. The lead wrote the goal, the shared decisions, and the list of pieces; then
**5 workers ran in parallel** (capture, speech, experience, platform/security, business);
the scribe gathered **27 human-action tasks** (10 High). Result: ~17 design documents
([[The Blueprint Documents]]), no working code yet. The design then went through an
**adversarial validation + remediation pass** (docs 09–13) that found and fixed its own
holes — see [[Architecture Decisions|D17–D20]].

### Round 2 — build the skeleton (`20260601-phase0-spine`)
The goal: get one short audio clip to travel **all the way through** — recorded →
transcribed → explained → shown — using **stubs** for the paid services. Same one-folder-
per-worker rule. Finished with **all tests passing** and a `run-spine` script. Everything
real (live STT, real AI, web search, hosting) was left for the 27 human tasks.

The commit history shows the rounds and then the feature work layered on:

```
f7d5940 ClaudeTrees scaffolding: bus files, lane plans, decisions
3fbd05a Aizen blueprint: 5 lanes + integrated docs
142a911 Blueprint validation + remediation: 5 integration docs
334477e Promote decisions ledger in-tree (D01-D20, INV-8/9)
47302c0 Phase 0 foundation: contracts + seams + LLM-gateway + IaC
17ea62b Phase-0 spine: capture→STT→intel→render over one event bus
2aae9f6 Add follow-up answers, sentence explanation, Document-PiP, client harness
9d6d2a4 Add account system, speaker diarization, Azure/Docker infra
3e2b8f6 Obsidian Local Patch
b77084c UI update
```

---

## What was good — and what wasn't

> [!success] What worked
> - **Faster** — five parts at once instead of one after another.
> - **No collisions** — each worker owned its own folder.
> - **Consistent** — writing the shared decisions first meant separately-built parts fit.
> - **Nothing forgotten** — every human task landed in one list.
> - **Fully auditable** — every worker left notes on what it did.

> [!failure] What didn't
> - **Rules were promises, not locks.** "Don't touch another worker's files" held only
>   because workers were polite.
> - **It missed a hidden disagreement.** Two workers used a field with the same *name*
>   but different *meaning* (the **H-7** `rev`/`supersedes` drop) — a feature quietly
>   broke. They agreed on the word, not the meaning.
> - **Passing tests gave false comfort.** The broken piece *passed its own tests*
>   because the fixture happened to dodge the problem; it only broke when real parts met.
> - **The first "all green" was a patch over the bug**, fixed properly later
>   (see [[Correction Seams]] / INV-8).
> - **Lots of paperwork** for a small job.
> - **It produced a plan + a stubbed demo** — the 27 real-world tasks still need a human.

---

## Worktrees: the trick that wasn't needed

A **git worktree** makes a second separate copy so parallel work can't collide. Both
rounds **correctly decided not to use it** — the one-folder-per-worker rule already
prevented collisions. One leftover worktree (`worktree-phase1-foundation`) exists, is
disconnected, was never merged, and points at an old commit. It's just cleanup:

```powershell
git branch -D worktree-phase1-foundation
Remove-Item -Recurse -Force .claude\worktrees\phase1-foundation
```

---

## Related
- [[The Blueprint Documents]] — the ~17 design docs Round 1 produced
- [[Architecture Decisions]] — the rulebook (`DECISIONS.md`) promoted in-tree
- [[Correction Seams]] — where the H-7 "hidden disagreement" bug was actually fixed
- [[System Architecture]] — what Round 2 built
