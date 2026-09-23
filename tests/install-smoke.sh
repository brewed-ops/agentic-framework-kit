#!/usr/bin/env bash
# End-to-end checks for install.sh, including the failure paths (conflicts, a bad code-structure
# hash, a failed download, restore with no backup). Every case runs in a throwaway HOME.
# Run from anywhere: bash tests/install-smoke.sh   (needs git and network for code-structure)
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
I="$KIT/install.sh"
REC=agentic-framework-kit.installed
ALL="brewedops-app greploop scanloop ship code-structure"
OUT="$(mktemp)"
fail() { echo "FAIL: $*"; echo "--- last installer output ---"; cat "$OUT"; exit 1; }
pass() { echo "ok   $*"; }
new_home() { HOME="$(mktemp -d)"; export HOME; S="$HOME/.agents/skills"; }
inst() { bash "$I" "$@" > "$OUT" 2>&1; }          # run the installer, output kept in $OUT
must_fail() { if inst "$@"; then fail "expected non-zero exit: install.sh $*"; fi; }

# --version prints the VERSION file
[ "$(bash "$I" --version)" = "agentic-framework-kit $(tr -d '[:space:]' < "$KIT/VERSION")" ] || fail "--version"
pass "--version prints VERSION"

# normal run: code-structure hash verified, every skill installed, record lists them
new_home
inst --tool codex || fail "install exited non-zero"
grep -q "ok (hash verified)" "$OUT" || fail "no 'hash verified' message"
for s in $ALL; do [ -f "$S/$s/SKILL.md" ] || fail "missing $s"; done
[ "$(sed -n 's/^skills=//p' "$HOME/.agents/$REC")" = "$ALL" ] || fail "record skills line"
pass "install: hash verified, all skills, record"

# uninstall: no kit skills left, record gone
inst --tool codex --uninstall || fail "uninstall exited non-zero"
for s in $ALL; do [ ! -e "$S/$s" ] || fail "uninstall left $s"; done
[ ! -e "$HOME/.agents/$REC" ] || fail "uninstall left the record"
[ -z "$(ls -A "$S")" ] || fail "skills folder not empty after uninstall"
pass "uninstall removes kit skills and the record"

# install + 4 reruns -> exactly 3 backup sets, none inside the skills folder
new_home
for i in 1 2 3 4 5; do inst --tool codex --no-code-structure || fail "rerun $i"; done
n="$(ls -1 "$HOME/.agents/skills-backup" | wc -l | tr -d ' ')"
[ "$n" = 3 ] || fail "expected 3 backup sets, got $n"
if find "$S" -maxdepth 1 -name "*backup*" | grep -q .; then fail "backup leaked into the skills folder"; fi
pass "4 reruns keep exactly 3 backup sets"

# hash mismatch (test seam): non-zero, no code-structure, kit skills still installed
new_home
KIT_CS_SHA256=deadbeef must_fail --tool codex
grep -q "hash mismatch" "$OUT" || fail "no mismatch message"
[ ! -e "$S/code-structure" ] || fail "code-structure installed despite mismatch"
[ -f "$S/greploop/SKILL.md" ] || fail "kit skills not installed on mismatch"
pass "hash mismatch refused, exit non-zero"

# download failure (unreachable proxy): non-zero, clear message
new_home
https_proxy=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 must_fail --tool codex
grep -q "could not be downloaded" "$OUT" || fail "no download-failure message"
grep -q -- "--no-code-structure" "$OUT" || fail "download failure does not suggest --no-code-structure"
[ ! -e "$S/code-structure" ] || fail "code-structure present after failed download"
pass "download failure exits non-zero"

# conflict: a same-named skill the kit did not install stops everything
new_home
mkdir -p "$S/greploop" && echo "my own greploop" > "$S/greploop/SKILL.md"
must_fail --tool codex --no-code-structure
grep -q "Stopped - nothing was changed" "$OUT" || fail "no conflict message"
[ "$(cat "$S/greploop/SKILL.md")" = "my own greploop" ] || fail "user's skill was touched"
[ ! -e "$S/ship" ] && [ ! -e "$HOME/.agents/$REC" ] || fail "conflict run still changed things"
pass "conflict stops with non-zero, user's skill untouched"

