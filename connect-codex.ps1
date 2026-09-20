param(
  [string]$ProjectPath,
  [string]$ServerUrl = 'http://127.0.0.1:4310'
)
$ErrorActionPreference = 'Stop'
$harnessRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source

Push-Location $harnessRoot
try {
  npm run build -w apps/server
  if ($LASTEXITCODE -ne 0) { throw 'Harness build failed.' }
} finally {
  Pop-Location
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
$null = New-Item -ItemType Directory -Path $codexHome -Force
$lines = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath } else { @() }
$filtered = [System.Collections.Generic.List[string]]::new()
$skipping = $false
foreach ($line in $lines) {
  if ($line -match '^\[mcp_servers\.sdlc(?:\..*)?\]$') {
    $skipping = $true
    continue
  }
  if ($skipping -and $line -match '^\[') { $skipping = $false }
  if (-not $skipping) { $filtered.Add($line) }
}
while ($filtered.Count -gt 0 -and -not $filtered[$filtered.Count - 1].Trim()) {
  $filtered.RemoveAt($filtered.Count - 1)
}
function ConvertTo-TomlString([string]$Value) {
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}
$chatMain = Join-Path $harnessRoot 'apps/server/dist/chat-main.js'
$mcpArguments = @(ConvertTo-TomlString $chatMain)
if ($filtered.Count) { $filtered.Add('') }
$filtered.Add('[mcp_servers.sdlc]')
$filtered.Add("command = $(ConvertTo-TomlString $nodePath)")
$filtered.Add("args = [$($mcpArguments -join ', ')]")
$filtered.Add('tool_timeout_sec = 3600')
$filtered.Add('')
$filtered.Add('[mcp_servers.sdlc.env]')
$filtered.Add("SDLC_CHAT_URL = $(ConvertTo-TomlString $ServerUrl)")
[System.IO.File]::WriteAllLines($configPath, $filtered, [System.Text.UTF8Encoding]::new($false))

$instructionsPath = Join-Path $codexHome 'AGENTS.md'
$instructions = Get-Content -LiteralPath (Join-Path $harnessRoot 'docs/codex-project-instructions.md') -Raw
$existing = ''
if (Test-Path -LiteralPath $instructionsPath) {
  $existing = [string](Get-Content -LiteralPath $instructionsPath -Raw)
}
if ($null -eq $existing) { $existing = '' }
$startMarker = '<!-- sdlc-chat-integration -->'
$endMarker = '<!-- /sdlc-chat-integration -->'
$start = $existing.IndexOf($startMarker)
if ($start -ge 0) {
  $end = $existing.IndexOf($endMarker, $start)
  $suffix = if ($end -ge 0) { $existing.Substring($end + $endMarker.Length) } else { '' }
  $existing = $existing.Substring(0, $start).TrimEnd() + "`n" + $instructions.Trim() + $suffix
} else {
  $existing = $existing.TrimEnd() + "`n" + $instructions.Trim() + "`n"
}
[System.IO.File]::WriteAllText($instructionsPath, $existing.TrimStart(), [System.Text.UTF8Encoding]::new($false))
Write-Output "Enabled automatic SDLC routing in $instructionsPath"

if ($ProjectPath) {
  $projectRoot = (Resolve-Path -LiteralPath $ProjectPath).Path
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) {
    throw 'ProjectPath must be the root of a Git checkout.'
  }
  Write-Output "Validated native project checkout at $projectRoot"
}

Write-Output 'Codex is connected. Restart the Codex app or open a fresh CLI session.'
Write-Output 'Open your existing project, turn on Plan mode, and describe the feature or bug.'
Write-Output 'The first governed prompt auto-detects the repository setup and asks you to confirm any uncertainty.'
Write-Output 'After you accept the plan, Codex implements it through the governed lifecycle.'
Write-Output 'When Testing asks for native review, type /review and choose Review uncommitted changes.'
