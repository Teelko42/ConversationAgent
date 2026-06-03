<#
.SYNOPSIS
  Run the Aizen / ConversationAgent app (and its dev tasks) on Windows.

.DESCRIPTION
  A thin launcher over the package.json scripts. On this machine pnpm is not on
  PATH, so everything goes through `corepack pnpm` (corepack ships with Node 20+).
  This script wraps that, plus the run modes, so you don't have to remember the
  invocation.

  WHAT THE APP DOES
    Listens to a conversation, shows a live transcript, and -- when you click a
    finished sentence -- explains the phrase, breaks down its key words, and (if
    the sentence is a question) answers it from a web search with sources.

  MODES (chosen automatically by which keys are in .env)
    * No DEEPGRAM_API_KEY        -> DEMO  : a canned clip drives the transcript.
    * + ANTHROPIC_API_KEY        -> demo sentences are explained by the real model.
    * + DEEPGRAM_API_KEY         -> LIVE  : speak into your mic for live transcript.
    * + TAVILY_API_KEY           -> questions get web-sourced answers + citations.
  Keys live in .env at the repo root (copy .env.example to .env and paste keys).

.PARAMETER Task
  start     (default) Run the web app once (http://localhost:<port>).
  dev       Run the web app with auto-reload on file changes.
  demo      Run the web app forced into DEMO mode (ignores any keys in .env) --
            no API tokens spent; good for a quick look at the UI.
  spine     Run the headless capture->STT->intel->render spine (no browser).
  test      Run the full test suite once.
  typecheck Type-check the whole monorepo (tsc -b).
  install   Install dependencies (run once after cloning / pulling new deps).

.PARAMETER Port
  Override the web app port (default 5173). Ignored by test/typecheck/spine.

.EXAMPLE
  .\run.ps1                # start the app (live if keys are set, else demo)

.EXAMPLE
  .\run.ps1 demo           # force demo mode, no keys used

.EXAMPLE
  .\run.ps1 dev -Port 8080 # dev server with auto-reload on port 8080

.EXAMPLE
  .\run.ps1 install        # first-time setup
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'dev', 'demo', 'spine', 'test', 'typecheck', 'install')]
  [string]$Task = 'start',

  [int]$Port
)

$ErrorActionPreference = 'Stop'
# Always operate from the repo root (this script's folder), whatever the CWD.
Set-Location -LiteralPath $PSScriptRoot

# --- prerequisites --------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js is not installed or not on PATH. Install Node 20+ from https://nodejs.org'
  exit 1
}
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  Write-Error 'corepack is not available. It ships with Node 20+ -- upgrade Node, or run: npm i -g corepack'
  exit 1
}

# Warn (don't block) if there are no deps yet.
if ($Task -ne 'install' -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Warning "node_modules is missing -- run '.\run.ps1 install' first."
}

# Port override is read by config.ts via the PORT env var.
if ($PSBoundParameters.ContainsKey('Port')) { $env:PORT = "$Port" }

# --- run ------------------------------------------------------------------
switch ($Task) {
  'install' {
    Write-Host '>> Installing dependencies (corepack pnpm install)...' -ForegroundColor Cyan
    corepack pnpm install
  }
  'demo' {
    # Force DEMO regardless of .env: pre-set the provider keys to empty in this
    # process's environment. dotenv loads with override:false, so it will NOT
    # replace already-set vars, and config.ts treats '' as "absent" -> demo mode.
    Write-Host '>> Starting in forced DEMO mode (no API keys used)...' -ForegroundColor Cyan
    $env:ANTHROPIC_API_KEY = ''
    $env:DEEPGRAM_API_KEY  = ''
    $env:TAVILY_API_KEY    = ''
    corepack pnpm start
  }
  'dev' {
    Write-Host '>> Starting dev server (auto-reload)...' -ForegroundColor Cyan
    corepack pnpm dev
  }
  'spine' {
    Write-Host '>> Running the headless spine...' -ForegroundColor Cyan
    corepack pnpm spine
  }
  'test' {
    Write-Host '>> Running tests...' -ForegroundColor Cyan
    corepack pnpm test
  }
  'typecheck' {
    Write-Host '>> Type-checking (tsc -b)...' -ForegroundColor Cyan
    corepack pnpm typecheck
  }
  default {
    # 'start'
    $p = if ($env:PORT) { $env:PORT } else { '5173' }
    Write-Host ">> Starting the app -- open http://localhost:$p" -ForegroundColor Cyan
    corepack pnpm start
  }
}

exit $LASTEXITCODE
