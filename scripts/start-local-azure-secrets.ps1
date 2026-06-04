#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run Aizen locally with a LOCAL database (SQLite) but API secrets pulled live from
  Azure Key Vault.

.DESCRIPTION
  The "secrets in Azure, database on your laptop" mode. This script:
    1. finds your Key Vault (or takes -VaultName),
    2. pulls each app secret from Key Vault into THIS process's environment
       (never written to disk — they live only in the vault and in memory for this run),
    3. forces the local SQLite database with USE_LOCAL_DB=1 (so a DATABASE_URL left in
       your .env is ignored — the database stays on your laptop at .data/accounts.db),
    4. starts the app.
  Run `az login` first. Non-secret config (client IDs, PORT, etc.) still comes from .env.

.EXAMPLE
  ./scripts/start-local-azure-secrets.ps1

.EXAMPLE
  ./scripts/start-local-azure-secrets.ps1 -VaultName aizen-mvp-kv-ab12cd
#>
[CmdletBinding()]
param(
  [string]$VaultName,
  [string]$ResourceGroup = "aizen-mvp-rg"
)

$ErrorActionPreference = "Stop"
# az 'show/list' may exit non-zero; handle exit codes explicitly (PS 7.4+).
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "'az' CLI not found on PATH. Install the Azure CLI and run 'az login' first."
}

# Discover the vault if not passed.
if (-not $VaultName) {
  $VaultName = (az keyvault list -g $ResourceGroup --query "[0].name" -o tsv).Trim()
  if (-not $VaultName) {
    throw "No Key Vault found in '$ResourceGroup'. Pass -VaultName <name>, or check you're logged in (az login) to the right subscription."
  }
}
Write-Host "Key Vault: $VaultName" -ForegroundColor Green

# Key Vault secret name -> the env var the app reads.
$map = [ordered]@{
  "anthropic-api-key"       = "ANTHROPIC_API_KEY"
  "deepgram-api-key"        = "DEEPGRAM_API_KEY"
  "tavily-api-key"          = "TAVILY_API_KEY"
  "google-client-secret"    = "GOOGLE_CLIENT_SECRET"
  "microsoft-client-secret" = "MICROSOFT_CLIENT_SECRET"
  "session-cookie-secret"   = "SESSION_COOKIE_SECRET"
}

Write-Host "Pulling secrets from Key Vault into this session..." -ForegroundColor Cyan
$pulled = 0
foreach ($secretName in $map.Keys) {
  $val = az keyvault secret show --vault-name $VaultName --name $secretName --query value -o tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and $val) {
    Set-Item -Path "Env:$($map[$secretName])" -Value ($val.Trim())
    Write-Host "  - $($map[$secretName])" -ForegroundColor Green
    $pulled++
  } else {
    Write-Host "  - skip $secretName (not in vault)" -ForegroundColor DarkGray
  }
}
if ($pulled -eq 0) {
  throw "No secrets were found in '$VaultName'. Add them with ./infra/azure-setup.ps1 first."
}

# Keep the DATABASE LOCAL: this flag makes config.ts ignore any DATABASE_URL.
$env:USE_LOCAL_DB = "1"
Write-Host "`nDatabase: LOCAL SQLite (.data/accounts.db) — USE_LOCAL_DB=1" -ForegroundColor Green

# Launch the app (prefer pnpm on PATH, else corepack).
Write-Host "Starting the app...`n" -ForegroundColor Cyan
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm start
} else {
  corepack pnpm start
}
