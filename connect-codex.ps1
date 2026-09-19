param(
  [string]$ProjectPath,
  [string]$EnvironmentFile = '.env',
  [string]$ServerUrl = 'http://127.0.0.1:4310'
)
$ErrorActionPreference = 'Stop'
$harnessRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$environmentPath = Join-Path $harnessRoot $EnvironmentFile
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
  throw 'Run start.ps1 once so the local harness environment exists.'
}

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
$mcpArguments = @($chatMain, $harnessRoot, $environmentPath) | ForEach-Object { ConvertTo-TomlString $_ }
if ($filtered.Count) { $filtered.Add('') }
$filtered.Add('[mcp_servers.sdlc]')
$filtered.Add("command = $(ConvertTo-TomlString $nodePath)")
$filtered.Add("args = [$($mcpArguments -join ', ')]")
$filtered.Add('tool_timeout_sec = 3600')
$filtered.Add('')
$filtered.Add('[mcp_servers.sdlc.env]')
$filtered.Add("SDLC_CHAT_URL = $(ConvertTo-TomlString $ServerUrl)")
[System.IO.File]::WriteAllLines($configPath, $filtered, [System.Text.UTF8Encoding]::new($false))

if ($ProjectPath) {
  $projectRoot = (Resolve-Path -LiteralPath $ProjectPath).Path
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) {
    throw 'ProjectPath must be the root of a Git checkout.'
  }
  $instructionsPath = Join-Path $projectRoot 'AGENTS.md'
  $instructions = Get-Content -LiteralPath (Join-Path $harnessRoot 'docs/codex-project-instructions.md') -Raw
  $existing = if (Test-Path -LiteralPath $instructionsPath) { Get-Content -LiteralPath $instructionsPath -Raw } else { '' }
  if (-not $existing.Contains('<!-- sdlc-chat-integration -->')) {
    Add-Content -LiteralPath $instructionsPath -Value ("`n" + $instructions) -Encoding utf8
  }
  Write-Output "Enabled automatic SDLC routing in $instructionsPath"
}

Write-Output 'Codex is connected. Restart the Codex app or open a fresh CLI session.'
Write-Output 'Open your existing project and ask Codex to build or fix something normally.'
