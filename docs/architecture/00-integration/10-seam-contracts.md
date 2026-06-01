# Integration · Seam Contracts (the three undesigned seams, now designed)

> **Purpose.** The validation review (doc 09) found that doc 01 counted three
> load-bearing seams as "resolved" when all that existed was an owner + a
> one-sentence prose arrow. This document converts those prose arrows into
> **field-level contracts with contract tests** so they cannot resurface at
> integration time. It closes H-7, H-8, H-9, M-2, M-5.
>
> **Status:** Binding design. Where this doc tightens a contract owned by a lane
> (F01 `TranscriptSegment`, F02 `ConceptCard`/`kg_delta`), the change is additive
> (new passthrough fields, new lifecycle states, new message types) and is
> announced as a contract change per each lane's versioning policy. No field is
> renamed or removed; no redesign of the bones.
>
> **Scope.** Three seams + two cleanups:
> 1. **Seam A** — the D16 F01→F02 ingress adapter (closes H-7).
> 2. **Seam B** — supersede / correction propagation through F02→F03 (closes H-8).
> 3. **Seam C** — the `kg_delta` resync protocol (closes H-9).
> 4. **M-2** — F02↔F03 field-name reconciliation.
> 5. **M-5** — EventBus identity pin (precondition for all three).

---

## 0. M-5 first — pin the EventBus, because every seam rides it

The three seams all assume a concrete bus. Doc 02 says "Kinesis→MSK (D13)";
F01 team-01 still cites "MSK (Kafka) per D08." That ambiguity must close before a
`delta_seq`↔offset mapping (Seam C) can even be specified, because Kinesis
**sequence numbers** and Kafka **offsets** are different position types.

**Binding decision (supersedes the stale D08 "Kafka-class" placeholder):**

| Horizon | Concrete bus | Position token type | Partition/shard key |
|---|---|---|---|
| **MVP** (≤200 concurrent) | **AWS Kinesis Data Streams**, one logical stream, per-session **shard** | Kinesis `SequenceNumber` (opaque string, monotonic per shard) | `session_id` |
| **Year-1** (scale) | **Amazon MSK (Kafka)** behind the same `EventBus` interface | Kafka `(partition, offset)` | `session_id` |

**`EventBus` abstraction contract (F04 owns).** All lanes program against this,
never against Kinesis/Kafka directly:

```
EventBus.append(session_id, message)            -> Position        // opaque token
EventBus.read(session_id, from: Position|"latest"|"trim_horizon")  // ordered stream
EventBus.resolve(session_id, position_token)     -> Position        // validate/normalize
```

- **`Position` is an opaque token.** No consumer parses it. Kinesis
  `SequenceNumber` and Kafka `(partition,offset)` both serialize into it. This is
  what lets Seam C's resync work identically on both buses.
- **Per-session total order** is the only ordering guarantee consumers may rely
  on (already stated D08/D13). Cross-session order is undefined.
- F01's "MSK per D08" reference is **corrected to D13**; D13 is the single
  decision pointer. (Action: fix the stale string in
  `01-capture-transcription/team-01-*.md`.)

