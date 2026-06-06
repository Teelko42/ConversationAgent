---
title: UI Redesign
aliases: [UI Redesign, Visual Design, Styles, Theme, Design Language]
tags: [design, frontend, ui]
created: 2026-06-05
---

# UI Redesign

> [!abstract] De-"AI-slop" the interface
> A 2026-06-04 pass (branch `UI_Updates`) to remove the generic **"AI-generated" look**
> while keeping the functional dashboard conventional (Jakob's Law — don't make users
> relearn a dashboard). Distinctiveness was pushed into the **identity layer only**: type,
> color, icons, and copy. Scoped to `packages/server/public/` (vanilla HTML/CSS/JS, no
> build). Reference: `docs/UI_REDESIGN.md`; backed by a deep-research pass (21 sources, 25
> claims, 18 confirmed).

This is the visual language [[The Browser Client]] renders.

---

## What changed

| Layer | Before | After |
|---|---|---|
| **Display type** | Inter | **Space Grotesk** (h1–h3, brand, eyebrows, stat values) |
| **Body type** | Inter | **IBM Plex Sans** (`--font-body`; display face never used for body) |
| **Canvas** | cool indigo `#eef1f8` | **warm paper** `#f4f2ec` |
| **Primary accent** | indigo `#2f4bda` | **deep teal** `#0f6e6c` |
| **Secondary accent** | violet | **terracotta** `#a8502f` (the "Aizen AI" accent — deliberately *not* AI-purple) |
| **Dark theme** | cool | warm charcoal `#16140f` |
| **Surfaces** | glassmorphism, ambient glows, film-grain, 58px grid | flat warm canvas; `backdrop-filter` dropped except a light blur on the sticky topbar |
| **Radii** | bubbly (lg 24 / md 18 / sm 12) | de-bubbled (**lg 14 / md 11 / sm 8**); buttons/search square-ish; chips stay pill |
| **Icons** | emoji-as-icons | inline **Lucide-style stroke SVGs** (capture, theme, popout, sign-in, source chips) |
| **Hero copy** | "Live Conversation Intelligence" | **"Hear it. Read it. Understand it."** |

> [!note] Color derived in OKLCH, shipped as hex
> Colors were derived in OKLCH for perceptual consistency but **shipped as hex**, so the
> [[Document Picture-in-Picture|PiP clone path]] (which re-injects styles into a new
> window) doesn't depend on newer CSS color syntax. ~25 indigo literals were swept; **0
> remain**.

> [!info] "Square cards" were already done
> Cards were already square (`border-radius:0` from a prior commit), so that specific
> "AI tell" was gone. This pass de-bubbled the *other* radii (lg/md/sm) and the buttons.

---

## Source chips & provenance icons

Citations render with provenance-specific inline SVGs so you can see *where* a grounded
answer came from at a glance (see [[F2 - Sentence Explanation and BYO Sources]]):

| Citation `type` | Chip |
|---|---|
| `web` | a link (the web source) |
| `obsidian` | **🔮 gem** + the vault note path → [[F4 - Obsidian Vault Connection]] |
| `file` | **📄 file** + filename → [[F3 - Local File Sources]] |
| `user` | **✏️ pencil** (a pasted note) |

These "owned" BYO chips are always shown (not subject to the web-citation display limit).

---

## Files touched & verification
`styles.css`, `index.html`, `client.js`. Verification noted in the doc: CSS braces
balanced (360/360), 0 indigo literals remain — but **no live screenshot** (the
in-environment Chrome automation couldn't reach the Windows host loopback).

---

## Related
- [[The Browser Client]] — what renders this language (themes, modals, chips)
- [[Document Picture-in-Picture]] — why colors ship as hex (the clone-styles path)
- [[F2 - Sentence Explanation and BYO Sources]] — the source chips
