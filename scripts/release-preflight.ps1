# Release preflight for @blue-soda/dsh-remote.
#
# Runs the checks that must pass before publishing, then the fast connection
# behaviour matrix. Credentials are never embedded here: the e2e harness uses
# the already-authorized DSH homes named by DSH_REMOTE_E2E_HOST and
# DSH_REMOTE_E2E_CLIENT, exactly like `scripts/remote-e2e.mts` itself.
#
# Usage:
#   pwsh -File scripts/release-preflight.ps1
#   pwsh -File scripts/release-preflight.ps1 -SkipE2E
#
# Optional environment:
#   DSH_CHECKOUT                 DSH checkout used by the e2e harness
#   DSH_REMOTE_E2E_HOST          authorized Host home
#   DSH_REMOTE_E2E_CLIENT        authorized Client home
#   DSH_REMOTE_E2E_HOST_PORT     Host port (default 63731)
#   DSH_REMOTE_E2E_CLIENT_PORT   Client port (default 63721)

[CmdletBinding()]
param(
  [switch]$SkipE2E
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Invoke-PreflightStep {
  param([string]$Name, [scriptblock]$Action)
  Write-Host ""
  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

Invoke-PreflightStep 'Plugin build' {
  pnpm --filter @blue-soda/dsh-remote build
}

Invoke-PreflightStep 'Plugin tests' {
  pnpm --filter @blue-soda/dsh-remote test
}

Invoke-PreflightStep 'DSH bundle contract' {
  node scripts/verify-dsh-plugin.mjs
}

Invoke-PreflightStep 'Break published-file hard links' {
  node scripts/break-hard-links.mjs packages/plugin
}

if (-not $SkipE2E) {
  Write-Host ""
  Write-Host '==> Fast e2e connection behaviour'
  Write-Host 'The Host must already be authorized in DSH_REMOTE_E2E_HOST.'
  Write-Host 'The slow matrix is intentionally excluded (`--fast`).'
  node --import tsx/esm scripts/remote-e2e.mts --fast
  if ($LASTEXITCODE -ne 0) {
    throw "Fast e2e failed with exit code $LASTEXITCODE"
  }
}

Write-Host ""
Write-Host 'Release preflight passed.'