> **M-1 corollary (per-class `seq` are independent).** `AudioFrame.seq`,
> `TranscriptSegment.seq`, and F02's `seq` are three independent monotonic
> counters, not one global watermark. Gap detection is therefore **per message
> class**. The bus `Position` is the cross-class ordering truth; the per-class
> `seq` is only for dedup/gap-detection *within* a class. Seam C keys resync on
> `delta_seq` (F02's class) ↔ `Position`, never on a mythical global `seq`.

---

## 1. Seam A — D16: the F01→F02 ingress adapter (closes H-7)

### 1.1 What it is

A pure, stateless transform at F02's extraction ingress (team-03). It is the
**only** F02 component that sees raw `TranscriptSegment` fields; everything
downstream sees the normalized F02-internal view. It runs in the S0 ingress stage
(~5 ms budget). It does **not** call the bus, the LLM, or any store — it is a
function `adapt(TranscriptSegment, ConsentContext) -> ExtractionInput`.

### 1.2 The complete field map (every field, not a parenthetical)

Authoritative source shapes: F01 `TranscriptSegment` (F01 data-contracts §3.2),
F02's assumed shape (F02 data-contracts §1). The H-7 finding was that the old
"spec" mapped ~4 fields and **silently dropped `rev` and `supersedes`** — the two
fields that carry correction semantics. This table is exhaustive and the dropped
fields are restored.

| F02 internal field (`ExtractionInput`) | Source: `TranscriptSegment.…` | Transform | Notes |
|---|---|---|---|
| `segment_id` | `segment_id` | **type-relax UUID→opaque string** (C-2) | `{session}:seg:{seq}`, never parse |
| `session_id`, `tenant_id` | same | passthrough | UUIDs |
| `seq` | `seq` | passthrough (uint64) | F01 class counter; for F02 dedup/gap of *input*, not output |
| `text` | `text` | passthrough (UTF-8) | extraction input |
| `is_final` | `is_final` | passthrough (bool) | **F02 extracts on `is_final=true`**; partials → speculative prefetch only (see latency-budget rebuild, recommendation 2) |
| **`rev`** | **`rev`** | **passthrough (uint64)** | **RESTORED (H-7).** Needed for partial→final dedup and supersede dedup |
| **`supersedes`** | **`supersedes`** | **passthrough (string\|null)** | **RESTORED (H-7).** `null` or the `segment_id` this corrects. Drives Seam B |
| `t_start_us` | `start_ms` | **×1000** (ms→µs) | **media-clock µs** — tag as media domain, never sort with wall-clock (M-3) |
| `t_end_us` | `end_ms` | **×1000** | media-clock µs; invariant `t_end_us ≥ t_start_us` |
| `speaker_id` | `speaker.speaker_id` | **unwrap** (nested→flat) | session-local label |
| `speaker_label` | `speaker.display_name` | **unwrap + rename** | UI label; may change via Seam B speaker-rename supersede |
| `speaker_confidence` | `speaker.speaker_confidence` | unwrap | down-weights uncertain attribution |
| `participant_id` | `speaker.participant_id` | unwrap (nullable) | platform id when known |
| `lang` | `language` | **rename** (`language`→`lang`) | BCP-47; MVP English-first routing |
| `confidence`, `confidence_band` | same | passthrough | low-confidence spans down-weighted |
| `words[]` | `words[]` | passthrough (best-effort) | word timings `*_ms` left in ms; F02 converts on demand |
| `domain_terms[]` | `domain_terms[]` | passthrough (best-effort) | biasing trace seeds canonical_name |
| `frame_seq_range` | `frame_seq_range` | passthrough | audio provenance |
| `consent_mode` | `consent.mode` | passthrough | `store_audio\|no_audio_retention\|transcript_only` |
| `consent_id` | `consent.consent_id` | passthrough | ref to F09 consent record |
| `pii_redacted_upstream` | `consent.pii_redacted` | passthrough (bool) | whether F01 already redacted |

### 1.3 The two derived fields the adapter must NOT invent (ties to H-13)

`ConceptCard.consent_class` (`standard|sensitive`) and `pii_present` are **not**
present on `TranscriptSegment` — F01 only carries `consent.mode` (a *retention*
mode) and `pii_redacted` (a *redaction-done* flag). These are different axes:

- `consent.mode` answers "may we store the audio?"
- `consent_class` answers "may this content leave to external retrieval?" (INV-6)

The adapter therefore takes a second input, `ConsentContext`, supplied by the F04
consent gate (the consent control loop, C-8), and **fails closed**:

```
consent_class = ConsentContext.class            // from F04 gate, authoritative
pii_present   = ConsentContext.pii_present       // from F04/F02 PII classifier
// FAIL-CLOSED: if ConsentContext is missing/unknown for this session →
//   consent_class := "sensitive", pii_present := true   (blocks external retrieval)
```

This is the single line that turns H-13 from fail-open to fail-closed at the
seam. (The classifier itself — recall target, eval set — is recommendation-4 /
trust work; the *default direction* is fixed here and is cheap.)

### 1.4 Adapter invariants

- **INV-A1 (lossless for correction):** `rev` and `supersedes` are always
  carried; the adapter MUST NOT drop them. (Contract test CT-A3.)
- **INV-A2 (clock domain preserved):** `t_*_us` are media-clock µs and carry a
  `clock: "media"` tag; the adapter never emits wall-clock as `t_*_us` (M-3).
- **INV-A3 (no enrichment):** the adapter is pure; it adds no LLM output, makes no
  network call, and is independent of session state. Re-running it on the same
  `(TranscriptSegment, ConsentContext)` is identical (idempotent).
- **INV-A4 (consent fail-closed):** missing `ConsentContext` ⇒ `sensitive` +
  `pii_present=true`.

### 1.5 Contract tests (must exist before Phase 1 extraction work)

| ID | Test | Asserts |
|---|---|---|
| CT-A1 | Feed a golden F01 final segment → assert every field in §1.2 maps with the stated transform | full coverage, no silent drop |
| CT-A2 | `start_ms=256480` → `t_start_us=256480000` | ×1000 exactness, integer (no float) |
| CT-A3 | Segment with `supersedes="…:seg:100"` → adapter output retains it | **H-7 regression guard** |
| CT-A4 | `segment_id` non-UUID string → no type error | C-2 type-relax |
| CT-A5 | `ConsentContext` absent → output `consent_class="sensitive"`, `pii_present=true` | **H-13 fail-closed guard** |
| CT-A6 | Nested `speaker.{}` absent fields → graceful nulls, required `speaker_id` enforced | F01 §3.3 floor honored |

---

## 2. Seam B — supersede / correction propagation (closes H-8)

### 2.1 The dead-end being fixed

F01 emits a correction as a **new** segment: new `seq`, `is_final=true`,
`supersedes = <old segment_id>` (F01 §3.4). Today F02 extracts on the *original*
final, emits a `ConceptCard`/`kg_delta`/`InsightItem` citing that segment, and
**never re-extracts** when the supersede arrives (the adapter dropped the field —
now fixed by Seam A; and team-03 only handled `same_as` merges). Result: live
artifacts whose `sources`/`evidence_segment_ids` cite **superseded text** — an
INV-1 (provenance) violation visible to the user. Speaker renames and user
transcript edits hit the same dead-end (F03 OQ-5).

### 2.2 The provenance index (the missing state)

F02 must maintain a per-session reverse index so a supersede can find what to
fix. This is the one piece of state Seam B adds:

```
ProvenanceIndex[session_id] : segment_id -> {
  concept_card_ids:  set<cc_…>,   // cards whose sources/first_mention/mention cite it
  kg_node_ids:       set<kgn_…>,  // nodes whose first_seen/evidence cite it
  kg_edge_ids:       set<kge_…>,  // edges whose evidence_segment_ids cite it
  insight_ids:       set<ii_…>    // insights whose evidence_segment_ids cite it
}
```

Populated as F02 emits each artifact (cheap; it already knows the citations).
Bounded by salience pruning (RISK-9) — superseded segments older than the pruned
window need only retract, not re-extract.

### 2.3 The propagation algorithm (the re-extraction trigger)

On an `is_final` segment `S_new` with `supersedes = S_old`:

```
affected = ProvenanceIndex[session_id][S_old]      // O(1) lookup
1. Re-run extraction over the corrected text window that now includes S_new.
2. For each artifact A in affected, diff old vs new extraction:
   - concept still present, text/definition changed  -> re-emit A, revision++
   - concept GONE (correction removed it)             -> RETRACT A (see 2.4)
   - concept unchanged                                -> no-op (idempotent)
   - NEW concept introduced by the correction         -> emit new artifact
3. Rewrite citations: any surviving artifact's provenance that pointed at
   S_old now points at S_new (sources/evidence/first_mention/mention lists).
4. Update ProvenanceIndex: move entries from S_old to S_new.
5. Emit a single kg_delta carrying the upserts + remove_node_ids/remove_edge_ids
   for retractions (one atomic delta per supersede event, ordered by delta_seq).
```

**Speaker rename** (`supersedes` touching only `speaker.display_name`, F01 §3.4)
is a fast path: no re-extraction, just propagate the new label to affected KG
`speaker` nodes and `InsightItem.owner_speaker_id` display + `revision++`.

### 2.4 New lifecycle states (the un-render contract for F03)

H-8: `ConceptCard`/`KnowledgeGraphNode` had **no** way to express "this is no
longer true, stop showing it." Added (additive, v1 minor bump):

**`ConceptCard.state`** — add enum value **`retracted`**:

| state | meaning | F03 render action |
|---|---|---|
| `skeleton`/`enriched`/`deep` | live | render progressively (unchanged) |
| `error` | partial + reason | show degraded (unchanged) |
| **`retracted`** | superseded source removed the concept | **remove the card from UI**; optionally toast "corrected" |

Add to `ConceptCard`:
```jsonc
"retraction": {                 // null unless state == "retracted"
  "reason": "source_superseded",   // source_superseded | merged | user_edit | refuted
  "superseded_segment_id": "…:seg:100",
  "replacement_card_id": "cc_…"    // null, or the card that now carries the concept
}
```

**`KnowledgeGraphNode`/`Edge`** retract via the existing
`kg_delta.remove_node_ids` / `remove_edge_ids` (no schema change needed — Seam C
already carries them). F03 removes them on apply.

**`InsightItem`** already has `status: superseded` (F02 §5) — reuse it; add
`superseded_by_segment_id` for provenance.

### 2.5 New invariant

- **INV-8 (no live citation of superseded text):** within propagation budget
  `T_supersede` (target ≤ 2 s p95 from supersede arrival), no non-`retracted`
  artifact may carry a superseded `segment_id` in its live provenance. Every
  affected artifact is either re-emitted (citation rewritten to `S_new`) or
  retracted. Enforced by the extraction post-step + audited by an eval check.

### 2.6 Contract tests

| ID | Test | Asserts |
|---|---|---|
| CT-B1 | Card cites `seg:100`; supersede `seg:100→seg:140` with same concept, edited number → card re-emits with `revision++`, citation now `seg:140` | re-extraction + citation rewrite |
| CT-B2 | Supersede removes the concept entirely → card `state="retracted"`, kg node in `remove_node_ids` | un-render path (H-8 core) |
| CT-B3 | Speaker rename supersede → affected insight `owner` label updates, no re-extraction | fast path |
| CT-B4 | After propagation, scan all live artifacts → none cite a superseded segment_id | **INV-8 guard** |
| CT-B5 | Same supersede delivered twice (at-least-once bus) → idempotent, no double-retract | dedup on `(segment_id, rev)` |

---

## 3. Seam C — the `kg_delta` resync protocol (closes H-9)

### 3.1 What was missing

C-7 said "F03 applies in order, requests resync on gap → F04 serves
replay/snapshot." Missing: (a) a **snapshot message schema** (`snapshot_offer`
was a bare bool with no `kg_snapshot` contract), (b) a **resync-request
contract** (channel + fields), (c) the **`delta_seq`↔`Position` mapping**
(replay-by-`Position` cannot serve "give me `delta_seq` 410–411"). F03 OQ-3 and
F07 OQ-9 still flag this open.

