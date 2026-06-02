# Team 06 — User Experience

> Lane **F03 — Experience & Agent Orchestration**. Product surface: web (primary),
> desktop (system-audio capture), mobile (iOS/Android). Thin real-time client,
> heavy server-side AI (per **D11**). This doc designs *what the user sees and
> does*; it renders the F01/F02 data contracts (`TranscriptSegment`,
> `ConceptCard`, `KnowledgeGraphNode/Edge`, `InsightItem`) **by name only** and
> consumes the orchestration layer described in `team-07-agent-orchestration.md`.

---

## 1. Architecture

### 1.1 UX architecture at a glance

Aizen's client is a **thin, streaming, event-driven view layer** over a
server-authoritative state store. The client never runs the AI; it subscribes to
a per-session event stream (WebSocket, per **D08**) and renders contract objects
as they arrive. This keeps every platform (web/desktop/mobile) rendering the
*same* objects, so feature parity is a rendering problem, not a logic problem.

```
                         ┌──────────────────────── CLIENT (thin) ─────────────────────────┐
                         │                                                                 │
  Server event stream    │   ┌───────────────┐   ┌───────────────────────────────────┐    │
  (WS/WebRTC, D08)        │   │ Transport     │   │ View-Model Store (normalized)     │    │
  ───────────────────────┼──▶│ layer         │──▶│  transcript[]  concepts{}         │    │
   TranscriptSegment      │   │ - reconnect   │   │  graph{nodes,edges}  insights[]   │    │
   ConceptCard            │   │ - seq order   │   │  timeline[]  sessionMeta          │    │
   KnowledgeGraphNode/Edge│   │ - backfill    │   └───────────────┬───────────────────┘    │
   InsightItem            │   └───────────────┘                   │ reactive bind          │
   (all carry session_id, │                                       ▼                        │
    tenant_id, seq, ts)   │   ┌─────────────────────────────────────────────────────────┐ │
                          │   │ Surfaces (composable panels, shared design system)        │ │
  Client → Server (cmds)  │   │ Transcript · ConceptCards · TopicExplorer · Explanation   │ │
  ◀───────────────────────┼── │ Timeline · KnowledgeGraph · Insights/Actions · Consent    │ │
   subscribe, scrub,      │   └─────────────────────────────────────────────────────────┘ │
   "explain deeper",      │                                                                 │
   pin, redact, export    └─────────────────────────────────────────────────────────────────┘
```

**Design tenets**

| # | Tenet | Consequence |
|---|---|---|
| T1 | Server-authoritative, client-reactive | Client holds only a cache of contract objects keyed by `seq`; any client can be rebuilt from the stream + a snapshot. |
| T2 | Stream-first rendering | Partial transcript and first-token explanations render incrementally; never block on a "complete" object. |
| T3 | One view-model, many shells | Same normalized store on web/desktop/mobile; only the layout shell and capture affordances differ. |
| T4 | Progressive disclosure | Glanceable by default (transcript + cards); depth on demand (explorer, graph, deep explanation). |
| T5 | Calm, non-blocking AI | AI output never steals focus or covers the live transcript; it accretes in side rails the user pulls from. |
| T6 | Accessible by construction | WCAG 2.2 AA is a build gate, not a polish pass (§9). |

### 1.2 Component model (rendering the contracts)

| Surface | Renders contract(s) | Stream behavior | Empty/loading state |
|---|---|---|---|
| Live Transcript | `TranscriptSegment` | Append + in-place upgrade (partial→final) on matching `seq` | "Listening…" pulse + waveform |
| Concept Cards rail | `ConceptCard` | Insert on arrival, dedupe by concept id, sort by salience/recency | Skeleton cards while extraction runs |
| Topic Explorer | `ConceptCard` + `KnowledgeGraphNode` | Tree/list rebuilt from graph deltas | "Topics will appear as they're discussed" |
| Interactive Explanation | `ConceptCard.explanation` (+ deep stream) | First-token stream, then accrete examples/diagram/citations | Streaming shimmer on the explanation body |
| Timeline | `TranscriptSegment` ts + `InsightItem` + topic spans | Continuous append; markers for decisions/actions | Single "now" marker |
| Knowledge Graph | `KnowledgeGraphNode/Edge` | Incremental node/edge add with layout settle | Single seed node = session topic |
| Insights / Action Items | `InsightItem` (action/decision/open-question) | Append + status edits (done/dismiss) | "No action items detected yet" |

### 1.3 Information architecture

