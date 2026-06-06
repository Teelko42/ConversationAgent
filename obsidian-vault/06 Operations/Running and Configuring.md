---
title: Running and Configuring
aliases: [Running, Run, Configuration, Keys, .env, run.ps1, Modes]
tags: [operations, setup]
created: 2026-06-05
---

# Running & Configuring

> [!abstract] One app, run by key presence
> There's **no separate demo build**. The same app runs stubbed or fully real depending
> on which keys are in `.env` (decision **BD-03**). It boots even with **no keys at all**.

---

## Quick start

```bash
corepack pnpm@9.7.0 install
cp .env.example .env          # paste your keys into .env (never into .env.example)
corepack pnpm@9.7.0 start     # → http://localhost:5173
```

Open the URL and click **Start listening**. On Windows there's a convenience launcher
(`run.ps1`) that wraps `corepack pnpm` (pnpm isn't on PATH on the dev machine):

```powershell
.\run.ps1            # start (live if keys are set, else demo)
.\run.ps1 demo      # force DEMO regardless of keys (no API tokens spent)
.\run.ps1 dev -Port 8080
.\run.ps1 spine     # the headless capture→STT→intel spine, printed to the console
.\run.ps1 test      # the full test suite
.\run.ps1 install   # first-time setup
```

> [!note] How `demo` forces stub mode
> `run.ps1 demo` pre-sets the provider keys to empty in the process env. dotenv loads with
> `override:false` (won't replace already-set vars) and `config.ts` treats `''` as
> **absent**, so the app picks the stub providers — a quick look at the UI with no tokens.

---

## The escalating modes

| Keys present | Mode | What you get |
|---|---|---|
| none | **demo** | a canned clip drives the pipeline; everything stubbed |
| `ANTHROPIC_API_KEY` | **demo + real AI** | the demo sentence is explained by the real model |
| `+ DEEPGRAM_API_KEY` | **live** | speak into your mic → live transcript → real explanations |
| `+ TAVILY_API_KEY` | **live + sourced** | answers carry web citations |
| `+ GOOGLE_/MICROSOFT_*` | **+ real sign-in** | OAuth instead of the stub demo account |

The startup banner prints which providers are active; the UI shows a **LIVE / DEMO** badge
from the `{type:'status'}` frame ([[The Server]]).

---

## The `.env` keys (`.env.example`)

`.env` is gitignored; `.env.example` is committed and contains **no secrets**. Empty =
absent. **No secret is ever logged** — only whether each is set ([[The Server|config.ts]]).

| Key | Enables | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | real explanations/answers | [[The LLM Gateway]] |
| `DEEPGRAM_API_KEY` | live mic speech-to-text | [[Audio Capture and STT]] |
| `WEB_SEARCH_PROVIDER` (`tavily`) + `TAVILY_API_KEY` | web-sourced answers | [[The Intelligence Engine]] |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth sign-in | [[The Account System]] |
| `MICROSOFT_CLIENT_ID` / `_SECRET` / `MICROSOFT_TENANT` | Entra OAuth sign-in | [[The Account System]] |
| `SESSION_COOKIE_SECRET` | persist logins across restarts (HMAC) | [[The Account System]] |
| `ACCOUNTS_DB` | SQLite file path (default `.data/accounts.db`) | [[The Account System]] |
| `DATABASE_URL` | use PostgreSQL instead of SQLite (Azure target) | [[The Account System]] |
| `USE_LOCAL_DB` | force local SQLite even if `DATABASE_URL` is set | "secrets in Key Vault, DB local" |
| `PORT` (5173) / `TENANT_ID` | server basics | [[The Server]] |

OAuth redirect URIs (local): `http://localhost:5173/auth/google/callback` and
`/auth/microsoft/callback`.

> [!tip] "Secrets in Azure Key Vault, database on your laptop"
> `scripts/start-local-azure-secrets.ps1` sets `USE_LOCAL_DB=1` so you can source the API
> keys + cookie secret from Azure Key Vault while keeping the accounts DB local (SQLite),
> even with a `DATABASE_URL` present. See [[Deployment and Testing]].

---

## What the app does, in one breath
The browser captures the mic, downsamples to 16 kHz PCM16, and streams it over a
WebSocket; the server bridges it to Deepgram, runs the [[The Intelligence Engine|engine]]
over the one [[The Event Bus|session bus]], and pushes transcript + concept results back —
and when you click a finished sentence it explains the phrase, breaks down its key words,
and (if it's a question) answers it with sources.

---

## Related
- [[The Server]] — what `pnpm start` launches
- [[Deployment and Testing]] — Docker, Azure, the test suite, toolchain quirks
- [[The Account System]] — the optional accounts/OAuth keys
- [[What Is Aizen]] — the modes from the product side