### 3.2 The `delta_seq` ↔ `Position` index (the missing link)

F02 stamps each `kg_delta` with `delta_seq` (its application-level counter). The
bus assigns a `Position` (M-5). Resync-by-`delta_seq` needs a translation. F04
maintains a per-session index, written on append:

```
DeltaIndex[session_id] : delta_seq (uint64) -> Position (opaque)
```

Storage: DynamoDB table `kg_delta_index`, PK=`session_id`, SK=`delta_seq`,
attr=`position_token`, TTL = session retention. Tiny (one row per delta). This is
what makes "replay delta_seq 410→tail" resolvable to "read from Position(410)".

### 3.3 `kg_snapshot` message schema (NEW contract, F02 produces, F04 stores/serves)

```jsonc
{
  "message_type": "kg_snapshot",
  "schema_version": "f02.contracts/v1",
  "session_id": "uuid",
  "tenant_id": "uuid",
  "snapshot_id": "kgs_01HW…",          // ULID
  "up_to_delta_seq": 412,              // snapshot reflects ALL deltas with delta_seq <= this
  "up_to_position": "<opaque>",        // the bus Position of delta_seq 412 (from DeltaIndex)
  "generated_at_us": 0,                // wall-clock, observability only
  "node_count": 184,
  "edge_count": 233,
  "nodes": [ /* KnowledgeGraphNode[] — full set as of up_to_delta_seq */ ],
  "edges": [ /* KnowledgeGraphEdge[] */ ],
  "content_hash": "sha256:…",          // hash of (sorted node ids + edge ids + revisions)
  "consent_class": "standard"          // snapshot inherits session sensitivity
}
```