```
Aizen
├── Home / Sessions list ............ past + live sessions, search, folders, share
│   └── New Session ................. source picker (mic · system audio · meeting bot · upload)
├── Live Session (LIVE MODE) ........ real-time, latency-optimized, low chrome
│   ├── Transcript (center)
│   ├── Concept Cards (right rail)
│   ├── Insights ticker (bottom)
│   └── Quick controls .............. pause/resume capture · consent · privacy mode · mark moment
├── Session Review (REVIEW MODE) .... post/scrubbed, depth-optimized
│   ├── Transcript + Timeline (linked scrubbing)
│   ├── Topic Explorer
│   ├── Knowledge Graph
│   ├── Interactive Explanations (full)
│   ├── Insights & Action Items (editable, exportable)
│   └── Summary / Recap
├── Library ......................... saved concepts, "my glossary", cross-session graph
├── Search .......................... full-text transcript + semantic concept search
└── Settings ........................ account · capture devices · privacy/retention · a11y · model preferences
```

**Live vs Review modes (a first-class IA split — see §10).**

---

## 2. Primary workflows

| WF | Workflow | Entry | Steps (happy path) | Exit / value |
|---|---|---|---|---|
| WF1 | Start a live session | Home → New Session | pick source → grant capture + **consent** (D10) → connect → transcript + cards stream in | Live understanding of the room |
| WF2 | Understand a term mid-conversation | Concept Card appears | glance card → tap "Explain more" → deep explanation streams in side panel | Plain-language grasp without interrupting |
| WF3 | Drill into a topic | Topic Explorer | select topic → see sub-concepts, related terms, graph neighborhood, citations | Structured deep-dive |
| WF4 | Capture decisions/actions | Insights ticker / review | auto-detected `InsightItem`s → confirm/edit/assign → export to email/Notion/Jira | Nothing actionable is lost |
| WF5 | Review after the fact | Sessions → a session | scrub timeline → jump to moments → read recap → explore graph | Searchable, teachable record |
| WF6 | Prep from a past session | Library/Search | search across sessions → open concept → linked sources | Reuse prior knowledge |
| WF7 | Manage privacy | Settings / in-session | set retention, enable no-audio-retention, redact a span | Trust + compliance (D10) |

---

## 3. User journeys

### 3.1 Journey A — Solo professional in a live business meeting ("the room copilot")

> *Persona:* Priya, a PM who joins cross-functional calls full of acronyms.

| Phase | User goal | What Aizen does | Surfaces | Emotion target |
|---|---|---|---|---|
| Before | Join fast, low friction | One-click "join this meeting" (bot) or system-audio capture; consent banner shown to all per policy | New Session, Consent | "This won't get in my way" |
| During | Follow without falling behind | Live transcript + concept cards for jargon ("DAU", "SOC 2", "north-star metric"); insights ticker flags decisions | Transcript, Cards, Insights | "I'm keeping up" |
| Moment | Understand a scary term | Card for "cohort retention" → "Explain more" → analogy + tiny chart stream in, no focus steal | Interactive Explanation | "Oh, that's all it meant" |
| After | Send a recap | Auto recap + action items pre-filled → edit → export | Review, Insights | "Done in 2 minutes" |

**Journey map (latency-anchored to D07):**

```
 speech ──▶ partial transcript (≤1.3s) ──▶ final segment (≤2s) ──▶ concept card (≤3s p50)
                                                                       │
                                          user taps "Explain more" ────┘
                                                  └─▶ first token (≤1s) ─▶ examples/diagram stream (≤10s best-effort)
```

### 3.2 Journey B — Technical-interview prep (learner over time)

> *Persona:* Marcus, prepping for system-design interviews; uses Review + Library heavily.

| Phase | Goal | Aizen behavior | Surfaces |
|---|---|---|---|
| Practice | Record a mock interview | Live capture; concepts ("CAP theorem", "consistent hashing") extracted | Live mode |
| Review | Find weak spots | Timeline markers on every concept he stumbled on; graph shows clusters he never connected | Timeline, Graph |
| Learn | Master a concept | Interactive Explanation with progressive depth (ELI5 → standard → expert), examples, "quiz me" | Explanation |
| Reuse | Build a glossary | Pin concepts to "My Glossary"; cross-session graph links repeated topics | Library |

### 3.3 Journey C — Learner mode (lecture / podcast / dense talk)

> *Persona:* Sara, watching a recorded healthcare-policy talk, English second language.

- Emphasis on **captions + reduced reading speed**, on-demand definitions, and a
  "simplify" toggle (reading level). Review-mode-dominant; live optional.
- Demonstrates accessibility wins (captions, screen-reader concept summaries,
  reduced-motion graph) as everyday features, not edge cases.

### 3.4 Journey D — Multi-party consented meeting (enterprise)

- Host enables session; **consent state per participant** surfaced as a banner and
  a roster chip (✓ consented / pending). No-audio-retention mode available.
