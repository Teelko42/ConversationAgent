#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Build the app image and run it on Azure Container Apps, wired to Key Vault + Postgres.

.DESCRIPTION
  Run this AFTER azure-setup.ps1 (so the secrets already live in Key Vault). It:
    1. discovers the Key Vault, Postgres host, and registry name (no suffix copy-paste),
    2. builds the Docker image in Azure Container Registry (creating the registry if needed),
    3. creates the Container App with a managed identity (or updates its image if it exists),
    4. grants that identity pull access on the registry and read access on Key Vault,
    5. wires every Key Vault secret that exists, plus a composed DATABASE_URL and the
       public client IDs from your .env, into the app's environment.
  It is idempotent. Requires Owner/Contributor + User Access Administrator on the
  resource group (for the role assignment in step 4).

.EXAMPLE
  ./infra/azure-deploy-app.ps1
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup = "aizen-mvp-rg",
  [string]$AppName       = "aizen-server",
  [string]$ContainerEnv  = "aizen-mvp-cae",
  [string]$EnvFile,
  [int]$Port             = 5173
)

$ErrorActionPreference = "Stop"
# az existence checks (acr/containerapp show) and re-runnable role assignment
# intentionally exit non-zero; don't let that auto-throw (PS 7.4+). Critical steps
# below are gated explicitly with $LASTEXITCODE.
$PSNativeCommandUseErrorActionPreference = $false
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "'az' CLI not found on PATH. Install the Azure CLI and run 'az login' first."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env" }

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

# --- Discover resources ----------------------------------------------------------
$kv = (az keyvault list -g $ResourceGroup --query "[0].name" -o tsv).Trim()
if (-not $kv) { throw "No Key Vault in '$ResourceGroup' — run 'terraform apply' first." }
$suffix   = $kv -replace '^aizen-mvp-kv-', ''
$pgFqdn   = (az postgres flexible-server list -g $ResourceGroup --query "[0].fullyQualifiedDomainName" -o tsv).Trim()
$vaultUri = (az keyvault show -n $kv --query properties.vaultUri -o tsv).Trim()
$acr      = "aizenmvpacr$suffix"   # globally-unique, reuses the infra suffix

Write-Host "Key Vault : $kv"      -ForegroundColor Green
Write-Host "Postgres  : $pgFqdn"  -ForegroundColor Green
Write-Host "Registry  : $acr"     -ForegroundColor Green

# --- 1. Registry + image build ---------------------------------------------------
$acrExists = az acr show -n $acr -g $ResourceGroup --query name -o tsv 2>$null
if (-not $acrExists) {
  Write-Host "`nCreating container registry $acr..." -ForegroundColor Cyan
  az acr create -n $acr -g $ResourceGroup --sku Basic -o none
}
Write-Host "Building the image in the cloud (a few minutes)..." -ForegroundColor Cyan
az acr build -r $acr -t aizen-server:latest $repoRoot
if ($LASTEXITCODE -ne 0) { throw "Image build failed." }
$image = "$acr.azurecr.io/aizen-server:latest"

# --- 2. Create or update the Container App --------------------------------------
$appExists = az containerapp show -n $AppName -g $ResourceGroup --query name -o tsv 2>$null
if (-not $appExists) {
  Write-Host "`nCreating Container App $AppName..." -ForegroundColor Cyan
  az containerapp create `
    --name $AppName -g $ResourceGroup `
    --environment $ContainerEnv `
    --image $image `
    --registry-server "$acr.azurecr.io" `
    --ingress external --target-port $Port `
    --system-assigned `
    --min-replicas 1 --max-replicas 3 -o none
  if ($LASTEXITCODE -ne 0) { throw "Container App create failed." }
} else {
  Write-Host "`nUpdating Container App image..." -ForegroundColor Cyan
  az containerapp update -n $AppName -g $ResourceGroup --image $image -o none
}

