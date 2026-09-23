# Install, update or remove the BrewedOps Agentic Framework kit (Windows PowerShell).
#
#   .\install.ps1 -Tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   .\install.ps1 -Tool claude,cursor         # several at once, or -Tool all
#   .\install.ps1 -Tool codex -Rules          # also place the global rules starter
#   .\install.ps1 -Tool codex -DryRun         # show what would happen, change nothing
#   .\install.ps1 -Tool codex -Uninstall      # remove the kit's skills (kept in a backup folder)
#   .\install.ps1 -Tool codex -NoCodeStructure
#
# Update: git pull, then run the same install command again.
# Safe by default: replaced skills go to <skills folder>-backup\<timestamp>\ (the newest 3 sets are
# kept), and an existing rules file is never overwritten (the template is written next to it).
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Tool codex
param(
  [Parameter(Mandatory = $true)][string[]]$Tool,
  [switch]$Rules,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$NoCodeStructure,
  [string]$HomeDir = $HOME
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $Kit '.agents\skills'
$Template = Join-Path $SkillsSrc 'brewedops-app\references\global-rules.md'
$Version = (Get-Content (Join-Path $Kit 'VERSION') -Raw).Trim()
$KeepBackups = 3
# code-structure is fetched from its author at a PINNED commit and checked against a hash, so a
# change upstream never reaches users without a kit release. Bump all three together (see install.sh).
$CsRepo = 'https://github.com/michaelshimeles/skills'
$CsCommit = '4b72f46b045e6fef52e6a98d4c162dd309826aed'
$CsSha256 = '2f0ed408b525c65d422699490a159584fd977d0cfca5b15a5c9a47cf07b95f71'
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$Known = @('claude', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity')

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
    'antigravity' { Join-Path $HomeDir '.gemini\GEMINI.md' }   # one file, read by both
    'copilot' { Join-Path $HomeDir '.copilot\copilot-instructions.md' }
    default { $null }                                          # cursor: rules live in its settings UI
  }
}
# The install record sits NEXT TO the skills folder, never inside it.
function Get-ManifestPath([string]$d) { Join-Path (Split-Path -Parent $d) 'agentic-framework-kit.installed' }
function Read-Manifest([string]$d) {
  $m = Get-ManifestPath $d
  $r = @{ version = ''; skills = @() }
  if (Test-Path $m) {
    foreach ($line in (Get-Content $m)) {
      if ($line -like 'version=*') { $r.version = $line.Substring(8) }
      if ($line -like 'skills=*') { $r.skills = @($line.Substring(7) -split ' ' | Where-Object { $_ }) }
    }
  }
  return $r
}
function Backup-Skill([string]$Dir, [string]$Name, [string]$Label) {
  $bak = Join-Path "$Dir-backup" "$Ts$Label"
  Write-Output "   $Name -> $bak\"
  $src = Join-Path $Dir $Name
  Invoke-Step "move $src -> $bak" { New-Item -ItemType Directory -Force $bak | Out-Null; Move-Item $src $bak }
}
function Remove-OldBackups([string]$Dir) {
  $root = "$Dir-backup"
  if (-not (Test-Path $root)) { return }
  $old = @(Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -Skip $KeepBackups)
  foreach ($o in $old) {
    Write-Output "   pruned old backup $($o.FullName)"
    Invoke-Step "remove $($o.FullName)" { Remove-Item $o.FullName -Recurse -Force }
  }
}

$Dirs = @($Tools | ForEach-Object { Get-SkillDirs $_ } | Select-Object -Unique)
$Files = @($Tools | ForEach-Object { Get-RulesFile $_ } | Where-Object { $_ } | Select-Object -Unique)

# ---- uninstall -----------------------------------------------------------------------------------
if ($Uninstall) {
  foreach ($d in $Dirs) {
    $man = Read-Manifest $d
    if (-not (Test-Path (Get-ManifestPath $d))) { Write-Output ">> ${d}: no kit install record - nothing to remove"; continue }
    Write-Output ">> Removing kit skills from $d (moved to backup, not deleted)"
    foreach ($s in $man.skills) { if (Test-Path (Join-Path $d $s)) { Backup-Skill $d $s '-uninstall' } }
    $mp = Get-ManifestPath $d
    Invoke-Step "remove $mp" { Remove-Item $mp -Force }
    Remove-OldBackups $d
  }
  Write-Output ''
  Write-Output 'Your rules files were not touched - remove the framework sections by hand if you want.'
  exit 0
}

# ---- install / update ----------------------------------------------------------------------------
$CsSrc = $null
if (-not $NoCodeStructure) {
  $short = $CsCommit.Substring(0, 7)
  Write-Output ">> Fetching code-structure @ $short from $CsRepo (pinned; not redistributed here)"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "ms-skills-$Ts"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # git writes progress to stderr
  git -C $tmp init -q 2>$null
  git -C $tmp fetch -q --depth 1 $CsRepo $CsCommit 2>$null
  $fetched = ($LASTEXITCODE -eq 0)
  if ($fetched) { git -C $tmp checkout -q FETCH_HEAD 2>$null; $fetched = ($LASTEXITCODE -eq 0) }
  $ErrorActionPreference = $prevEap
  $skillFile = Join-Path $tmp 'code-structure\SKILL.md'
  if ($fetched -and (Test-Path $skillFile)) {
    $got = (Get-FileHash $skillFile -Algorithm SHA256).Hash.ToLower()
    if ($got -eq $CsSha256) { $CsSrc = Join-Path $tmp 'code-structure'; Write-Output '   ok (hash verified)' }
    else { Write-Output "   [!] code-structure hash mismatch - NOT installed (expected $CsSha256, got $got)" }
  } else {
    Write-Output '   [!] could not fetch code-structure - install it later by hand (see references\setup.md)'
  }
}

foreach ($d in $Dirs) {
  $man = Read-Manifest $d
  if ($man.version) { Write-Output ">> Skills -> $d (updating $($man.version) -> $Version)" }
  else { Write-Output ">> Skills -> $d (installing $Version)" }
  Invoke-Step "mkdir $d" { New-Item -ItemType Directory -Force $d | Out-Null }
  $names = @()
  $sources = @(Get-ChildItem $SkillsSrc -Directory | ForEach-Object { $_.FullName })
  if ($CsSrc) { $sources += $CsSrc }
  foreach ($src in $sources) {
    $n = Split-Path -Leaf $src
    $names += $n
    if (Test-Path (Join-Path $d $n)) { Backup-Skill $d $n '' }
    $dest = Join-Path $d $n
    Invoke-Step "copy $src -> $dest" { Copy-Item $src $dest -Recurse }
    Write-Output "   + $n"
  }
  # Keep skills an earlier run installed (e.g. code-structure on a -NoCodeStructure rerun),
  # so -Uninstall still finds them.
  foreach ($p in $man.skills) { if (($names -notcontains $p) -and (Test-Path (Join-Path $d $p))) { $names += $p } }
  $mp = Get-ManifestPath $d
  $body = "version=$Version`nskills=$($names -join ' ')`ninstalled=$Ts`n"
  Invoke-Step "write install record $mp" { [IO.File]::WriteAllText($mp, $body) }
  Remove-OldBackups $d
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
Write-Output "Done ($Version). Start a new session in your tool, then say `"brewedops app`" in an empty folder."