- Drives the privacy/consent UI touchpoints flagged for F09 (see §5, §13).

---

## 4. ASCII wireframes

### 4.1 Live Transcript view (LIVE MODE — web/desktop, wide)

```
┌─ Aizen ─ Live ─ "Q2 Planning Sync" ───────────── ● REC 12:04 ── [Consent ✓3/4] ─ [⚙] ─┐
│                                                                                          │
│  TRANSCRIPT                                            │  CONCEPT CARDS                  │
│  ────────────────────────────────────────────────     │  ───────────────────────────   │
│  10:02  Priya   We need to hit our north-star metric   │  ┌───────────────────────────┐ │
│                 before the board meeting.              │  │ ★ North-star metric       │ │
│  10:02  Dev     Retention is the gating factor —       │  │ The single metric that    │ │
│         ▸ our D30 cohort is soft.                       │  │ best captures core value. │ │
│  10:03  Priya   Can we model the LTV impact?           │  │  [Explain more ▸] [Pin]   │ │
│  10:03  Dev     Yeah, CAC payback is …                 │  └───────────────────────────┘ │
│  ░░░ Dev (partial) … sitting around fourteen months ░░ │  ┌───────────────────────────┐ │
│         ^ live partial, italic + lower contrast        │  │ ★ D30 cohort  · LTV · CAC │ │
│                                                        │  │ payback  (3 new)   [▸]    │ │
│  [⏸ Pause]  [🔒 Privacy mode]  [⚑ Mark moment]         │  └───────────────────────────┘ │
│─────────────────────────────────────────────────────────────────────────────────────── │
│  INSIGHTS  ▸ Decision: "Model LTV before board" · Action: Dev to pull D30 data  [+2 …]   │
└──────────────────────────────────────────────────────────────────────────────────────┘
   Live region (aria-live=polite) announces new finalized segments + new concept cards.
```

### 4.2 Concept Card — collapsed and expanded

```
COLLAPSED (in rail)                       EXPANDED (inline / popover)
┌───────────────────────────┐            ┌──────────────────────────────────────────┐
│ ★ CAC payback             │            │ ★ CAC payback period          [Pin] [↗]   │
│ How long to recoup the    │  ──tap──▶  │ ──────────────────────────────────────────│
│ cost of acquiring a user. │            │ Plain: Months of gross margin needed to    │
│ salience ▓▓▓▓░  · finance │            │ earn back what you spent to get a customer.│
│ [Explain more ▸]          │            │ Example: Spend $300 to acquire; $25/mo     │
└───────────────────────────┘            │ margin → ~12 mo payback.                   │
                                         │ ┌── mini diagram (reduced-motion safe) ──┐ │
   Fields rendered from ConceptCard:     │ │  $ │   ___________                     │ │
   title, short_def, plain_explanation,  │ │    │__/          payback at ~12mo      │ │
   examples[], diagram?, citations[],    │ └──────────────────────────────────────┘ │
   salience, domain, graph_links[]       │ Related: LTV · CAC · cohort   [graph ▸]   │
                                         │ Sources: ▸ a16z metrics  ▸ internal wiki  │
                                         │ Confidence: high · [Explain deeper ▸]      │
                                         └──────────────────────────────────────────┘
```

### 4.3 Topic Explorer (REVIEW MODE)

```
┌─ Topic Explorer ──────────────────────────────────────────── [search topics 🔍] ─┐
│  TOPICS (by salience)            │  SELECTED: "Retention"                          │
│  ───────────────────────────     │  ─────────────────────────────────────────────│
│  ▾ Growth                        │  Definition: share of users who return …        │
│     • North-star metric          │  Mentioned: 6× (10:02, 10:08, 10:15 …)          │
│     ▾ Retention            ◀ sel │  Sub-concepts:  D30 cohort · churn · resurrect  │
│        • D30 cohort              │  Related (graph): LTV ── CAC ── payback         │
│        • Churn                   │  ┌──────────── neighborhood preview ──────────┐ │
│     • LTV / CAC                  │  │   (Retention)──gates──(North-star)         │ │
│  ▸ Finance                       │  │        │drives                             │ │
│  ▸ Product                       │  │     (LTV)──offsets──(CAC)                  │ │
│  ▸ Risks                         │  └────────────────────────────────────────────┘ │
│                                  │  [Open in Graph ▸]  [Explain ▸]  [Jump to 10:08]│
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Interactive Explanation panel (progressive depth)

```
┌─ Explain: "Consistent hashing" ──────────────────────── [ELI5 | Standard | Expert] ─┐
│  Depth: ●──────○──────○   (slider; reduced-motion = stepped)                          │
│  ───────────────────────────────────────────────────────────────────────────────────│
│  A way to spread keys across servers so that adding/removing a server only            │
│  reshuffles a small slice of keys, not everything.  ⟪streaming… first token ≤1s⟫       │
│                                                                                       │
│  ┌─ Diagram (ASCII fallback if canvas unavailable) ─┐   Examples ▸  Analogy ▸          │
│  │      ring:  0 ── A ── 90 ── B ── 180 ── C ── 270 │   Counter-example ▸              │
│  │      key k → clockwise to next node              │   "Quiz me" ▸                    │
│  └──────────────────────────────────────────────────┘                                 │
│  Sources: ▸ Karger et al. 1997  ▸ AWS DynamoDB paper      Confidence: high            │
│  [👍 helpful] [👎] [Report]      [Add to My Glossary]   [Explain deeper (research) ▸]   │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Timeline view (REVIEW MODE)

