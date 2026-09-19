param([string]$AdminPassword)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$environmentFile = Join-Path $root '.env'
$generatedPassword = $false

function New-Secret {
  $bytes = New-Object byte[] 32
  ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
  ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer, then run this file again.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found on PATH.' }

if (-not (Test-Path -LiteralPath $environmentFile)) {
  if (-not $AdminPassword) {
    $AdminPassword = "sdlc-$((New-Secret).Substring(0, 20))"
    $generatedPassword = $true
  }
  if ($AdminPassword.Length -lt 16) { throw 'Administrator password must have at least 16 characters.' }
  @(
    'PORT=4310'
    'HOST=127.0.0.1'
    'PUBLIC_URL=http://localhost:4310'
    'COOKIE_SECURE=false'
    "ADMIN_PASSWORD=$AdminPassword"
    "SESSION_SECRET=$(New-Secret)"
    'DATA_DIR=.runtime'
    'GITHUB_TOKEN='
  ) | Set-Content -LiteralPath $environmentFile -Encoding Ascii
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

Set-EnvironmentValue 'PORT' '4310'
Set-EnvironmentValue 'HOST' '127.0.0.1'
Set-EnvironmentValue 'PUBLIC_URL' 'http://localhost:4310'
Set-EnvironmentValue 'COOKIE_SECURE' 'false'
Set-EnvironmentValue 'DATA_DIR' '.runtime'
if (-not (Select-String -LiteralPath $environmentFile -Pattern '^(ADMIN_PASSWORD|DEV_AUTH_TOKEN)=.{16,}$' -Quiet)) {
  $AdminPassword = "sdlc-$((New-Secret).Substring(0, 20))"
  Set-EnvironmentValue 'ADMIN_PASSWORD' $AdminPassword
  $generatedPassword = $true
}
if (-not (Select-String -LiteralPath $environmentFile -Pattern '^SESSION_SECRET=.{32,}$' -Quiet)) {
  Set-EnvironmentValue 'SESSION_SECRET' (New-Secret)
}

Push-Location $root
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Harness build failed.' }
  Start-Process 'http://localhost:4310'
  Write-Output 'SDLC Control Plane is ready at http://localhost:4310'
  if ($generatedPassword) { Write-Output "Administrator password: $AdminPassword" }
  Write-Output 'Keep this window open while using the harness. Press Ctrl+C to stop it.'
  npm start
} finally {
  Pop-Location
}
