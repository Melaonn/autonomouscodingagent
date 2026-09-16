param([string]$AdminPassword)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $root '.env.compose'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is required.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop, then run this file again.' }

$generatedPassword = $false
if (-not (Test-Path -LiteralPath $environmentFile)) {
  function New-Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
  if (-not $AdminPassword) { $AdminPassword = "sdlc-$((New-Secret).Substring(0,20))"; $generatedPassword = $true }
  if ($AdminPassword.Length -lt 16) { throw 'Administrator password must have at least 16 characters.' }
  @(
    'PUBLIC_URL=http://localhost:4310'
    'COOKIE_SECURE=false'
    "ADMIN_PASSWORD=$AdminPassword"
    "SESSION_SECRET=$(New-Secret)"
    "RUNNER_TOKEN=$(New-Secret)"
    "POSTGRES_PASSWORD=$(New-Secret)"
    'CODEX_AUTH_MOUNT=sdlc-codex-auth'
    'MAX_ACTIVE_RUNS=2'
  ) | Set-Content -LiteralPath $environmentFile -Encoding utf8
}

Push-Location $root
try { docker compose --env-file $environmentFile up --build -d }
finally { Pop-Location }
Start-Process 'http://localhost:4310'
Write-Output 'SDLC Control Plane is ready at http://localhost:4310'
if ($generatedPassword) { Write-Output "Administrator password: $AdminPassword" }
