# Install the BrewedOps Agentic Framework kit for one or more AI coding tools (Windows PowerShell).
#
#   .\install.ps1 -Tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   .\install.ps1 -Tool claude,cursor         # several at once
#   .\install.ps1 -Tool all
#   .\install.ps1 -Tool codex -Rules          # also place the global rules starter
#   .\install.ps1 -Tool codex -DryRun         # show what would happen, change nothing
#   .\install.ps1 -Tool codex -NoCodeStructure
#
# Safe by default: an existing skill folder is moved to <skills folder>-backup\<timestamp>\ before
# it is replaced, and an existing rules file is never overwritten (the template is written next to it).
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Tool codex
param(
  [Parameter(Mandatory = $true)][string[]]$Tool,
  [switch]$Rules,
  [switch]$DryRun,
  [switch]$NoCodeStructure,
  [string]$HomeDir = $HOME
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $Kit '.agents\skills'
$Template = Join-Path $SkillsSrc 'brewedops-app\references\global-rules.md'
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$Known = @('claude', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity')

# -Tool accepts "a,b" as one string or as an array
$Tools = @($Tool | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
if ($Tools -contains 'all') { $Tools = $Known }
foreach ($t in $Tools) {
  if ($Known -notcontains $t) { Write-Output "unknown tool: $t (choose claude, codex, cursor, gemini, copilot, antigravity or all)"; exit 1 }
}

function Invoke-Step([string]$Text, [scriptblock]$Action) {
  if ($DryRun) { Write-Output "   [dry-run] $Text" } else { & $Action }
}

function Get-SkillDirs([string]$t) {
  switch ($t) {
    'claude' { @(Join-Path $HomeDir '.claude\skills') }
    'antigravity' { @((Join-Path $HomeDir '.gemini\config\skills'), (Join-Path $HomeDir '.gemini\antigravity-cli\skills')) }
    default { @(Join-Path $HomeDir '.agents\skills') }   # codex, cursor, gemini, copilot
  }
}
function Get-RulesFile([string]$t) {
  switch ($t) {
    'claude' { Join-Path $HomeDir '.claude\CLAUDE.md' }
    'codex' { Join-Path $HomeDir '.codex\AGENTS.md' }
    'gemini' { Join-Path $HomeDir '.gemini\GEMINI.md' }
    'antigravity' { Join-Path $HomeDir '.gemini\GEMINI.md' }   # shared with Gemini CLI
    'copilot' { Join-Path $HomeDir '.copilot\copilot-instructions.md' }
    default { $null }                                          # cursor: rules live in its settings UI
  }
}

$Dirs = @($Tools | ForEach-Object { Get-SkillDirs $_ } | Select-Object -Unique)
$Files = @($Tools | ForEach-Object { Get-RulesFile $_ } | Where-Object { $_ } | Select-Object -Unique)

$CsSrc = $null
if (-not $NoCodeStructure) {
  Write-Output '>> Fetching code-structure from github.com/michaelshimeles/skills (not redistributed here)'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "ms-skills-$Ts"
  git clone -q --depth 1 https://github.com/michaelshimeles/skills $tmp 2>$null
  if (($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $tmp 'code-structure\SKILL.md'))) {
    $CsSrc = Join-Path $tmp 'code-structure'
    Write-Output '   ok'
  } else {
    Write-Output '   [!] could not fetch code-structure - install it later by hand (see references\setup.md)'
  }
}

function Install-Skill([string]$Src, [string]$DestDir) {
  $name = Split-Path -Leaf $Src
  $dest = Join-Path $DestDir $name
  # Backups go in a SIBLING folder: a copy left inside the skills folder would be discovered
  # by the tool as a second skill with the same name.
  $bak = Join-Path "$DestDir-backup" $Ts
  if (Test-Path $dest) {
    Write-Output "   existing $name -> backed up to $bak\"
    Invoke-Step "move $dest -> $bak" { New-Item -ItemType Directory -Force $bak | Out-Null; Move-Item $dest $bak }
  }
  Invoke-Step "copy $Src -> $dest" { Copy-Item $Src $dest -Recurse }
  Write-Output "   + $name"
}

foreach ($d in $Dirs) {
  Write-Output ">> Skills -> $d"
  Invoke-Step "mkdir $d" { New-Item -ItemType Directory -Force $d | Out-Null }
  foreach ($s in (Get-ChildItem $SkillsSrc -Directory)) { Install-Skill $s.FullName $d }
  if ($CsSrc) { Install-Skill $CsSrc $d }
}

if ($Rules) {
  foreach ($f in $Files) {
    $exists = (Test-Path $f) -and ((Get-Item $f).Length -gt 0)
    if ($exists -and (Select-String -Path $f -Pattern 'agentic-framework-kit: global rules' -Quiet)) {
      Write-Output ">> Rules: $f already has the framework rules - left alone"
    } elseif ($exists) {
      Write-Output ">> Rules: $f exists - NOT overwritten. Template written to $f.framework-template.md;"
      Write-Output '   ask your AI to merge the sections you are missing.'
      Invoke-Step "copy template -> $f.framework-template.md" { Copy-Item $Template "$f.framework-template.md" }
    } else {
      Write-Output ">> Rules: $f created from the starter template - fill in the <ANGLE BRACKET> parts"
      $parent = Split-Path -Parent $f
      Invoke-Step "create $f" { New-Item -ItemType Directory -Force $parent | Out-Null; Copy-Item $Template $f }
    }
  }
  if ($Tools -contains 'cursor') {
    Write-Output '>> Rules (Cursor): paste .agents\skills\brewedops-app\references\global-rules.md into Settings > Rules > User Rules'
  }
}

if ($CsSrc) { Remove-Item (Split-Path -Parent $CsSrc) -Recurse -Force -ErrorAction SilentlyContinue }

if (($Tools -contains 'claude') -and (($Tools -contains 'cursor') -or ($Tools -contains 'copilot'))) {
  Write-Output ''
  Write-Output 'Note: Cursor and Copilot also read ~\.claude\skills, so each skill may appear twice there.'
}
Write-Output ''
Write-Output 'Done. Next: open a project in your AI tool and say "brewedops app" to set one up,'
Write-Output 'or read AGENTS.md in this kit for what each skill does.'