```
┌─ Timeline ─ "Q2 Planning Sync" (32:10) ─────────────────────────────────────────────┐
│ speakers │P▓▓░░▓▓▓░░░░▓▓░░░░▓▓▓▓░░░░░░░▓▓░░░░░░░░░░░░░░▓▓│  (P=Priya  D=Dev …)            │
│          │D░░▓▓░░░▓▓▓▓░░▓▓▓▓░░░░▓▓▓▓▓▓░░░▓▓▓░░▓▓▓░░░▓▓░░│                                │
│ topics   │■■ Growth ■■■■  □ Finance □□  ▒ Risks ▒  ■ Growth ■                           │
│ markers  │      ⚑decision        ◆action     ?open-q        ⚑decision                  │
│          0    4    8    12   16   20   24   28   32 min                                 │
│ playhead ───────────────▲ 14:22  (click/scrub → transcript + cards jump in sync)        │
│ [◀10s] [▶ play] [10s▶]   [1x ▾]   [Jump: ⚑ decisions ▾]   [Filter: speaker ▾ topic ▾]   │
└────────────────────────────────────────────────────────────────────────────────────┘
   Markers map to InsightItem.kind; topic bands map to ConceptCard time spans.
```

### 4.6 Knowledge-graph visualization (REVIEW MODE)

```
┌─ Knowledge Graph ─ "Q2 Planning Sync" ──────────── [layout: force ▾] [a11y list ▣] ─┐
│                                                                                       │
│                 (North-star metric)                                                   │
│                 /        |        \                                                    │
│           gates       drives     measured-by                                          │
│            /             |            \                                                │
│     (Retention)     (Growth plan)    (DAU)                                             │
│        |   \             |                                                             │
│     has   contains    informs                                                         │
│      |       \           |                                                             │
│  (Churn)  (D30 cohort)  (LTV)──offsets──(CAC)──recouped-over──(Payback)                │
│                                                                                       │
│  ── Node = KnowledgeGraphNode (concept/entity/person) · Edge = KnowledgeGraphEdge ──   │
│  [click node → ConceptCard + neighbors]   [search]   [filter by domain]                │
│  ♿ "List view" renders the same nodes/edges as a nested, screen-reader-navigable tree │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.7 Mobile — Live (narrow, single column, swipe between surfaces)

```
┌───────────────────────┐    Swipe ◀▶ between tabs:   ┌───────────────────────┐
│ ● REC  Q2 Sync  12:04 │    [Transcript][Cards]      │  ◀ Concept Cards       │
│───────────────────────│    [Insights][Graph]        │───────────────────────│
│ Priya: north-star …   │                             │ ★ North-star metric   │
│ Dev: retention is the │    Bottom sheet pulls up     │ The single metric …   │
│ gating factor …       │    for deep explanation;     │ [Explain more ▸]      │
│ ░ Dev (partial) …     │    transcript stays visible  │───────────────────── │
│───────────────────────│    behind a 40% scrim.       │ ★ D30 cohort  (+3)    │
│ ⏸  🔒  ⚑   [Cards ▸]  │                             │ [Explain more ▸]      │
└───────────────────────┘                             └───────────────────────┘
  Big tap targets ≥44px · one-hand reach · haptic on new decision marker.
