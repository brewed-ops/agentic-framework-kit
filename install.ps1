# Install, update, restore or remove the BrewedOps Agentic Framework kit (Windows PowerShell).
#
#   .\install.ps1 -Tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   .\install.ps1 -Tool claude,cursor         # several at once, or -Tool all
#   .\install.ps1 -Tool codex -Rules          # also place the global rules starter
#   .\install.ps1 -Tool codex -DryRun         # show what would happen, change nothing
#   .\install.ps1 -Tool codex -Project .      # into this project only (.agents\skills, .claude\skills)
#   .\install.ps1 -Tool codex -Skills greploop,ship   # only some of the kit's skills
#   .\install.ps1 -Tool codex -Force          # also replace same-named skills the kit did not install
#   .\install.ps1 -Tool codex -Restore        # put back the newest backup set
#   .\install.ps1 -Tool codex -Uninstall      # remove the kit's skills (kept in a backup folder)
#   .\install.ps1 -Tool codex -NoCodeStructure
#   .\install.ps1 -Version
#
# Update: git pull, then run the same install command again.
# Safe by default: a skill folder the kit did not install is never replaced without -Force;
# replaced skills go to <skills folder>-backup\<timestamp>\ (the newest 3 sets are kept); an
# existing rules file is never overwritten (the template is written next to it).
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Tool codex
param(
  [string[]]$Tool,
  [string]$Project,
  [string[]]$Skills,
  [switch]$Rules,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$Restore,
  [switch]$NoCodeStructure,
  [switch]$Version,
  [string]$HomeDir = $HOME
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $Kit '.agents\skills'
$Template = Join-Path $SkillsSrc 'brewedops-app\references\global-rules.md'
$KitVersion = (Get-Content (Join-Path $Kit 'VERSION') -Raw).Trim()
$KeepBackups = 3
$RecordName = 'agentic-framework-kit.installed'
# code-structure is fetched from its author at a PINNED commit and checked against a hash, so a
# change upstream never reaches users without a kit release. Bump all three together (see install.sh).
$CsRepo = 'https://github.com/michaelshimeles/skills'
$CsCommit = '4b72f46b045e6fef52e6a98d4c162dd309826aed'
$CsSha256 = '2f0ed408b525c65d422699490a159584fd977d0cfca5b15a5c9a47cf07b95f71'
# Test seam: KIT_CS_SHA256 overrides the expected hash so CI can prove a mismatch is refused.
# It exists only for tests - never set it for a real install.
if ($env:KIT_CS_SHA256) { $CsSha256 = $env:KIT_CS_SHA256.ToLower() }
$Known = @('claude', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity')

if ($Version) { Write-Output "agentic-framework-kit $KitVersion"; exit 0 }
if (-not $Tool) { Write-Output 'pass -Tool <claude|codex|cursor|gemini|copilot|antigravity|all>'; exit 1 }
if ($Uninstall -and $Restore) { Write-Output '-Uninstall and -Restore cannot be combined'; exit 1 }

$Tools = @($Tool | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
if ($Tools -contains 'all') { $Tools = $Known }
foreach ($t in $Tools) {
  if ($Known -notcontains $t) { Write-Output "unknown tool: $t (choose claude, codex, cursor, gemini, copilot, antigravity or all)"; exit 1 }
}
$ProjectDir = $null
if ($Project) {
  $ProjectDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
  if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) { Write-Output "-Project: $Project is not a folder"; exit 1 }
  $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).ProviderPath
}

# Which of the kit's own skills this run handles (-Skills), in the kit's order.
$KitSkills = @(Get-ChildItem -LiteralPath $SkillsSrc -Directory | ForEach-Object { $_.Name } | Sort-Object)
$Sel = $KitSkills
if ($Skills) {
  if ($Restore) { Write-Output '-Skills does not apply to -Restore (a restore puts back the whole backup set)'; exit 1 }
  $want = @($Skills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  foreach ($s in $want) {
    if ($s -eq 'code-structure') { Write-Output '-Skills: code-structure is controlled by -NoCodeStructure'; exit 1 }
    if ($KitSkills -notcontains $s) { Write-Output "unknown skill: $s (choose from: $($KitSkills -join ', '))"; exit 1 }
  }
  $Sel = @($KitSkills | Where-Object { $want -contains $_ })
}

function Invoke-Step([string]$Text, [scriptblock]$Action) {
  if ($DryRun) { Write-Output "   [dry-run] $Text" } else { & $Action }
}
function Get-SkillDirs([string]$t) {
  if ($ProjectDir) {   # project mode: Claude Code reads .claude\skills, the others .agents\skills
    if ($t -eq 'claude') { return @(Join-Path $ProjectDir '.claude\skills') }
    return @(Join-Path $ProjectDir '.agents\skills')
  }
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
function Get-ManifestPath([string]$d) { Join-Path (Split-Path -Parent $d) $RecordName }
function Read-RecordFile([string]$m) {
  $r = @{ version = ''; skills = @() }
  if (Test-Path -LiteralPath $m) {
    foreach ($line in (Get-Content -LiteralPath $m)) {
      if ($line -like 'version=*') { $r.version = $line.Substring(8) }
      if ($line -like 'skills=*') { $r.skills = @($line.Substring(7) -split ' ' | Where-Object { $_ }) }
    }
  }
  return $r
}
function Read-Manifest([string]$d) { Read-RecordFile (Get-ManifestPath $d) }
function Write-Record([string]$RecPath, [string]$RecVersion, [string[]]$RecSkills, [string]$Extra) {
  if (-not $RecSkills -or $RecSkills.Count -eq 0) {   # no skills left = no record
    Invoke-Step "remove $RecPath" { Remove-Item -LiteralPath $RecPath -Force -ErrorAction SilentlyContinue }
    return
  }
  $body = "version=$RecVersion`nskills=$($RecSkills -join ' ')`ninstalled=$Ts`n"
  if ($Extra) { $body += "$Extra`n" }
  Invoke-Step "write install record $RecPath" { [IO.File]::WriteAllText($RecPath, $body) }   # UTF-8, no BOM
}
function Get-BackupSets([string]$Dir) {   # backup set names, newest first (ordinal, same as bash LC_ALL=C)
  $root = "$Dir-backup"
  if (-not (Test-Path -LiteralPath $root)) { return }
  $names = [string[]]@(Get-ChildItem -LiteralPath $root -Directory | ForEach-Object { $_.Name })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  [Array]::Reverse($names)
  $names
}
function Get-SetSkills([string]$SetDir) { @(Get-ChildItem -LiteralPath $SetDir -Directory | ForEach-Object { $_.Name } | Sort-Object) }

$Dirs = @($Tools | ForEach-Object { Get-SkillDirs $_ } | Select-Object -Unique)
$Files = @($Tools | ForEach-Object { Get-RulesFile $_ } | Where-Object { $_ } | Select-Object -Unique)

# Backup sets are named by the second. If a set from this second already exists (scripted
# back-to-back runs), wait for the next second so set names stay unique and in order.
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'
function Test-TsTaken {
  foreach ($d in $Dirs) {
    $root = "$d-backup"
    if ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Filter "$Ts*").Count -gt 0) { return $true }
  }
  return $false
}
while (Test-TsTaken) { Start-Sleep -Seconds 1; $Ts = Get-Date -Format 'yyyyMMdd-HHmmss' }

$Bak = $null   # the backup set for the skills folder being processed
function Backup-Skill([string]$Dir, [string]$Name) {   # move it into $Bak, with a copy of the record it replaces
  $bakDir = $script:Bak
  Write-Output "   $Name -> $bakDir\"
  if (-not (Test-Path -LiteralPath $bakDir)) {
    $mp = Get-ManifestPath $Dir
    Invoke-Step "mkdir $bakDir" {
      New-Item -ItemType Directory -Force $bakDir | Out-Null
      if (Test-Path -LiteralPath $mp) { Copy-Item -LiteralPath $mp -Destination $bakDir }
    }
  }
  $src = Join-Path $Dir $Name
  Invoke-Step "move $src -> $bakDir" { Move-Item -LiteralPath $src -Destination $bakDir }
}
function Remove-OldBackups([string]$Dir) {   # keep the newest $KeepBackups sets
  $old = @(Get-BackupSets $Dir | Select-Object -Skip $KeepBackups)
  foreach ($o in $old) {
    $p = Join-Path "$Dir-backup" $o
    Write-Output "   pruned old backup $p"
    Invoke-Step "remove $p" { Remove-Item -LiteralPath $p -Recurse -Force }
  }
}

$Conflicts = @()
function Stop-OnConflicts {
  if ($script:Conflicts.Count -eq 0) { return }
  if ($Force) {
    Write-Output '>> -Force: these skill folders were not installed by this kit; backing them up, then replacing:'
    foreach ($c in $script:Conflicts) { Write-Output "   $c" }
    return
  }
  Write-Output '!! Stopped - nothing was changed. These skill folders exist but this kit did not install them'
  Write-Output "   (your own skill, or another package's, with the same name):"
  foreach ($c in $script:Conflicts) { Write-Output "   $c" }
  Write-Output '   Rerun with -Force to back them up (to <skills folder>-backup\) and replace them, or use'
  Write-Output '   -Skills / -NoCodeStructure to leave them alone. (Installed by kit 1.0.0, which kept no'
  Write-Output '   install record? Then -Force is safe.)'
  exit 1
}

# In a git project, keep the backup folders out of commits (local-only, never touches .gitignore).
function Add-GitExclude {
  $ex = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $p = & git -C $ProjectDir rev-parse --git-path info/exclude 2>$null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    if ($ok -and $p) {
      $p = "$p".Trim()
      if ([IO.Path]::IsPathRooted($p)) { $ex = $p } else { $ex = Join-Path $ProjectDir $p }
    }
  }
  if (-not $ex -and (Test-Path -LiteralPath (Join-Path $ProjectDir '.git') -PathType Container)) { $ex = Join-Path $ProjectDir '.git\info\exclude' }
  if (-not $ex) { return }
  $lines = @()
  if (Test-Path -LiteralPath $ex) { $lines = @(Get-Content -LiteralPath $ex) }
  $add = @('.agents/skills-backup/', '.claude/skills-backup/' | Where-Object { $lines -notcontains $_ })
  if ($add.Count -eq 0) { return }
  if ($DryRun) { Write-Output ">> [dry-run] would add $($add -join ' ') to $ex"; return }
  New-Item -ItemType Directory -Force (Split-Path -Parent $ex) | Out-Null
  $pre = ''
  if (Test-Path -LiteralPath $ex) {
    $raw = [IO.File]::ReadAllText($ex)
    if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n")) { $pre = "`n" }
  }
  [IO.File]::AppendAllText($ex, $pre + ($add -join "`n") + "`n")   # UTF-8, no BOM, LF
  Write-Output ">> Backups kept out of git: added $($add -join ' ') to $ex"
}
function Write-ProjectNotes {
  if (-not $ProjectDir) { return }
  Add-GitExclude
  Write-Output ''
  Write-Output "Project install: this project's rules file is its AGENTS.md (the brewedops-app skill can write"
  Write-Output 'it). No global rules file was touched. Commit .agents\skills (and .claude\skills) plus the'
  Write-Output "$RecordName file next to them if teammates should get the skills too."
}

# ---- uninstall -----------------------------------------------------------------------------------
if ($Uninstall) {
  foreach ($d in $Dirs) {
    $mp = Get-ManifestPath $d
    if (-not (Test-Path -LiteralPath $mp)) { Write-Output ">> ${d}: no kit install record - nothing to remove"; continue }
    $man = Read-Manifest $d
    Write-Output ">> Removing kit skills from $d (moved to backup, not deleted)"
    $Bak = Join-Path "$d-backup" "$Ts-uninstall"
    $keep = @()
    foreach ($s in $man.skills) {
      if ($Skills -and ($Sel -notcontains $s)) { $keep += $s; continue }
      if (Test-Path -LiteralPath (Join-Path $d $s)) { Backup-Skill $d $s }
    }
    Write-Record $mp $man.version $keep ''
    Remove-OldBackups $d
  }
  Write-ProjectNotes
  Write-Output ''
  Write-Output 'Your rules files were not touched - remove the framework sections by hand if you want.'
  exit 0
}

# ---- restore -------------------------------------------------------------------------------------
if ($Restore) {
  $missing = $false
  foreach ($d in $Dirs) {   # check every folder before changing any
    $t = @(Get-BackupSets $d) | Select-Object -First 1
    if (-not $t) { Write-Output "!! ${d}: no backup set in $d-backup - nothing to restore"; $missing = $true; continue }
    $cur = (Read-Manifest $d).skills
    foreach ($s in (Get-SetSkills (Join-Path "$d-backup" $t))) {
      if ((Test-Path -LiteralPath (Join-Path $d $s)) -and ($cur -notcontains $s)) { $Conflicts += (Join-Path $d $s) }
    }
  }
  Stop-OnConflicts
  foreach ($d in $Dirs) {
    $t = @(Get-BackupSets $d) | Select-Object -First 1
    if (-not $t) { continue }
    $src = Join-Path "$d-backup" $t
    $mp = Get-ManifestPath $d
    $cur = (Read-Manifest $d).skills
    $inSet = @(Get-SetSkills $src)
    $oldRec = Join-Path $src $RecordName
    $hasOld = Test-Path -LiteralPath $oldRec
    $old = @(); $oldVer = (Read-Manifest $d).version
    if ($hasOld) { $o = Read-RecordFile $oldRec; $old = $o.skills; $oldVer = $o.version }
    if (-not $oldVer) { $oldVer = $KitVersion }
    # Only skills the set's own record lists were the kit's; anything else in it (a folder
    # -Force moved aside) is restored but not claimed, so -Uninstall never takes it.
    $owned = @($inSet | Where-Object { $old -contains $_ })
    Write-Output ">> Restoring $d from backup set $src"
    $Bak = Join-Path "$d-backup" "$Ts-restore"
    $keep = @(); $moved = @()
    # Out go the kit skills this set replaces, and any the set's own record did not have yet.
    foreach ($s in $cur) {
      $here = Test-Path -LiteralPath (Join-Path $d $s)
      if (($inSet -contains $s) -or ($hasOld -and ($old -notcontains $s))) {
        if ($here) { Backup-Skill $d $s; $moved += $s }
      } elseif ($here) { $keep += $s }
    }
    foreach ($s in $inSet) {
      if ((Test-Path -LiteralPath (Join-Path $d $s)) -and ($moved -notcontains $s)) { Backup-Skill $d $s }   # -Force only
      $from = Join-Path $src $s; $dest = Join-Path $d $s
      Invoke-Step "copy $from -> $dest" { Copy-Item -LiteralPath $from -Destination $dest -Recurse }
      Write-Output "   + $s"
    }
    Write-Record $mp $oldVer (@($keep) + @($owned)) "restored_from=$t"
    Remove-OldBackups $d
  }
  Write-ProjectNotes
  if ($missing) { Write-Output ''; Write-Output '!! Nothing to restore for the folders above (no backup set yet).'; exit 1 }
  Write-Output ''
  Write-Output 'Restored. The skills that were there before are in the newest -restore backup set;'
  Write-Output 'run -Restore again to swap back.'
  exit 0
}

# ---- install / update ----------------------------------------------------------------------------
$Checked = @($Sel)
if (-not $NoCodeStructure) { $Checked += 'code-structure' }
foreach ($d in $Dirs) {   # conflict check for every folder before changing any
  $cur = (Read-Manifest $d).skills
  foreach ($n in $Checked) {
    if ((Test-Path -LiteralPath (Join-Path $d $n)) -and ($cur -notcontains $n)) { $Conflicts += (Join-Path $d $n) }
  }
}
Stop-OnConflicts

$CsSrc = $null; $CsFail = $null; $CsTmp = $null
if (-not $NoCodeStructure) {
  $short = $CsCommit.Substring(0, 7)
  Write-Output ">> Fetching code-structure @ $short from $CsRepo (pinned; not redistributed here)"
  $CsTmp = Join-Path ([IO.Path]::GetTempPath()) "ms-skills-$Ts-$PID"
  New-Item -ItemType Directory -Force $CsTmp | Out-Null
  $fetched = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # git writes progress to stderr
    git -C $CsTmp init -q 2>$null
    git -C $CsTmp fetch -q --depth 1 $CsRepo $CsCommit 2>$null
    $fetched = ($LASTEXITCODE -eq 0)
    if ($fetched) { git -C $CsTmp checkout -q FETCH_HEAD 2>$null; $fetched = ($LASTEXITCODE -eq 0) }
    $ErrorActionPreference = $prevEap
  }
  $skillFile = Join-Path $CsTmp 'code-structure\SKILL.md'
  if ($fetched -and (Test-Path -LiteralPath $skillFile)) {
    $got = (Get-FileHash -LiteralPath $skillFile -Algorithm SHA256).Hash.ToLower()
    if ($got -eq $CsSha256) { $CsSrc = Join-Path $CsTmp 'code-structure'; Write-Output '   ok (hash verified)' }
    else { Write-Output "   [!] code-structure hash mismatch - NOT installed (expected $CsSha256, got $got)"; $CsFail = 'hash' }
  } else {
    Write-Output '   [!] could not fetch code-structure - NOT installed'; $CsFail = 'fetch'
  }
}

foreach ($d in $Dirs) {
  $man = Read-Manifest $d
  if ($man.version) { Write-Output ">> Skills -> $d (updating $($man.version) -> $KitVersion)" }
  else { Write-Output ">> Skills -> $d (installing $KitVersion)" }
  Invoke-Step "mkdir $d" { New-Item -ItemType Directory -Force $d | Out-Null }
  $Bak = Join-Path "$d-backup" $Ts
  $names = @()
  $sources = @($Sel | ForEach-Object { Join-Path $SkillsSrc $_ })
  if ($CsSrc) { $sources += $CsSrc }
  foreach ($from in $sources) {
    $n = Split-Path -Leaf $from
    $names += $n
    $dest = Join-Path $d $n
    if (Test-Path -LiteralPath $dest) { Backup-Skill $d $n }
    Invoke-Step "copy $from -> $dest" { Copy-Item -LiteralPath $from -Destination $dest -Recurse }
    Write-Output "   + $n"
  }
  # Keep skills an earlier run installed and this one left alone (e.g. code-structure on a
  # -NoCodeStructure rerun, or the rest on a -Skills rerun), so -Uninstall still finds them.
  foreach ($p in $man.skills) { if (($names -notcontains $p) -and (Test-Path -LiteralPath (Join-Path $d $p))) { $names += $p } }
  Write-Record (Get-ManifestPath $d) $KitVersion $names ''
  Remove-OldBackups $d
}

if ($ProjectDir) {
  Write-ProjectNotes
  if ($Rules) { Write-Output '(-Rules is for the global rules files; it does nothing with -Project.)' }
} elseif ($Rules) {
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

if ($CsTmp) { Remove-Item -LiteralPath $CsTmp -Recurse -Force -ErrorAction SilentlyContinue }

if (($Tools -contains 'claude') -and (($Tools -contains 'cursor') -or ($Tools -contains 'copilot'))) {
  Write-Output ''
  Write-Output 'Note: Cursor and Copilot also read the Claude Code skills folder, so each skill may appear twice there.'
}
Write-Output ''
if ($CsFail -eq 'hash') {
  Write-Output "!! The kit's skills are installed, but code-structure is NOT: the download did not match the"
  Write-Output '   pinned SHA-256, so it was refused. Please report it; to skip it, rerun with -NoCodeStructure.'
  exit 1
} elseif ($CsFail -eq 'fetch') {
  Write-Output "!! The kit's skills are installed, but code-structure is NOT: it could not be downloaded"
  Write-Output '   (network, or git missing). Retry the same command, or install with -NoCodeStructure.'
  exit 1
}
Write-Output "Done ($KitVersion). Start a new session in your tool, then say `"brewedops app`" in an empty folder."
