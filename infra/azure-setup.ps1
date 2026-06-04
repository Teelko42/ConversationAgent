#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Push your local .env secrets into Azure Key Vault, with zero copy-paste.

.DESCRIPTION
  Run this AFTER `terraform apply` (Step 2). It:
    1. finds the Key Vault and PostgreSQL server Terraform created (so you never
       copy the random 6-char suffix by hand),
    2. reads the secret keys from your repo-root .env,
    3. writes each one that is filled in into Key Vault,
    4. generates a strong SESSION_COOKIE_SECRET if your .env doesn't have one,
    5. prints the Key Vault name, Postgres host, and a ready-to-use DATABASE_URL.
  It is idempotent — re-running just overwrites the same secrets.

.EXAMPLE
  ./infra/azure-setup.ps1

.EXAMPLE
  ./infra/azure-setup.ps1 -ResourceGroup aizen-mvp-rg -EnvFile ./.env
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup = "aizen-mvp-rg",
  [string]$EnvFile
)

$ErrorActionPreference = "Stop"
# az existence checks intentionally exit non-zero; don't let that auto-throw (PS 7.4+).
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "'az' CLI not found on PATH. Install the Azure CLI and run 'az login' first."
}

# Repo root = the parent of this script's folder (infra/).
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env" }

# --- Parse .env into a hashtable -------------------------------------------------
function Read-DotEnv([string]$path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $path) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim()
    if ($v.Length -ge 2 -and
        (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

$envMap = Read-DotEnv $EnvFile
Write-Host "Reading secrets from: $EnvFile" -ForegroundColor Cyan

# --- Discover the Key Vault and Postgres server ---------------------------------
Write-Host "Finding resources in resource group '$ResourceGroup'..." -ForegroundColor Cyan
$kv = (az keyvault list -g $ResourceGroup --query "[0].name" -o tsv).Trim()
if (-not $kv) {
  throw "No Key Vault found in '$ResourceGroup'. Did 'terraform apply' finish, and are you logged in to the right subscription?"
}
Write-Host "  Key Vault: $kv" -ForegroundColor Green

$pgFqdn = (az postgres flexible-server list -g $ResourceGroup --query "[0].fullyQualifiedDomainName" -o tsv).Trim()
if ($pgFqdn) { Write-Host "  Postgres : $pgFqdn" -ForegroundColor Green }

# --- env var -> Key Vault secret name -------------------------------------------
$secretMap = [ordered]@{
  ANTHROPIC_API_KEY       = "anthropic-api-key"
  DEEPGRAM_API_KEY        = "deepgram-api-key"
  TAVILY_API_KEY          = "tavily-api-key"
  GOOGLE_CLIENT_SECRET    = "google-client-secret"
  MICROSOFT_CLIENT_SECRET = "microsoft-client-secret"
  SESSION_COOKIE_SECRET   = "session-cookie-secret"
}

# Generate a strong cookie secret if the .env didn't set one.
if (-not $envMap["SESSION_COOKIE_SECRET"]) {
  $bytes = New-Object 'byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $envMap["SESSION_COOKIE_SECRET"] = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  Write-Host "Generated a new SESSION_COOKIE_SECRET (your .env didn't have one)." -ForegroundColor Yellow
}

Write-Host "`nWriting secrets to Key Vault '$kv':" -ForegroundColor Cyan
foreach ($envName in $secretMap.Keys) {
  $val = $envMap[$envName]
  $secretName = $secretMap[$envName]
  if (-not $val) {
    Write-Host "  - skip  $secretName  (not set in .env)" -ForegroundColor DarkGray
    continue
  }
  az keyvault secret set --vault-name $kv --name $secretName --value "$val" -o none
  Write-Host "  - set   $secretName" -ForegroundColor Green
}

# --- Print the values you need next ---------------------------------------------
Write-Host "`nDone. Values for the next steps:" -ForegroundColor Cyan
Write-Host "  KEY_VAULT = $kv"
if ($pgFqdn) {
  $pgPwd = (az keyvault secret show --vault-name $kv --name pg-admin-password --query value -o tsv).Trim()
  Write-Host "  PG_FQDN   = $pgFqdn"
  Write-Host "  DATABASE_URL (contains the DB password — keep it private):" -ForegroundColor Yellow
  Write-Host "    postgresql://aizen_admin:$pgPwd@${pgFqdn}:5432/aizen?sslmode=require"
}
Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  - To run the whole app on Azure:  ./infra/azure-deploy-app.ps1"
Write-Host "  - Or to run locally against Azure: put the DATABASE_URL above into your .env."