- Materialized **on demand** by F02 (C-7) or on a checkpoint cadence (every N
  deltas, configurable), persisted to **S3** (`s3://aizen-kg-snapshots/{tenant}/
  {session}/{snapshot_id}.json`), pointer cached in Redis.
- `up_to_delta_seq` + `up_to_position` are the splice point: after applying a
  snapshot, F03 resumes the live stream from `up_to_position`'s successor.
- `content_hash` lets F03 verify it converged (defends M-9 / drift).

### 3.4 `kg_resync_request` message schema (NEW contract, F03→F04)

```jsonc
{
  "message_type": "kg_resync_request",
  "session_id": "uuid",
  "tenant_id": "uuid",
  "requester": "f03.client@…",
  "last_applied_delta_seq": 408,       // highest contiguous delta_seq F03 has
  "gap": { "missing_from": 409, "observed": 412 },  // detected gap (409..411 missing)
  "reason": "delta_seq_gap",           // delta_seq_gap | cold_start | hash_mismatch | reconnect
  "max_replay": 200                    // F03's tolerance before it prefers a snapshot
}
```

Channel: a dedicated control subject on the bus (`session.{id}.kg.control`) or an
HTTP endpoint on the F04 replay service — **decision: HTTP request/response** on
the F04 replay API (resync is rare, low-volume, and wants a synchronous answer;
keeping it off the hot data stream avoids polluting `delta_seq` ordering).

