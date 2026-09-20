$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$environmentFile = Join-Path $root '.env'

function New-Secret {
  $bytes = New-Object byte[] 32
  ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
  ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer, then run this file again.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found on PATH.' }

if (-not (Test-Path -LiteralPath $environmentFile)) {
  @(
    'PORT=4310'
    'HOST=127.0.0.1'
    'PUBLIC_URL=http://localhost:4310'
    'COOKIE_SECURE=false'
    "SESSION_SECRET=$(New-Secret)"
    "LOCAL_MCP_TOKEN=$(New-Secret)"
    'DATA_DIR=.runtime'
    'GITHUB_CLIENT_ID='
    'GITHUB_CLIENT_SECRET='
    'GITHUB_ALLOWED_USERS='
    'GITHUB_ADMIN_USERS='
  ) | Set-Content -LiteralPath $environmentFile -Encoding Ascii
}

function Remove-EnvironmentValue([string]$Name) {
  $pattern = "^$([regex]::Escape($Name))="
  $lines = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -notmatch $pattern }
  Set-Content -LiteralPath $environmentFile -Value $lines -Encoding Ascii
}

function Set-EnvironmentValue([string]$Name, [string]$Value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $environmentFile)
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match "^$([regex]::Escape($Name))=") {
      $lines[$index] = "$Name=$Value"
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add("$Name=$Value") }
  Set-Content -LiteralPath $environmentFile -Value $lines -Encoding Ascii
}

function Get-EnvironmentValue([string]$Name) {
  $line = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return $line.Substring($line.IndexOf('=') + 1).Trim()
}

Set-EnvironmentValue 'PORT' '4310'
Set-EnvironmentValue 'HOST' '127.0.0.1'
Set-EnvironmentValue 'PUBLIC_URL' 'http://localhost:4310'
Set-EnvironmentValue 'COOKIE_SECURE' 'false'
Set-EnvironmentValue 'DATA_DIR' '.runtime'
Remove-EnvironmentValue 'ADMIN_PASSWORD'
Remove-EnvironmentValue 'DEV_AUTH_TOKEN'
Remove-EnvironmentValue 'GITHUB_TOKEN'
if (-not (Select-String -LiteralPath $environmentFile -Pattern '^SESSION_SECRET=.{32,}$' -Quiet)) {
  Set-EnvironmentValue 'SESSION_SECRET' (New-Secret)
}
if (-not (Select-String -LiteralPath $environmentFile -Pattern '^LOCAL_MCP_TOKEN=.{32,}$' -Quiet)) {
  Set-EnvironmentValue 'LOCAL_MCP_TOKEN' (New-Secret)
}
foreach ($name in @('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_ALLOWED_USERS', 'GITHUB_ADMIN_USERS')) {
  if (-not (Select-String -LiteralPath $environmentFile -Pattern "^$name=" -Quiet)) {
    Set-EnvironmentValue $name ''
  }
}

$oauthClient = Get-EnvironmentValue 'GITHUB_CLIENT_ID'
$oauthSecret = Get-EnvironmentValue 'GITHUB_CLIENT_SECRET'
if (-not $oauthClient -or -not $oauthSecret) {
  Write-Output 'One-time GitHub browser login setup:'
  Write-Output 'Use Homepage URL: http://localhost:4310'
  Write-Output 'Use callback URL: http://localhost:4310/auth/github/callback'
  Start-Process 'https://github.com/settings/applications/new'
  $oauthClient = Read-Host 'Paste the OAuth App Client ID (or press Enter to configure it later)'
  if ($oauthClient) {
    $secureSecret = Read-Host 'Paste the OAuth App Client Secret' -AsSecureString
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    try { $oauthSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if (-not $oauthSecret) { throw 'The GitHub OAuth App Client Secret is required.' }
    $githubLogin = Read-Host 'Your GitHub username'
    if (-not $githubLogin) { throw 'Your GitHub username is required for the access allowlist.' }
    Set-EnvironmentValue 'GITHUB_CLIENT_ID' $oauthClient
    Set-EnvironmentValue 'GITHUB_CLIENT_SECRET' $oauthSecret
    Set-EnvironmentValue 'GITHUB_ALLOWED_USERS' $githubLogin
    Set-EnvironmentValue 'GITHUB_ADMIN_USERS' $githubLogin
    Write-Output 'GitHub browser login is configured.'
  } else {
    Write-Warning 'Continuing in local setup mode. Configure GitHub OAuth before repository publishing.'
  }
}

Push-Location $root
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Harness build failed.' }
  Start-Process 'http://localhost:4310'
  Write-Output 'SDLC Control Plane is ready at http://localhost:4310'
  Write-Output 'Keep this window open while using the harness. Press Ctrl+C to stop it.'
  npm start
} finally {
  Pop-Location
}