# --- 3. Grant the app's managed identity access ---------------------------------
$principalId = (az containerapp show -n $AppName -g $ResourceGroup --query identity.principalId -o tsv).Trim()
$acrId       = (az acr show -n $acr -g $ResourceGroup --query id -o tsv).Trim()
Write-Host "Granting the app identity AcrPull + Key Vault read..." -ForegroundColor Cyan
# (role assignment may already exist on a re-run; that's fine)
az role assignment create --assignee $principalId --role AcrPull --scope $acrId -o none 2>$null
az keyvault set-policy --name $kv --object-id $principalId --secret-permissions get list -o none

# --- 4. Wire secrets + env vars --------------------------------------------------
# Container-App-secret name -> (Key Vault secret name, app env var)
$wiring = [ordered]@{
  "anthropic-key"    = @("anthropic-api-key",       "ANTHROPIC_API_KEY")
  "deepgram-key"     = @("deepgram-api-key",         "DEEPGRAM_API_KEY")
  "tavily-key"       = @("tavily-api-key",           "TAVILY_API_KEY")
  "google-secret"    = @("google-client-secret",     "GOOGLE_CLIENT_SECRET")
  "microsoft-secret" = @("microsoft-client-secret",  "MICROSOFT_CLIENT_SECRET")
  "cookie-secret"    = @("session-cookie-secret",    "SESSION_COOKIE_SECRET")
}

# Only wire secrets that actually exist in Key Vault (a broken keyvaultref would
# otherwise fail to sync). The app is key-gated, so a missing one just drops to a stub.
$present = @{}
foreach ($n in (az keyvault secret list --vault-name $kv --query "[].name" -o tsv) -split "`n") {
  if ($n.Trim()) { $present[$n.Trim()] = $true }
}

$secretArgs = @()
$envArgs    = @()
foreach ($caSecret in $wiring.Keys) {
  $kvName, $envName = $wiring[$caSecret]
  if ($present[$kvName]) {
    $secretArgs += "$caSecret=keyvaultref:${vaultUri}secrets/$kvName,identityref:system"
    $envArgs    += "$envName=secretref:$caSecret"
  }
}

# Compose the full DATABASE_URL (password pulled from Key Vault) and store it as a
# Container App secret so the password never appears in the plain env definition.
$pgPwd = (az keyvault secret show --vault-name $kv --name pg-admin-password --query value -o tsv).Trim()
$secretArgs += "database-url=postgresql://aizen_admin:$pgPwd@${pgFqdn}:5432/aizen?sslmode=require"
$envArgs    += "DATABASE_URL=secretref:database-url"

# Public (non-secret) config straight from .env.
if ($envMap["GOOGLE_CLIENT_ID"])    { $envArgs += "GOOGLE_CLIENT_ID=$($envMap['GOOGLE_CLIENT_ID'])" }
if ($envMap["MICROSOFT_CLIENT_ID"]) { $envArgs += "MICROSOFT_CLIENT_ID=$($envMap['MICROSOFT_CLIENT_ID'])" }
if ($envMap["MICROSOFT_TENANT"])    { $envArgs += "MICROSOFT_TENANT=$($envMap['MICROSOFT_TENANT'])" }
$webProvider = if ($envMap["WEB_SEARCH_PROVIDER"]) { $envMap["WEB_SEARCH_PROVIDER"] } else { "tavily" }
$envArgs += "WEB_SEARCH_PROVIDER=$webProvider"
$envArgs += "PORT=$Port"

Write-Host "Setting Container App secrets + environment variables..." -ForegroundColor Cyan
az containerapp secret set -n $AppName -g $ResourceGroup --secrets $secretArgs -o none
az containerapp update    -n $AppName -g $ResourceGroup --set-env-vars $envArgs -o none

# --- 5. Done — print the URL + OAuth reminder -----------------------------------
$fqdn = (az containerapp show -n $AppName -g $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv).Trim()
Write-Host "`nDeployed. Your app is at:" -ForegroundColor Green
Write-Host "  https://$fqdn"
Write-Host "`nIf you use Google/Microsoft sign-in, add these redirect URIs at the provider:" -ForegroundColor Yellow
Write-Host "  https://$fqdn/auth/google/callback"
Write-Host "  https://$fqdn/auth/microsoft/callback"
Write-Host "`nWatch the startup banner with:" -ForegroundColor Cyan
Write-Host "  az containerapp logs show -n $AppName -g $ResourceGroup --tail 50"
