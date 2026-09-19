param(
  [string]$ProjectPath,
  [string]$EnvironmentFile = '.env',
  [string]$ServerUrl = 'http://127.0.0.1:4310'
)
$ErrorActionPreference = 'Stop'
$harnessRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$codexPath = (Get-Command codex -ErrorAction Stop).Source
$environmentPath = Join-Path $harnessRoot $EnvironmentFile
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) { throw 'Complete harness setup first; the selected environment file is missing.' }
Push-Location $harnessRoot
try {
  npm run build -w apps/server
  if ($LASTEXITCODE -ne 0) { throw 'Harness build failed.' }
  & $codexPath mcp add sdlc --env "SDLC_CHAT_URL=$ServerUrl" -- $nodePath (Join-Path $harnessRoot 'apps/server/dist/chat-main.js') $harnessRoot $environmentPath
  if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
} finally { Pop-Location }

if ($ProjectPath) {
  $projectRoot = (Resolve-Path -LiteralPath $ProjectPath).Path
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) { throw 'ProjectPath must be the root of a Git checkout.' }
  $instructionsPath = Join-Path $projectRoot 'AGENTS.md'
  $instructions = Get-Content -LiteralPath (Join-Path $harnessRoot 'docs/codex-project-instructions.md') -Raw
  $existing = if (Test-Path -LiteralPath $instructionsPath) { Get-Content -LiteralPath $instructionsPath -Raw } else { '' }
  if (-not $existing.Contains('<!-- sdlc-chat-integration -->')) {
    Add-Content -LiteralPath $instructionsPath -Value ("`n" + $instructions) -Encoding utf8
  }
  Write-Output "Enabled SDLC routing in $instructionsPath"
}
Write-Output 'Connected sdlc to Codex. Restart Codex or open a fresh CLI session to load the tools.'
Write-Output 'Keep the local harness API and runner running. Ask Codex: Use SDLC to build my feature.'
