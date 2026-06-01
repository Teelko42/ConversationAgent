# Team 9 — Security, Privacy & Compliance

> Lane **F04** · Product **Aizen** · Cloud **AWS** (D03) · Privacy is first-class
> (**D10**, this lane owns the authoritative model). Scale targets **D02**.
>
> This document defines the controls that make Aizen **lawful to deploy** and
> **trustworthy for enterprises and regulated users**. Aizen continuously
> captures **live human conversation audio** across regulated verticals
> (healthcare, legal, finance) — so consent, audio privacy, encryption, retention,
> and regulatory posture are existential, not optional. It pairs with
> `team-08-infrastructure-platform.md`, which provides the substrate (KMS, VPC
> isolation, CloudTrail, RLS, silo option) these controls run on.

---

## 1. Security architecture

### 1.1 Posture

| Pillar | Approach |
|---|---|
| **Zero-trust** | No implicit network trust; every service call authenticated (IAM/SigV4 or mTLS), authorized per-tenant; private subnets only; no public DB/cache. |
| **Defense in depth** | Edge (WAF/Shield) → app (authn/z, input validation) → data (encryption, RLS, KMS) → audit (CloudTrail, immutable logs). |
| **Least privilege** | Scoped IAM roles per service; no long-lived keys; Secrets Manager + rotation; per-tenant KMS grants. |
| **Secure SDLC** | SAST (CodeQL), SCA (dependency scanning), IaC scanning (tfsec/Checkov), container scanning (ECR/Inspector), secret scanning (pre-commit + CI), signed images, mandatory review. |
| **Tenant isolation** | RLS + tenant-scoped keys/prefixes (pooled); silo (dedicated cluster + CMK) for enterprise/HIPAA. |
| **Privacy by design (D10)** | Consent gate before capture; no-retention default for audio; data minimization; PII redaction in logs. |

### 1.2 Identity & access

```
End users        → Cognito / enterprise IdP (SAML/OIDC) → session JWT (short TTL)
Service-to-service→ IAM roles (IRSA on EKS, task roles on Fargate) / mTLS mesh
Admin/operator   → SSO + MFA + just-in-time access (AWS IAM Identity Center) +
                    session recording for break-glass
Secrets          → AWS Secrets Manager (rotation) ; never in code/env files
Keys             → AWS KMS CMKs, per-tenant for silo, per-region for residency
```

### 1.3 Data classification (drives every control)

| Class | Examples | Controls |
|---|---|---|
| **C4 — Sensitive PII / PHI** | Audio of medical/legal/financial conversations, transcripts, voiceprints | Highest: consent-gated, encryption + CMK, no-retention default, BAA scope, restricted access, full audit |
| **C3 — Personal data** | User identity, contacts, session metadata | Encrypted, RLS, DSAR-subject, GDPR/CCPA scope |
| **C2 — Tenant operational** | Cards, graphs, insights derived from C3/C4 | Tenant-isolated, retention-governed |
| **C1 — Internal/telemetry** | Metrics, scrubbed logs | PII-scrubbed before storage |
| **C0 — Public** | Marketing, docs | None |

---

## 2. Threat model (STRIDE)

Scope: the real-time pipeline (capture → STT → extraction → explanation → render)
plus control plane (auth, tenant, billing, consent).