### 3.5 The resync decision tree (F04 replay service)

```
on kg_resync_request(last_applied=L, observed gap, reason):
  gap_size = observed - L - 1
  if reason == "cold_start" or gap_size > max_replay or DeltaIndex lacks Position(L+1):
       -> serve NEAREST kg_snapshot with up_to_delta_seq >= L      (from S3)
          then stream live deltas from up_to_position.successor
          (if no snapshot fresh enough exists, ask F02 to materialize one now)
  else:  // small contiguous gap
       -> P = DeltaIndex[session_id][L+1]                          // translate
          replay deltas via EventBus.read(session_id, from: P) up to observed
  F03 applies snapshot (if any) then deltas in delta_seq order; verifies content_hash.
```

- `snapshot_offer: true` on a live `kg_delta` is now **meaningful**: it tells F03
  "a checkpoint snapshot ≥ this `delta_seq` exists in S3," so a future gap can be
  served cheaply. F02 sets it when it last materialized a checkpoint.
- Handles the three real cases H-9 left open: cold start (snapshot), small gap
  (offset-translated replay), large gap (snapshot + tail).

### 3.6 Contract tests

| ID | Test | Asserts |
|---|---|---|
| CT-C1 | Apply deltas 1–408, drop 409–411, receive 412 → F03 emits `kg_resync_request{last_applied=408, gap 409..411}` | gap detection on `delta_seq` |
| CT-C2 | Resync with gap_size=3 → F04 translates `delta_seq 409` via DeltaIndex → replays 409–411 by `Position` | **delta_seq↔Position mapping (H-9 core)** |
| CT-C3 | Cold start (`last_applied` none) → F04 serves latest `kg_snapshot` + tail | snapshot path |
| CT-C4 | gap_size > max_replay → snapshot + tail, not full replay | large-gap path |
| CT-C5 | After resync, F03 `content_hash` == snapshot `content_hash` | convergence guard |
| CT-C6 | No fresh snapshot exists on cold start → F04 triggers F02 materialize, then serves | on-demand production (C-7) |