# --force backs it up, then replaces it
inst --tool codex --no-code-structure --force || fail "--force exited non-zero"
grep -q "^name: greploop" "$S/greploop/SKILL.md" || fail "--force did not replace"
grep -rqx "my own greploop" "$HOME/.agents/skills-backup" || fail "--force did not back up the user's skill"
pass "--force backs up and replaces"

# restoring that set gives the user's skill back without the record claiming it
inst --tool codex --restore || fail "--restore after --force"
[ "$(cat "$S/greploop/SKILL.md")" = "my own greploop" ] || fail "--restore did not return the user's skill"
if grep -q "^skills=.*greploop" "$HOME/.agents/$REC"; then fail "record claims the user's greploop"; fi
pass "--restore after --force returns the user's skill, unclaimed"

# --restore brings back the previous set, and a second --restore swaps back
new_home
inst --tool codex --no-code-structure || fail "install"
echo "previous" > "$S/greploop/marker"
inst --tool codex --no-code-structure || fail "rerun"
[ ! -e "$S/greploop/marker" ] || fail "rerun did not replace greploop"
inst --tool codex --restore || fail "--restore exited non-zero"
[ "$(cat "$S/greploop/marker" 2>/dev/null)" = previous ] || fail "--restore did not bring back the previous set"
grep -q "^restored_from=" "$HOME/.agents/$REC" || fail "record not rewritten by --restore"
for s in brewedops-app greploop scanloop ship; do [ -f "$S/$s/SKILL.md" ] || fail "restore lost $s"; done
inst --tool codex --restore || fail "second --restore"
[ ! -e "$S/greploop/marker" ] || fail "second --restore did not swap back"
pass "--restore brings back the previous set (and swaps back)"

# --restore with no backup: non-zero, clear message
new_home
must_fail --tool codex --restore
grep -q "nothing to restore" "$OUT" || fail "no 'nothing to restore' message"
pass "--restore without a backup exits non-zero"

# --skills installs only those
new_home
inst --tool codex --skills greploop,ship --no-code-structure || fail "--skills"
[ -f "$S/greploop/SKILL.md" ] && [ -f "$S/ship/SKILL.md" ] || fail "--skills missed a skill"
[ ! -e "$S/brewedops-app" ] && [ ! -e "$S/scanloop" ] || fail "--skills installed extra skills"
[ "$(sed -n 's/^skills=//p' "$HOME/.agents/$REC")" = "greploop ship" ] || fail "--skills record"
must_fail --tool codex --skills nope
pass "--skills installs only the listed skills"

# --project into a git repo: .agents/skills, record, .git/info/exclude (idempotent), HOME untouched
new_home
P="$(mktemp -d)/my project"; mkdir -p "$P"; git -C "$P" init -q
inst --tool codex,claude --project "$P" --no-code-structure --rules || fail "--project"
[ -f "$P/.agents/skills/greploop/SKILL.md" ] || fail "--project: no .agents/skills"
[ -f "$P/.claude/skills/greploop/SKILL.md" ] || fail "--project: no .claude/skills for claude"
[ -f "$P/.agents/$REC" ] || fail "--project: no record"
[ ! -e "$HOME/.agents" ] && [ ! -e "$HOME/.claude" ] && [ ! -e "$HOME/.codex" ] || fail "--project wrote to HOME"
grep -q "AGENTS.md" "$OUT" || fail "--project: no AGENTS.md hint"
inst --tool codex,claude --project "$P" --no-code-structure || fail "--project rerun"
[ "$(grep -cxF ".agents/skills-backup/" "$P/.git/info/exclude")" = 1 ] || fail "exclude not written once"
[ -d "$P/.agents/skills-backup" ] || fail "--project rerun made no backup"
if git -C "$P" status --porcelain --untracked-files=all | grep -q skills-backup; then fail "backups visible to git"; fi
inst --tool codex,claude --project "$P" --uninstall || fail "--project uninstall"
[ ! -e "$P/.agents/skills/greploop" ] && [ ! -e "$P/.agents/$REC" ] || fail "--project uninstall"
pass "--project installs locally and keeps backups out of git"

rm -f "$OUT"
echo "install.sh: all checks passed"