```

---

## 5. Privacy & consent in the UI (D10 touchpoints)

These are **UI surfaces only**; F09 owns the authoritative consent/retention model.

| Touchpoint | UI behavior | Flag to |
|---|---|---|
| Session start | Consent banner; for multi-party, per-participant consent roster chips | F09 |
| Recording indicator | Persistent ● REC + audible/visual cue; never hidden | F09 |
| No-audio-retention mode | Toggle in New Session + Settings; UI shows "audio not stored" badge | F09 |
| Redaction | Select transcript span → "Redact"; removes from view + emits redaction command | F09 |
| Retention | Settings: retention window picker; per-session override | F09 |
| Export | Export honors consent scope; warns if exporting others' speech | F09 |

---

## 6. Technology recommendations

| Concern | Recommendation | Why (tie to decisions) |
|---|---|---|
| Web app framework | **React + TypeScript**, Vite; **TanStack Query** + lightweight reactive store (Zustand/Jotai) for the normalized view-model | Largest a11y/ecosystem support; SSR-optional; D11 web-primary |
| Realtime transport | **WebSocket** for events; **WebRTC** for low-latency audio uplift where the client captures audio | Matches D08 edge protocols; WS for contract objects, WebRTC for media |
| Desktop shell | **Tauri** (Rust core) preferred over Electron; Electron fallback | Smaller footprint, native system-audio + screen-audio capture; D11 |
| Mobile | **React Native** (shared TS view-model) with native modules for audio session + background capture | Reuse the same normalized store & components; D11 iOS/Android |
| Graph viz | **Cytoscape.js** (web/RN-web) with WebGL renderer at scale; deterministic layout cached server-side for large graphs | Handles 1k+ nodes; supports list-view a11y mirror |
| Charts/diagrams | **Mermaid** (server-rendered to SVG for citations) + lightweight client charts; ASCII fallback for no-canvas/SR | Diagrams arrive as `ConceptCard.diagram`; deterministic, cacheable |
| Captions/transcript rendering | Virtualized list (TanStack Virtual) | 30-min sessions = thousands of segments; keep render ≤300 ms (D07) |
| Design system | **Radix Primitives** + tokens; or Fluent/your own; WCAG-first components | Accessible-by-default primitives (focus, roving tabindex, dialogs) |
| i18n | **ICU MessageFormat** (react-intl); RTL-ready | English-first, expansion path per IDEA assumptions |
| Offline/resume | IndexedDB snapshot of view-model keyed by `seq` | Reconnect/backfill without full reload |

### 6.1 Streaming render strategy (keeps the D07 budget on the client)

| Object | Render technique | Client budget (of the 300 ms render slice) |
|---|---|---|
| `TranscriptSegment` partial | Optimistic append to virtual list; no layout thrash | < 50 ms |
| partial→final upgrade | In-place text swap by `seq`; diff-only | < 30 ms |
| `ConceptCard` | Skeleton → hydrate; insert without reflowing transcript | < 80 ms |
| Explanation tokens | Token stream appended to a stable container (no reflow of siblings) | < 16 ms/frame |
| Graph delta | Add node/edge, run incremental layout off main thread (web worker) | < 100 ms settle |

---

## 7. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| UX-R1 | Information overload — too many cards/insights bury the live transcript | High | High | Salience-ranked rail, collapse-by-default, "show fewer" density control, calm-AI tenet T5 |
| UX-R2 | Latency *perception* worse than reality (jank, layout shift) | Med | High | Skeletons, optimistic partials, no-reflow streaming (§6.1), perceived-latency targets |
| UX-R3 | Accessibility debt accrues if treated as polish | Med | High | A11y as build gate (§9), automated axe-core CI, screen-reader test matrix |
| UX-R4 | Graph becomes unreadable hairball at scale | Med | Med | Server-side layout + filtering, neighborhood-focus, mandatory list-view mirror |
| UX-R5 | Reconnect/state divergence (client cache stale vs server) | Med | High | `seq`-keyed reconciliation, snapshot+delta backfill on reconnect |
| UX-R6 | Trust erosion from wrong/hallucinated explanations | Med | High | Confidence chips, citations always shown, 👍/👎/Report, "unverified" badge from F02 verification |
| UX-R7 | Consent UX friction kills adoption | Med | Med | One-tap consent, remembered org policy, clear value-first framing |
| UX-R8 | Mobile capture limits (iOS background audio, no system audio) | High | Med | Set expectations in UI; lean on meeting-bot + mic; degrade gracefully |

---

## 8. Scalability (UX/client scaling against D02)

| Dimension | MVP (1k MAU / 200 live) | Year-1 (100k / 5k live) | North-star (2M / 50k live) | Client implication |
|---|---|---|---|---|
| Segments/session | ~1–3k | same per session | same per session | Virtualized lists mandatory from day 1 |
| Concept cards/session | 30–150 | same | same | Salience ranking + dedupe; rail caps + "more" |
| Graph nodes/session | 50–300 | same | same | Incremental layout; server-cached layout ≥500 nodes |
| Cross-session library graph | small | thousands of nodes | 100k+ nodes | Server-paginated graph queries; client renders neighborhoods only |
| Concurrent WS per client | 1 session | 1 (+ shared sessions) | 1 (+ team views) | Single multiplexed WS; subscribe per surface |
| Bundle/perf budget | — | — | — | < 250 KB initial JS (gzip) web; route-split surfaces; LCP < 2.5 s |

UX scaling cost is **per-session, not per-MAU** for the heavy surfaces, so client
work stays flat as MAU grows; the elastic concern is the cross-session library
graph, handled by server pagination (F02/F04 own the stores).

---

## 9. Security (client-side)

| Concern | Control |
|---|---|
| AuthN/AuthZ | OIDC/PKCE; short-lived tokens; tenant-scoped WS subscription (`tenant_id` enforced server-side, never trusted from client) |
| Transport | TLS 1.3 / WSS only; cert pinning on desktop/mobile |
| Local cache | Encrypted IndexedDB / Keychain; honor no-retention mode (no local persistence when set) |
| XSS/injection | Treat all rendered AI text + citations as untrusted; sanitize markdown, no `dangerouslySetInnerHTML` without sanitizer; CSP strict |
| Citation links | Open in sandboxed context; `rel=noopener`; show resolved domain |
| Clipboard/export | Honor consent scope (§5); redaction applied before export |
| Recording UX | Tamper-evident persistent indicator; cannot be hidden by AI panels |

(Authoritative security/compliance model is F09; client implements its directives.)

---

## 10. Live vs Review modes

| Aspect | LIVE MODE | REVIEW MODE |
|---|---|---|
| Optimized for | Latency, glanceability, non-interruption | Depth, navigation, editing, teaching |
| Layout | Transcript-center, single side rail, minimal chrome | Multi-panel: timeline + explorer + graph + explanations |
| Streaming | Hard real-time; partials, first-token | Pre-computed + on-demand deep (research) explanations |
| Editing | Light (mark moment, pin, redact) | Full (edit insights, assign actions, annotate, correct transcript) |
| Graph | Compact neighborhood preview only | Full interactive graph |
| Explanation depth | Standard, fast | ELI5↔Expert slider, research-grade deep |
| Motion | Minimal; calm accretion | Richer transitions (respecting reduced-motion) |
| Transition | "End session" → seamless promote to Review; live cache becomes review snapshot | "Resume capture" can re-enter Live |

The mode switch is a **state of the same session**, not a different app — the
view-model store persists across the boundary.

---

## 11. Accessibility — WCAG 2.2 AA plan

Aizen is a real-time captioning product; accessibility is core, not optional.

### 11.1 Conformance targets & key SC mapping

| Area | WCAG 2.2 SC | How Aizen meets it |
|---|---|---|
| Captions | 1.2.2 / 1.2.4 (Live) | Live transcript *is* the caption track; also exportable WebVTT; speaker labels; min 1.0 reading-friendly line length |
| Non-text content | 1.1.1 | Every diagram has alt text (from `ConceptCard.diagram.alt`); graph has list-view text mirror; icons have labels |
| Color/contrast | 1.4.3 / 1.4.11 | ≥4.5:1 text, ≥3:1 UI/graphics; salience encoded by shape+number, not color alone (1.4.1) |
| Reflow / resize | 1.4.10 / 1.4.4 | Responsive to 320 px / 400% zoom without loss; no horizontal scroll |
| Keyboard | 2.1.1 / 2.1.2 | All surfaces fully operable; no traps; documented shortcuts; roving tabindex in rails/graph |
| Focus visible/appearance | 2.4.7 / **2.4.11** (2.2) | Always-visible focus ring; focus never fully obscured by sticky headers/panels |
| Dragging | **2.5.7** (2.2) | Timeline scrub & graph pan have non-dragging alternatives (buttons, arrow keys) |
| Target size | **2.5.8** (2.2) | Interactive targets ≥24×24 CSS px (≥44 px on mobile) |
| Motion | 2.3.3 + `prefers-reduced-motion` | Reduced-motion: stepped depth slider, no graph physics, no token "typing" animation (instant render), no parallax |
| Live regions | 4.1.3 | `aria-live=polite` for new finalized segments + new cards; assertive only for errors/recording state |
| Consistent help | **3.2.6** (2.2) | Help/consent controls in consistent location across surfaces |
| Auth | **3.3.8** (2.2) | No cognitive-test auth; passkeys/OIDC; no puzzle CAPTCHAs |
| Headings/landmarks | 1.3.1 / 2.4.1 | Semantic landmarks (main/aside/nav); bypass blocks; logical heading order |

### 11.2 Screen-reader experience

| Surface | SR behavior |
|---|---|
| Transcript | Each finalized segment is a list item: "Priya, 10:02, ‘we need to hit our north-star metric’". Partials are NOT announced (would spam); only finalized. |
| Concept card arrival | Polite announcement: "New concept: North-star metric. Press X to open." |
| Explanation | Announced as a labeled region; depth changes announced ("Depth: ELI5"). |
| Graph | Exposed as a tree: node → "Retention, 3 connections: gates North-star metric, has Churn, contains D30 cohort." Arrow-key navigation between neighbors. |
| Timeline | Slider role with `aria-valuetext` = current timecode + nearest marker. |
| Insights | List with status; actions have explicit labels ("Mark action item done"). |

### 11.3 Keyboard model (defaults; remappable)

| Action | Web/Desktop | Notes |
|---|---|---|
| Cycle surfaces | `F6` / `Shift+F6` | Landmark cycling |
| Open focused card's explanation | `E` | |
| Pin / unpin | `P` | |
| Mark moment | `M` | |
| Timeline play/pause | `Space` | When timeline focused |
| Scrub ±10 s | `←` / `→` | Non-drag alternative (SC 2.5.7) |
| Jump to next decision | `]` | `[` previous |
| Graph: move to neighbor | Arrow keys | Roving tabindex |
| Command palette | `Cmd/Ctrl+K` | Search + actions |
| Toggle a11y list-view (graph) | `L` | |

### 11.4 Accessibility verification

- **CI gate:** axe-core + Playwright a11y assertions on every surface; build fails on AA violations.
- **Manual:** NVDA + JAWS (Windows), VoiceOver (macOS/iOS), TalkBack (Android) test matrix per release.
- **External audit:** third-party VPAT/WCAG 2.2 AA audit before GA (manual task — see §13).

---

## 12. Cost

UX cost is **build + delivery**, not per-inference (AI cost is F02). Tie to D02.

| Item | MVP | Year-1 | North-star | Notes |
|---|---|---|---|---|
| Frontend eng (build) | 3 FE + 1 design + 0.5 a11y | 6 FE + 2 design + 1 a11y | 10+ FE + design system team | Largest UX cost is people |
| CDN/static hosting | ~$50–200/mo | ~$1–3k/mo | ~$15–40k/mo | Azure Front Door / CDN (D03); cache busts on deploy |
| WS fan-out (client share of) | folds into F04 event infra | " | " | Client opens 1 multiplexed WS/session |
| Server-side diagram/graph-layout render | small | moderate | significant | Cache aggressively; layout is deterministic & reusable |
| Design-tool / a11y-audit vendors | one-time + annual | annual | annual | Manual tasks §13 |

Client engineering does not scale with MAU (flat per-session render); CDN egress
is the only MAU-linear UX infra cost and is small relative to AI/STT spend.

(SKUs mapped to Azure; dollar figures carried from the original model pending Azure repricing.)

---

## 13. MVP scope

**In (MVP):**
- Web app (primary) + desktop (Tauri) for system-audio.
- LIVE mode: transcript, concept cards (collapsed + expanded), insights ticker.
- REVIEW mode: timeline, basic topic explorer, interactive explanation (ELI5/Standard), insights list + export.
- Knowledge graph: read-only neighborhood + list-view a11y mirror.
- Consent banner, recording indicator, no-audio-retention toggle, redaction.
- WCAG 2.2 AA on the core flows (transcript, cards, explanation, controls).

**Out (post-MVP):**
- Native mobile apps (start with responsive web on mobile; RN apps Year-1).
- Full force-directed graph at scale; cross-session library graph.
- "Quiz me", reading-level simplify slider, multi-language UI.
- Team/shared live views, real-time collaboration cursors.

### Manual tasks (logged in MANUAL.md + NEEDS_USER.md)

| ID | Action |
|---|---|
| MAN-F03-001 | Design-tool team accounts (Figma/Penpot) |
| MAN-F03-002 | Brand & visual-identity decision (logo, palette, type) |
| MAN-F03-004 | Accessibility-audit vendor engagement (WCAG 2.2 AA / VPAT) |
| MAN-F03-005 | App-store presence (Apple Developer, Google Play) for mobile |

---

## 14. Future enhancements

| Theme | Enhancement |
|---|---|
| Personalization | Per-user reading level, domain profile ("explain like I'm a clinician"), adaptive salience |
| Collaboration | Shared live sessions, presence, collaborative annotations & action assignment |
| Mobile-native | Full RN apps, on-device caption rendering, widget/lock-screen "now explaining" |
| AR/voice | Glasses HUD captions; voice query ("Aizen, what did she mean by churn?") |
| Multimodal | Render shared screens/slides into the graph; OCR'd diagrams as concepts |
| Learning loops | Spaced-repetition over "My Glossary"; mastery tracking |
| Localization | Full i18n + RTL, localized explanations |

---

## 15. Assumptions

| ID | Assumption |
|---|---|
| A1 | F02 emits `ConceptCard` with: `title, short_def, plain_explanation, examples[], diagram?{spec,alt}, citations[], salience, confidence, domain, graph_links[]`. (Names assumed; F02 owns truth.) |
| A2 | `TranscriptSegment` carries `speaker`, `text`, `is_final`, `confidence`, `ts_start/ts_end`, `seq`. |
| A3 | `InsightItem` carries `kind ∈ {action, decision, open_question}`, `text`, `assignee?`, `ts`, `status`. |
| A4 | `KnowledgeGraphNode/Edge` carry stable ids, `label`, `type`, edge `relation`, and reference `ConceptCard` ids. |
| A5 | The event backbone (D08) delivers ordered, per-session, `seq`-stamped objects over WS with backfill/snapshot support. |
| A6 | Deep/research explanations stream as deltas to an existing `ConceptCard` (best-effort ≤10 s, D07). |
| A7 | Server provides deterministic, cacheable graph layouts for large graphs. |

---

## 16. Decisions (UX-local; honor D01–D12)

| ID | Decision |
|---|---|
| UX-D1 | Server-authoritative, `seq`-keyed reactive client; one view-model, many shells (T1/T3). |
| UX-D2 | Live vs Review are modes of one session, not separate apps (§10). |
| UX-D3 | Calm-AI: AI output accretes in rails, never steals focus from the live transcript (T5). |
| UX-D4 | A11y is a CI build gate, not a polish pass (§11.4). |
| UX-D5 | Web + desktop (Tauri) first; mobile = responsive web at MVP, native RN later. |
| UX-D6 | Every AI-rendered claim shows a confidence chip + citations + feedback control. |
| UX-D7 | Graph always ships with a screen-reader list-view mirror. |

---

## 17. Tradeoffs

| Tradeoff | Chosen | Alternative | Why |
|---|---|---|---|
| Thin client vs offline-capable smart client | Thin, streaming | Local model/offline | D11 thin-client; keeps platforms consistent; AI is server-side |
| Tauri vs Electron | Tauri | Electron | Lighter, better native audio; Electron is fallback if Tauri RN gaps appear |
| RN mobile vs fully native | RN (shared view-model) | Swift/Kotlin native | Reuse store/components; native modules only where required (audio) |
| Density (more cards) vs calm (fewer) | Calm default + density control | Always show everything | Avoid overload (UX-R1) |
| Token "typing" animation vs instant | Instant under reduced-motion; subtle otherwise | Always animate | Accessibility + perceived-speed balance |
| Client graph layout vs server-cached | Server-cached at scale | Always client | Performance + determinism at 500+ nodes |

---

## 18. Open questions

| ID | Question | Owner to resolve |
|---|---|---|
| OQ-1 | Exact `ConceptCard.diagram` format — Mermaid spec vs prerendered SVG vs ASCII? Affects render + a11y alt. | F02 |
| OQ-2 | Does F02 emit a `reading_level` variant of explanations, or does the client request depth and F02 regenerates? | F02 + Team 7 |
| OQ-3 | Snapshot/backfill protocol shape for reconnect — does F04 event backbone expose a snapshot endpoint? | F04 |
| OQ-4 | Multi-party consent model: is per-participant consent state pushed to the client as its own contract? | F09 |
| OQ-5 | Transcript correction by users — does an edit propagate back to F02 re-extraction? | F02 + Team 7 |
| OQ-6 | Mobile system-audio limits — meeting-bot-only on iOS? Confirm with F01. | F01 |

---

## 19. Estimated complexity

| Component | Complexity | Driver |
|---|---|---|
| Live transcript (streaming, virtualized, a11y live region) | **High** | Real-time partial/final, reconnect, SR announcements |
| Concept cards rail | Medium | Dedupe, salience, expand/collapse, streaming hydrate |
| Interactive explanation (depth slider, streaming, diagrams) | High | Streaming + progressive depth + a11y + diagrams |
| Topic explorer | Medium | Tree from graph deltas |
| Timeline (scrub sync, markers, a11y slider) | High | Sync with transcript/cards, non-drag alternative |
| Knowledge graph + a11y list mirror | **High** | Layout perf + dual representation |
| Live/Review mode system + view-model store | High | State persistence across modes, reconnect |
| Consent/privacy UI | Medium | Multi-party state, redaction |
| Desktop (Tauri) capture shell | High | Native system-audio (coordinated w/ F01) |
| Mobile (RN, native audio) | High | Platform audio limits |
| WCAG 2.2 AA across all | High (cross-cutting) | Build-gate, screen-reader matrix, audit |

**Overall lane-UX complexity: High** — driven by hard-real-time streaming UX,
dual graph representation, and AA accessibility on a live captioning product.