---

## 4. M-2 — F02↔F03 field-name reconciliation

Doc 01 reconciled F01↔F02 (D16) but left F02↔F03 drift. F03's authoritative
assumptions use **stale names** for fields F02 already finalized in v1. F02 owns
these contracts (D06), so **F02 names win**; F03 adopts them by name (F03 renders
"by name only" — no adapter needed, just a corrected assumption set + a contract
test). The drift is in `InsightItem`:

| F03 stale assumption | F02 v1 authoritative | Action |
|---|---|---|
| `InsightItem.kind` | `insight_type` (`action_item\|decision\|open_question\|risk\|commitment`) | F03 reads `insight_type` |
| `InsightItem.assignee` | `owner_speaker_id` | F03 reads `owner_speaker_id` |
| `InsightItem.ts_start` / `ts_end` | `first_seen_t_us` (single anchor; insights are point-in-time, not spans) | F03 reads `first_seen_t_us`; drop the span assumption |

> Also pin **version floors** (L-3): F02 declares its minimum compatible F01
> `TranscriptSegment` `schema_version` (`>=1.0.0`), and F03 declares its minimum
> F02 `f02.contracts/v1`. Recorded in each consumer's README.

**Contract test CT-M2:** a golden `InsightItem` from F02 deserializes in the F03
renderer with zero unknown-field fallbacks on `insight_type`/`owner_speaker_id`/
`first_seen_t_us`; unknown *enum values* still fall back to `general`/`related_to`
(F02 §7 forward-compat), but known fields must bind by their real names.

---

## 5. What this unblocks, and what it does NOT

**Closes:** H-7 (adapter fully specified, `rev`/`supersedes` restored, tests),
H-8 (propagation algorithm + retract states + INV-8), H-9 (snapshot +
resync-request schemas + `delta_seq`↔`Position` index), M-2, M-5; and the
fail-closed *default* half of H-13.

**Does NOT close (tracked elsewhere, intentionally):**
- The **PII classifier itself** — recall target, eval set, model choice (H-13
  body) → recommendation 4 (trust/consent work). Seam A only fixes the default
  direction.
- The **latency arithmetic** (H-1/2/3) and the **partial-vs-final** binding
  decision → recommendation 2 (latency-budget rebuild). Seam A states the current
  rule (extract on finals) but does not re-budget it.
- The **cost model** (H-4/5/6) → recommendation 3 (now written: doc 11).
- **Per-speaker consent** (H-10/11/12) → recommendation 4.

**Next concrete step after this doc:** stand up the six contract-test suites
(CT-A*, CT-B*, CT-C*, CT-M2) as the *first* Phase 0 code — they are executable
specifications and will fail until the seams are implemented, which is exactly
the integration-time insurance doc 09 asked for.

---

*Authored as remediation item 1 of doc 09 (Blueprint Validation Review). Additive
to F01/F02 contracts; announce on the integration bus per each lane's versioning
policy.*