| # | STRIDE | Threat | Asset | Mitigation |
|---|---|---|---|---|
| T1 | **Spoofing** | Attacker joins/hijacks another tenant's live session | Session, audio | Short-TTL session JWT bound to `tenant_id`+`session_id`; WSS origin checks; per-session capability token; Cognito/SAML authn |
| T2 | **Spoofing** | Forged service identity injects fake `TranscriptSegment` | Event bus | mTLS/IAM-signed producers; topic ACLs; only Gateway may produce `audio.raw`, only STT may produce `transcript.seg` |
| T3 | **Tampering** | Modify transcripts/cards in transit or at rest | C2/C4 data | TLS 1.3 in transit; SSE-KMS at rest; checksum/version on artifacts; CloudTrail on KMS+S3 |
| T4 | **Tampering** | Replay/duplicate events to corrupt graph | Event bus | Idempotency on `(session_id, seq)`; monotonic `seq` enforced (D06); dedup table |
| T5 | **Repudiation** | Tenant denies consent was captured / data was deleted | Consent, audit | Immutable consent ledger + audit trail (CloudTrail + append-only DynamoDB/S3 Object Lock); signed events |
| T6 | **Info disclosure** | Cross-tenant data leak (the #1 SaaS risk) | All tenant data | RLS on every query; tenant-scoped KMS grants + S3 prefixes + Redis key prefixes; silo option; automated cross-tenant test in CI |
| T7 | **Info disclosure** | Audio/PHI exfiltration via logs or 3rd-party model calls | C4 | PII/PHI scrubbing before log index; no-retention mode; DPA/BAA-governed egress; redaction before LLM where required; self-host LLM tier for strict tenants |
| T8 | **Info disclosure** | Stolen credentials / leaked secrets | Keys, data | Secrets Manager + rotation; no static keys; GuardDuty + secret scanning; least-priv IAM |
| T9 | **Denial of service** | Flood Gateway / exhaust GPU/inference budget | Availability, cost | WAF rate limits, Shield Adv, per-tenant quotas, backpressure, token/cost caps per session |
| T10 | **Denial of service** | Prompt-injection / malicious audio drives runaway model cost or unsafe output | Cost, integrity | Input bounds, token caps, output filtering, prompt-injection guards (coordinate F02/F03), anomaly alerts |
| T11 | **Elevation of priv** | User escalates to admin / cross-tenant admin | Control plane | RBAC least-priv; deny-by-default; JIT admin + MFA; CloudTrail on all IAM/role assumes |
| T12 | **Elevation of priv** | Container escape / lateral movement | Infra | Private subnets, minimal images, no privileged containers, GuardDuty/Inspector, network policies, SG least-priv |

**Top risks ranked:** T6 (cross-tenant leak), T7 (audio/PHI disclosure), T9/T10
(cost/abuse), T1 (session hijack). These get continuous automated testing.

---

## 3. Consent management (D10 — two-party consent)

> **⚠ Superseded by D18–D19 / doc 13 (2026-06-01).** The per-session consent
> state machine in §3.2–§3.3 (one terminal `consented` state, gated once) is a
> per-speaker **legal exposure**: it has no transition for a late-joiner / new
> speaker mid-session, and revocation kills the whole session rather than one
> speaker — a wiretap risk in all-party states. Consent is re-modeled as a
> **per-speaker predicate** (`SpeakerConsent` per `(session, speaker_id)` +
> a continuously-evaluated `may_capture()`), with `speaker_detected → re-gate`,
> per-speaker revocation, and the constraint that **all-party capture requires
> per-track audio or blocks** (you cannot mask one voice in a mixed stream). The
> meeting-bot is gated to single-party jurisdictions at MVP (D19), and the
> "audio not stored" badge is split from sub-processor disclosure. Binding design:
> `00-integration/13-consent-and-privacy-redesign.md`.

### 3.1 Why this is hard and central

Recording conversations triggers **two-party (all-party) consent laws** in many
US states (CA, FL, IL, PA, WA, etc.) and equivalents abroad. Aizen records *other
people* in the room, not just the user. **Consent is a gating control, not a
checkbox** — the platform must not capture/process audio until consent state is
satisfied for the session.

### 3.2 Consent model

| Concept | Design |
|---|---|
| **Per-session consent capture** | Each session has a consent state machine; capture is blocked at the Gateway until consent requirements are met (Team 8 consent gate). |
| **Two-party / all-party** | Configurable per tenant/jurisdiction: `single-party` (user only) vs `all-party` (every participant must consent). Default to **all-party** for safety; tenant admin can set per jurisdiction. |
| **Consent mechanisms** | (a) explicit in-app acknowledgment by each participant who has an account; (b) **audible/visible disclosure** ("This conversation is being analyzed by Aizen") emitted at session start for in-room participants; (c) calendar/meeting-bot consent prompt for Zoom/Teams/Meet joins; (d) recorded verbal consent option. |
| **Consent ledger** | Immutable, append-only record per session: who consented, when, mechanism, jurisdiction, IP/device, consent text version. Stored with Object Lock / append-only (non-repudiation, T5). |
| **Withdrawal** | A participant can revoke mid-session → capture stops for that session and downstream artifacts are flagged for deletion per policy. |
| **Jurisdiction detection** | Best-effort (tenant config + geo) to choose single vs all-party; conservative default. |

### 3.3 Consent state machine

```
   created ──consent requirements computed──▶ awaiting_consent
                                                  │
            all required parties consented ──────▶ consented ──▶ capturing
                                                  │                  │
            timeout / refusal ──▶ denied          │   revoke ────────┘
                                                  ▼
                                            (capture blocked; no audio accepted)
```

The Gateway **will not subscribe `audio.raw` producers** until state = `consented`.
This is the single most important privacy control and is exposed to F01/F03 as a
hard precondition.

---

## 4. Audio privacy + no-retention mode (D10)

| Control | Design |
|---|---|
| **No-audio-retention mode (DEFAULT for C4/regulated)** | Audio is processed in-memory/in-stream only; `audio.raw` retention = 0 / TTL minimal; **never written to S3**. Only derived artifacts (transcript/cards) persist, and only if their retention is enabled. |
| **Ephemeral processing** | STT consumes `audio.raw` from the stream and the frames expire; no durable audio copy unless the tenant explicitly opts into retention with consent. |
| **Transcript-only mode** | Tenant can choose to retain transcripts but never audio. |
| **Voiceprint / biometric** | Speaker diarization (F01) produces *session-local* speaker labels by default; **persistent voiceprints are OFF by default** (BIPA/biometric-law risk). Persistent voiceprint = explicit opt-in + extra consent + biometric-data handling controls. |
| **Redaction** | Optional real-time PII/PHI redaction in transcripts (names, MRNs, card numbers) for storage/log paths. |
| **3rd-party model exposure** | In no-retention/strict mode, audio/transcript sent to hosted STT/LLM is governed by DPA/BAA; strict tenants use the **self-host STT/LLM tier** so no C4 data leaves the VPC. |
| **Local/edge option (future)** | On-device partial STT for the most sensitive tenants. |

---

## 5. Encryption & key management

| Layer | Control |
|---|---|
| **In transit** | **TLS 1.3** everywhere (client↔edge, edge↔service, service↔service). WSS/WebRTC (DTLS-SRTP for media). ACM-managed certs. Optional **mTLS** service mesh at scale. No plaintext internal hops. |
| **At rest** | **AES-256** via **SSE-KMS** on S3, Aurora, ElastiCache, OpenSearch, Neptune, DynamoDB, EBS, MSK. No unencrypted store exists. |
| **Key management** | **AWS KMS** customer-managed CMKs. **Per-tenant CMK for silo/HIPAA tenants**; per-region CMK for residency (EU keys in eu-central-1, never leave). Automatic key rotation; key policies least-priv; CloudTrail on every KMS use. |
| **Tenant isolation crypto** | Silo tenant data encrypted under its own CMK with a key policy scoped to that tenant's roles — a cross-tenant read fails at the crypto layer, not just the query layer (defense in depth for T6). |
| **Secrets** | AWS Secrets Manager, rotation enabled, accessed via IAM role, never in code/images/env. |
| **Envelope encryption** | App-level field encryption for the most sensitive fields (consent ledger, PHI markers) with KMS data keys. |

---

## 6. Data retention & deletion

| Data | Default retention | Configurable | Deletion |
|---|---|---|---|
| Raw audio | **0 (no-retention mode)** | tenant opt-in 0–90 d w/ consent | auto-expire (S3 lifecycle); immediate on revoke |
| Transcripts | 30 d | per tenant / per session | DSAR + retention sweep |
| Cards/graphs/insights | tenant policy | yes | cascade with transcript |
| Consent ledger / audit | **long (≥ 6 yr where HIPAA)** | regulated minimum | retained for compliance, not deletable by tenant (legal hold) |
| Telemetry (scrubbed) | 90 d | yes | rolling |

- **Retention engine:** EventBridge-scheduled Step Functions sweep applies
  per-tenant/per-session policy; S3 lifecycle rules enforce audio expiry; deletes
  cascade across Aurora, vector, graph, S3, and trigger re-index.
- **Right to erasure (GDPR Art.17 / CCPA):** a DSAR-delete removes C2/C3/C4 across
  all stores; the **consent/audit ledger is retained** (legal basis) with the
  subject's content redacted/tombstoned.
- **Crypto-shredding:** for silo tenants, destroying the per-tenant CMK renders
  all that tenant's data unrecoverable — fast, provable deletion.

---

## 7. GDPR + CCPA

| Requirement | Aizen control |
|---|---|
| **Lawful basis / consent** | Consent ledger (§3); processing only on valid basis |
| **DSAR — access/portability** | Self-serve export (Step Functions job) assembles a subject's data across stores → encrypted package; SLA ≤ 30 d |
| **DSAR — erasure** | §6 cascade delete + ledger tombstone |
| **DSAR — rectification** | Edit/correct via app + propagate |
| **Data minimization** | No-retention default; transcript-only mode; derived-data only |
| **DPA + sub-processors** | DPA with customers; **sub-processor list** (Anthropic, STT vendor, AWS, search vendor) published; DPAs/SCCs in place with each (manual task) |
| **Data residency** | EU tenants pinned to eu-central-1 (Team 8 §9); EU PII never crosses to US; SCCs only where transfer unavoidable |
| **Breach notification** | Incident-response runbook with 72 h GDPR notification path; GuardDuty/Security Hub detection feeds it |
| **CCPA/CPRA specifics** | "Do not sell/share" (we don't sell), opt-out, sensitive-PI handling, consumer rights portal (shared with DSAR flow) |
| **DPIA** | Data Protection Impact Assessment for the audio-capture processing (high-risk processing) — manual/legal task |

---

## 8. HIPAA (healthcare conversations)

Aizen will process **PHI** when used for medical conversations → HIPAA applies and
Aizen acts as a **Business Associate**.

| Requirement | Control |
|---|---|
| **BAA with customers** | Aizen signs BAAs with healthcare/covered-entity customers (HIPAA tier only) |
| **BAA with sub-processors** | BAA with AWS (available), Anthropic, and STT vendor — **or** use the **self-host STT/LLM tier** so PHI never leaves the VPC (preferred for HIPAA) — manual task |
| **PHI isolation** | HIPAA tenants = **silo** (dedicated Aurora cluster, per-tenant CMK, optionally dedicated VPC/namespace); no pooling of PHI |
| **No-retention default** | Audio not retained; transcripts encrypted + access-controlled + audited |
| **Encryption** | AES-256 at rest (CMK) + TLS 1.3 — satisfies the addressable encryption spec |
| **Access controls + audit** | RBAC least-priv, MFA, full audit trail of PHI access (§9/§10), 6-yr audit retention |
| **Workforce/admin** | JIT access, MFA, training, break-glass with session recording |
| **HIPAA-eligible AWS services only** | Restrict the HIPAA tier to AWS HIPAA-eligible services |

HIPAA is a **gated tier**, not default-on — enabled per tenant with BAA + silo +
self-host inference.

---

## 9. Enterprise controls

| Control | Design |
|---|---|
| **SSO — SAML 2.0 / OIDC** | Cognito federation or direct SAML to Okta/Entra/Google; SP-initiated + IdP-initiated |
| **SCIM 2.0** | Automated user/group provisioning + deprovisioning from the IdP |
| **RBAC** | Roles: Owner, Admin, Member, Viewer, Auditor, Compliance-Officer; per-tenant; least-priv; resource-scoped (sessions/graphs) |
| **IP allowlist / network policy** | Per-tenant CIDR allowlist enforced at WAF/Gateway; optional PrivateLink ingress for enterprise |
| **Audit logs (tenant-facing)** | Tenant admins get a searchable, exportable audit log (logins, access, exports, consent, deletions) |
| **Session/device policy** | Configurable session TTL, MFA enforcement, device trust |
| **Data residency selection** | Enterprise tenant chooses region (US/EU) at provisioning |
| **Self-host / silo tier** | Dedicated infra + CMK + in-VPC inference for the strictest customers |
| **DLP / retention policy** | Per-tenant retention, redaction, and export controls |

---

## 10. Audit trails

| Layer | Source | Storage | Property |
|---|---|---|---|
| Infra/API actions | **CloudTrail** (all regions, org trail) | S3 (Object Lock) + OpenSearch | Immutable, tamper-evident |
| Data access (who read what PHI/PII) | App-emitted access events | Append-only DynamoDB/S3 | Per-`tenant_id`/`session_id`, signed |
| Consent events | Consent ledger (§3) | S3 Object Lock | Non-repudiation (T5) |
| Admin/break-glass | IAM Identity Center + session recording | S3 | JIT, reviewed |
| Security events | **GuardDuty · Security Hub · Inspector · Config** | Security Hub aggregation → SIEM | Alerting + retention |

- **Tamper-evidence:** audit stores use S3 Object Lock (WORM) / append-only;
  CloudTrail log-file validation on.
- **Retention:** ≥ 1 yr default, **≥ 6 yr for HIPAA tenants**.
- **Tenant visibility:** tenant-scoped audit export feeds the enterprise audit-log
  feature (§9). The audit trail underpins SOC 2 CC-series controls.

---

## 11. Compliance roadmap

```
 Month:  0 ─────── 3 ─────── 6 ─────── 9 ─────── 12 ─────── 18 ─────── 24
         │         │         │         │          │          │          │
 MVP launch        SOC2 Type I        SOC2 Type II          HIPAA       ISO 27001
 (controls in      readiness +        observation           tier GA     (optional,
  place, GDPR/     auditor            window complete       + BAAs      enterprise)
  CCPA baseline)   engaged            (Type II report)
         │                                          │
         └─ GDPR/CCPA DPA + DSAR live from day 1     └─ FedRAMP/региональ. later (gov)
```

| Phase | Target | Deliverables |
|---|---|---|
| **0–3 mo (MVP)** | Baseline | Encryption, consent gate, no-retention default, RBAC, audit trail, GDPR/CCPA DPA + DSAR flows, sub-processor list, incident-response runbook, DPIA |
| **3–6 mo** | **SOC 2 Type I** | Control documentation, auditor engaged, policies (access, change-mgmt, IR, BCP/DR), evidence collection automated (Vanta/Drata-class) |
| **6–12 mo** | **SOC 2 Type II** | 6-month observation window; this is the enterprise unlock |
| **9–18 mo** | **HIPAA tier GA** | BAAs (AWS + sub-processors or self-host inference), silo provisioning, PHI audit, HIPAA risk assessment |
| **12–24 mo** | **GDPR full + ISO 27001** | EU residency (eu-central-1) GA, ISO 27001 for global enterprise, mature DPIA program |
| **Later** | FedRAMP / sector-specific | If pursuing public-sector / further regulated markets |

**Sequencing rationale:** SOC 2 Type II first (broadest enterprise unlock, builds
the control fabric everything else reuses), then HIPAA (vertical-specific, needs
silo + BAA + self-host inference), then GDPR-full/ISO 27001 (geo expansion).

---

## D12 required sections

### Architecture
Zero-trust, defense-in-depth security architecture (§1) layered over Team 8's
substrate: edge (WAF/Shield) → app (authn/z) → data (KMS/RLS) → audit (CloudTrail).
Consent gate (§3) is the entry control; no-retention audio (§4) is the privacy
default; per-tenant/per-region CMKs (§5) enforce isolation and residency.

### Technology recommendations
Cognito + SAML/OIDC + SCIM · IAM Identity Center (JIT admin) · AWS KMS (CMKs) ·
Secrets Manager · WAF + Shield Adv · GuardDuty + Security Hub + Inspector + Config ·
CloudTrail (org trail, Object Lock) · S3 Object Lock (WORM ledgers) · Macie
(PII/PHI discovery) · compliance-automation (Vanta/Drata-class) · SAST/SCA/IaC/
secret scanning in CI.

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| Cross-tenant data leak (T6) | Critical | RLS + per-tenant CMK + scoped prefixes + silo + CI cross-tenant tests |
| Audio/PHI disclosure to 3rd-party models (T7) | High | No-retention default, DPA/BAA, redaction, self-host tier |
| Consent law violation (two-party) | High | Consent gate blocks capture; all-party default; immutable ledger |
| Biometric-law (BIPA) via voiceprints | Med | Voiceprints OFF by default, opt-in only |
| Failed/slow SOC 2 → enterprise sales blocked | High | Engage auditor early; automate evidence |
| Breach + notification miss | High | GuardDuty/Security Hub detection + 72 h IR runbook |

### Scalability
Controls are tenant-scoped and scale with the platform: RLS/CMK per tenant, audit
pipeline on managed services, compliance automation. Silo model isolates blast
radius as tenant count grows; consent/audit ledgers are append-only and shard by
`tenant_id`.

### Security
This entire document. Substrate provided by Team 8 §1, §6, §10.

### Cost
Incremental to Team 8 §8.2: GuardDuty/Security Hub/Inspector/Macie/Config ≈
$500/mo (MVP) → $8k (Year-1) → $60k (North-star); compliance automation tool
~$1.5–3k/mo; Shield Adv $3k/mo from Year-1; auditor fees (SOC 2 ~$30–60k/yr,
HIPAA assessment ~$20–40k) are **one-time/annual professional fees** (manual
tasks), not infra. Silo/HIPAA tenants carry the dedicated-infra premium (Team 8).

### MVP scope
Encryption everywhere, consent gate, no-retention audio default, RBAC, basic SSO
(OIDC), CloudTrail + GuardDuty, GDPR/CCPA DPA + DSAR flows, incident-response
runbook, audit trail. Defer: SCIM, IP allowlist, HIPAA tier, silo automation,
SOC 2 evidence automation (start readiness, not certified).

### Future enhancements
On-device/edge STT for max privacy; confidential computing (Nitro Enclaves) for
PHI processing; customer-managed keys (BYOK) via external KMS; FedRAMP; automated
DPIA tooling; differential-privacy analytics; full mTLS mesh; bug-bounty program.

### Assumptions
A-SEC-1 two-party consent default (conservative) · A-SEC-2 healthcare use ⇒ HIPAA
BA role · A-SEC-3 EU residency required for EU enterprise by Year-1 · A-SEC-4
AWS, Anthropic offer BAAs; STT vendor BAA must be confirmed or self-host used ·
A-SEC-5 SOC 2 Type II is the primary enterprise gate.

### Decisions
**D-SEC-01** consent is a hard gate — no capture before `consented` (§3) ·
**D-SEC-02** no-audio-retention is the default; persistence is opt-in + consented
(§4) · **D-SEC-03** voiceprints OFF by default (BIPA) · **D-SEC-04** HIPAA = silo +
per-tenant CMK + self-host inference (§8) · **D-SEC-05** SOC 2 Type II → HIPAA →
GDPR-full/ISO sequencing (§11) · **D-SEC-06** per-region CMK; EU keys never leave EU.

### Tradeoffs
All-party consent default (safer, more friction) vs single-party (smoother, risky)
→ default all-party, tenant-configurable · Hosted inference (cheap/fast) vs
self-host (PHI never leaves, ops heavy) → self-host for HIPAA/strict, hosted+BAA
otherwise · Pooled (cheap) vs silo (isolated/compliant/costly) → silo for
regulated · Aggressive redaction (private) vs full fidelity (better explanations)
→ tenant-configurable.

### Open questions
OQ-SEC-1 STT-vendor BAA availability — if none, HIPAA tier must self-host (F01 +
platform). OQ-SEC-2 Anthropic API vs Bedrock for BAA/residency posture (coordinate
F02 + Team 8 OQ-PLAT-1). OQ-SEC-3 exact state-by-state consent matrix — needs legal
counsel. OQ-SEC-4 do we offer BYOK at launch or defer? OQ-SEC-5 in-room
non-account participant consent UX — coordinate with F03.

### Estimated complexity
**High.** Audio + regulated verticals + multi-tenant + multi-region makes this one
of the highest-stakes lanes; mistakes are legal/existential, not just bugs. MVP
controls achievable with platform team + fractional security/legal; SOC 2/HIPAA
need a dedicated security/compliance lead + external auditors by Year-1.
