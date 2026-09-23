# End-to-end checks for install.ps1, including the failure paths (conflicts, a bad code-structure
# hash, a failed download, restore with no backup). Every case runs in a throwaway -HomeDir.
# Works on Windows PowerShell 5.1 and PowerShell 7; the installer runs in the same edition.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\install-smoke.ps1
#   pwsh -NoProfile -File tests\install-smoke.ps1
# Needs git and network for the code-structure cases.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Kit = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$I = Join-Path $Kit 'install.ps1'
$Exe = (Get-Process -Id $PID).Path
$Rec = 'agentic-framework-kit.installed'
$All = @('brewedops-app', 'greploop', 'scanloop', 'ship', 'code-structure')
$script:Out = ''

function Invoke-Kit {   # runs the installer in a child process; returns its exit code, output in $script:Out
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $o = & $Exe -NoProfile -ExecutionPolicy Bypass -File $I @args 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $script:Out = ($o | Out-String)
  return $code
}
function Fail([string]$m) { Write-Output "FAIL: $m"; Write-Output '--- last installer output ---'; Write-Output $script:Out; exit 1 }
function Pass([string]$m) { Write-Output "ok   $m" }
function New-TempDir([string]$Name) {
  $p = Join-Path ([IO.Path]::GetTempPath()) ("kit-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  if ($Name) { $p = Join-Path $p $Name }
  New-Item -ItemType Directory -Force $p | Out-Null
  return $p
}
function Get-RecSkills([string]$m) { ((Get-Content -LiteralPath $m | Where-Object { $_ -like 'skills=*' }) -replace '^skills=', '') }
function Test-File([string]$p) { Test-Path -LiteralPath $p -PathType Leaf }

# -Version prints the VERSION file
$ver = (Get-Content (Join-Path $Kit 'VERSION') -Raw).Trim()
if ((Invoke-Kit -Version) -ne 0) { Fail '-Version exit code' }
if ($script:Out.Trim() -ne "agentic-framework-kit $ver") { Fail '-Version output' }
Pass '-Version prints VERSION'

# normal run: code-structure hash verified, every skill installed, record lists them
$h = New-TempDir; $S = Join-Path $h '.agents\skills'; $R = Join-Path $h ".agents\$Rec"
if ((Invoke-Kit -Tool codex -HomeDir $h) -ne 0) { Fail 'install exited non-zero' }
if ($script:Out -notmatch 'ok \(hash verified\)') { Fail "no 'hash verified' message" }
foreach ($k in $All) { if (-not (Test-File (Join-Path $S "$k\SKILL.md"))) { Fail "missing $k" } }
if ((Get-RecSkills $R) -ne ($All -join ' ')) { Fail 'record skills line' }
if (([IO.File]::ReadAllBytes($R)[0..2] -join ',') -eq '239,187,191') { Fail 'record has a BOM' }
Pass 'install: hash verified, all skills, record'

# uninstall: no kit skills left, record gone
if ((Invoke-Kit -Tool codex -Uninstall -HomeDir $h) -ne 0) { Fail 'uninstall exited non-zero' }
foreach ($k in $All) { if (Test-Path -LiteralPath (Join-Path $S $k)) { Fail "uninstall left $k" } }
if (Test-Path -LiteralPath $R) { Fail 'uninstall left the record' }
if (@(Get-ChildItem -LiteralPath $S -Force).Count -ne 0) { Fail 'skills folder not empty after uninstall' }
Pass 'uninstall removes kit skills and the record'

# install + 4 reruns -> exactly 3 backup sets, none inside the skills folder
$h = New-TempDir; $S = Join-Path $h '.agents\skills'
foreach ($round in 1..5) { if ((Invoke-Kit -Tool codex -NoCodeStructure -HomeDir $h) -ne 0) { Fail "rerun $round" } }
$n = @(Get-ChildItem -LiteralPath (Join-Path $h '.agents\skills-backup') -Directory).Count
if ($n -ne 3) { Fail "expected 3 backup sets, got $n" }
if (@(Get-ChildItem -LiteralPath $S | Where-Object { $_.Name -like '*backup*' }).Count -ne 0) { Fail 'backup leaked into the skills folder' }
Pass '4 reruns keep exactly 3 backup sets'

# hash mismatch (test seam): non-zero, no code-structure, kit skills still installed
$h = New-TempDir; $S = Join-Path $h '.agents\skills'
$env:KIT_CS_SHA256 = 'deadbeef'
$code = Invoke-Kit -Tool codex -HomeDir $h
Remove-Item Env:\KIT_CS_SHA256
if ($code -eq 0) { Fail 'mismatch should exit non-zero' }
if ($script:Out -notmatch 'hash mismatch') { Fail 'no mismatch message' }
if (Test-Path -LiteralPath (Join-Path $S 'code-structure')) { Fail 'code-structure installed despite mismatch' }
if (-not (Test-File (Join-Path $S 'greploop\SKILL.md'))) { Fail 'kit skills not installed on mismatch' }
Pass 'hash mismatch refused, exit non-zero'

# download failure (unreachable proxy): non-zero, clear message
$h = New-TempDir; $S = Join-Path $h '.agents\skills'
$env:HTTPS_PROXY = 'http://127.0.0.1:9'
$code = Invoke-Kit -Tool codex -HomeDir $h
Remove-Item Env:\HTTPS_PROXY
if ($code -eq 0) { Fail 'failed download should exit non-zero' }
if ($script:Out -notmatch 'could not be downloaded') { Fail 'no download-failure message' }
if ($script:Out -notmatch '-NoCodeStructure') { Fail 'download failure does not suggest -NoCodeStructure' }
if (Test-Path -LiteralPath (Join-Path $S 'code-structure')) { Fail 'code-structure present after failed download' }
Pass 'download failure exits non-zero'

# conflict: a same-named skill the kit did not install stops everything
$h = New-TempDir; $S = Join-Path $h '.agents\skills'; $R = Join-Path $h ".agents\$Rec"
New-Item -ItemType Directory -Force (Join-Path $S 'greploop') | Out-Null
[IO.File]::WriteAllText((Join-Path $S 'greploop\SKILL.md'), "my own greploop`n")
if ((Invoke-Kit -Tool codex -NoCodeStructure -HomeDir $h) -eq 0) { Fail 'conflict should exit non-zero' }
if ($script:Out -notmatch 'Stopped - nothing was changed') { Fail 'no conflict message' }
if ((Get-Content -LiteralPath (Join-Path $S 'greploop\SKILL.md') -Raw).Trim() -ne 'my own greploop') { Fail "user's skill was touched" }
if ((Test-Path -LiteralPath (Join-Path $S 'ship')) -or (Test-Path -LiteralPath $R)) { Fail 'conflict run still changed things' }
Pass "conflict stops with non-zero, user's skill untouched"

# -Force backs it up, then replaces it
if ((Invoke-Kit -Tool codex -NoCodeStructure -Force -HomeDir $h) -ne 0) { Fail '-Force exited non-zero' }
if (-not (Select-String -LiteralPath (Join-Path $S 'greploop\SKILL.md') -Pattern '^name: greploop' -Quiet)) { Fail '-Force did not replace' }
$saved = @(Get-ChildItem -LiteralPath (Join-Path $h '.agents\skills-backup') -Recurse -Filter SKILL.md | Where-Object { (Get-Content -LiteralPath $_.FullName -Raw).Trim() -eq 'my own greploop' })
if ($saved.Count -ne 1) { Fail "-Force did not back up the user's skill" }
Pass '-Force backs up and replaces'

# restoring that set gives the user's skill back without the record claiming it
if ((Invoke-Kit -Tool codex -Restore -HomeDir $h) -ne 0) { Fail '-Restore after -Force' }
if ((Get-Content -LiteralPath (Join-Path $S 'greploop\SKILL.md') -Raw).Trim() -ne 'my own greploop') { Fail "-Restore did not return the user's skill" }
if ((Get-RecSkills $R) -match 'greploop') { Fail "record claims the user's greploop" }
Pass "-Restore after -Force returns the user's skill, unclaimed"

# -Restore brings back the previous set, and a second -Restore swaps back
$h = New-TempDir; $S = Join-Path $h '.agents\skills'; $R = Join-Path $h ".agents\$Rec"
$marker = Join-Path $S 'greploop\marker'
if ((Invoke-Kit -Tool codex -NoCodeStructure -HomeDir $h) -ne 0) { Fail 'install' }
[IO.File]::WriteAllText($marker, 'previous')
if ((Invoke-Kit -Tool codex -NoCodeStructure -HomeDir $h) -ne 0) { Fail 'rerun' }
if (Test-Path -LiteralPath $marker) { Fail 'rerun did not replace greploop' }
if ((Invoke-Kit -Tool codex -Restore -HomeDir $h) -ne 0) { Fail '-Restore exited non-zero' }
if (-not (Test-File $marker) -or (Get-Content -LiteralPath $marker -Raw) -ne 'previous') { Fail '-Restore did not bring back the previous set' }
if (-not (Select-String -LiteralPath $R -Pattern '^restored_from=' -Quiet)) { Fail 'record not rewritten by -Restore' }
foreach ($k in 'brewedops-app', 'greploop', 'scanloop', 'ship') { if (-not (Test-File (Join-Path $S "$k\SKILL.md"))) { Fail "restore lost $k" } }
if ((Invoke-Kit -Tool codex -Restore -HomeDir $h) -ne 0) { Fail 'second -Restore' }
if (Test-Path -LiteralPath $marker) { Fail 'second -Restore did not swap back' }
Pass '-Restore brings back the previous set (and swaps back)'

# -Restore with no backup: non-zero, clear message
$h = New-TempDir
if ((Invoke-Kit -Tool codex -Restore -HomeDir $h) -eq 0) { Fail '-Restore without backup should exit non-zero' }
if ($script:Out -notmatch 'nothing to restore') { Fail "no 'nothing to restore' message" }
Pass '-Restore without a backup exits non-zero'

# -Skills installs only those
$h = New-TempDir; $S = Join-Path $h '.agents\skills'; $R = Join-Path $h ".agents\$Rec"
if ((Invoke-Kit -Tool codex -Skills 'greploop,ship' -NoCodeStructure -HomeDir $h) -ne 0) { Fail '-Skills' }
if (-not (Test-File (Join-Path $S 'greploop\SKILL.md')) -or -not (Test-File (Join-Path $S 'ship\SKILL.md'))) { Fail '-Skills missed a skill' }
if ((Test-Path -LiteralPath (Join-Path $S 'brewedops-app')) -or (Test-Path -LiteralPath (Join-Path $S 'scanloop'))) { Fail '-Skills installed extra skills' }
if ((Get-RecSkills $R) -ne 'greploop ship') { Fail '-Skills record' }
if ((Invoke-Kit -Tool codex -Skills nope -HomeDir $h) -eq 0) { Fail 'unknown -Skills name should exit non-zero' }
Pass '-Skills installs only the listed skills'

# -Project into a git repo: .agents\skills, record, .git\info\exclude (idempotent), home untouched
$h = New-TempDir
$P = New-TempDir 'my project'
& git -C $P init -q
if ((Invoke-Kit -Tool 'codex,claude' -Project $P -NoCodeStructure -Rules -HomeDir $h) -ne 0) { Fail '-Project' }
if (-not (Test-File (Join-Path $P '.agents\skills\greploop\SKILL.md'))) { Fail '-Project: no .agents\skills' }
if (-not (Test-File (Join-Path $P '.claude\skills\greploop\SKILL.md'))) { Fail '-Project: no .claude\skills for claude' }
if (-not (Test-File (Join-Path $P ".agents\$Rec"))) { Fail '-Project: no record' }
if (@(Get-ChildItem -LiteralPath $h -Force).Count -ne 0) { Fail '-Project wrote to the home folder' }
if ($script:Out -notmatch 'AGENTS\.md') { Fail '-Project: no AGENTS.md hint' }
if ((Invoke-Kit -Tool 'codex,claude' -Project $P -NoCodeStructure -HomeDir $h) -ne 0) { Fail '-Project rerun' }
$ex = Join-Path $P '.git\info\exclude'
if (@(Get-Content -LiteralPath $ex | Where-Object { $_ -eq '.agents/skills-backup/' }).Count -ne 1) { Fail 'exclude not written once' }
if (-not (Test-Path -LiteralPath (Join-Path $P '.agents\skills-backup'))) { Fail '-Project rerun made no backup' }
if ((& git -C $P status --porcelain --untracked-files=all) -match 'skills-backup') { Fail 'backups visible to git' }
if ((Invoke-Kit -Tool 'codex,claude' -Project $P -Uninstall -HomeDir $h) -ne 0) { Fail '-Project uninstall' }
if ((Test-Path -LiteralPath (Join-Path $P '.agents\skills\greploop')) -or (Test-Path -LiteralPath (Join-Path $P ".agents\$Rec"))) { Fail '-Project uninstall' }
Pass '-Project installs locally and keeps backups out of git'

Write-Output "install.ps1 ($($PSVersionTable.PSVersion)): all checks passed"
