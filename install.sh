#!/usr/bin/env bash
# Install, update, restore or remove the BrewedOps Agentic Framework kit for your AI coding tools.
#
#   ./install.sh --tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   ./install.sh --tool claude,cursor         # several at once, or --tool all
#   ./install.sh --tool codex --rules         # also place the global rules starter
#   ./install.sh --tool codex --dry-run       # show what would happen, change nothing
#   ./install.sh --tool codex --project .     # into this project only (.agents/skills, .claude/skills)
#   ./install.sh --tool codex --skills greploop,ship   # only some of the kit's skills
#   ./install.sh --tool codex --force         # also replace same-named skills the kit did not install
#   ./install.sh --tool codex --restore       # put back the newest backup set
#   ./install.sh --tool codex --uninstall     # remove the kit's skills (kept in a backup folder)
#   ./install.sh --tool codex --no-code-structure
#   ./install.sh --version
#
# Update: git pull, then run the same install command again.
# Safe by default: a skill folder the kit did not install is never replaced without --force;
# replaced skills go to <skills folder>-backup/<timestamp>/ (the newest 3 sets are kept); an
# existing rules file is never overwritten (the template is written next to it).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$KIT/.agents/skills"
VERSION="$(tr -d '[:space:]' < "$KIT/VERSION")"
KEEP_BACKUPS=3
RECORD="agentic-framework-kit.installed"
# code-structure is fetched from its author at a PINNED commit and checked against a hash, so a
# change upstream never reaches users without a kit release. Bump all three together.
CS_REPO="https://github.com/michaelshimeles/skills"
CS_COMMIT="4b72f46b045e6fef52e6a98d4c162dd309826aed"
CS_SHA256="181ee2eab452ed87903b62709ea96ac65a674b5466823c1a107e9a19ebb0d0fa"
# Test seam: KIT_CS_SHA256 overrides the expected hash so CI can prove a mismatch is refused.
# It exists only for tests - never set it for a real install.
CS_SHA256="${KIT_CS_SHA256:-$CS_SHA256}"

TOOLS="" RULES=0 DRY=0 CODE_STRUCTURE=1 MODE=install FORCE=0 PROJECT="" ONLY=""
NL='
'

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
need_value() { if [ $# -lt 2 ] || [ -z "$2" ]; then echo "$1 needs a value (see --help)"; exit 1; fi; }
set_mode() {
  if [ "$MODE" != install ] && [ "$MODE" != "$1" ]; then echo "--uninstall and --restore cannot be combined"; exit 1; fi
  MODE="$1"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --tool) need_value "$@"; TOOLS="$2"; shift 2 ;;
    --project) need_value "$@"; PROJECT="$2"; shift 2 ;;
    --skills) need_value "$@"; ONLY="$2"; shift 2 ;;
    --rules) RULES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) set_mode uninstall; shift ;;
    --restore) set_mode restore; shift ;;
    --no-code-structure) CODE_STRUCTURE=0; shift ;;
    --version) echo "agentic-framework-kit $VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 1 ;;
  esac
done
[ -n "$TOOLS" ] || { echo "pass --tool <claude|codex|cursor|gemini|copilot|antigravity|all>"; exit 1; }
[ "$TOOLS" = "all" ] && TOOLS="claude,codex,cursor,gemini,copilot,antigravity"
if [ -n "$PROJECT" ]; then
  [ -d "$PROJECT" ] || { echo "--project: $PROJECT is not a folder"; exit 1; }
  PROJECT="$(cd "$PROJECT" && pwd)"
fi

run() { if [ "$DRY" = 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }   # <word> <space-separated list>

skills_dirs() {
  if [ -n "$PROJECT" ]; then   # project mode: Claude Code reads .claude/skills, the others .agents/skills
    case "$1" in claude) echo "$PROJECT/.claude/skills" ;; *) echo "$PROJECT/.agents/skills" ;; esac
    return 0
  fi
  case "$1" in
    claude) echo "$HOME/.claude/skills" ;;
    codex|cursor|gemini|copilot) echo "$HOME/.agents/skills" ;;
    antigravity) echo "$HOME/.gemini/config/skills"; echo "$HOME/.gemini/antigravity-cli/skills" ;;
  esac
}
rules_file() {
  case "$1" in
    claude) echo "$HOME/.claude/CLAUDE.md" ;;
    codex) echo "$HOME/.codex/AGENTS.md" ;;
    gemini|antigravity) echo "$HOME/.gemini/GEMINI.md" ;;   # one file, read by both
    copilot) echo "$HOME/.copilot/copilot-instructions.md" ;;
    cursor) echo "" ;;                                       # Cursor keeps rules in its settings UI
  esac
}
# The install record sits NEXT TO the skills folder, never inside it.
manifest_for() { echo "$(dirname "$1")/$RECORD"; }
rec_skills() { sed -n 's/^skills=//p' "$1" 2>/dev/null || true; }
rec_version() { sed -n 's/^version=//p' "$1" 2>/dev/null || true; }
write_record() { # <record> <version> <skills> [extra line]; no skills left = no record
  if [ -z "$3" ]; then run rm -f "$1"; return 0; fi
  if [ "$DRY" = 1 ]; then echo "   [dry-run] write install record $1"; return 0; fi
  printf 'version=%s\nskills=%s\ninstalled=%s\n' "$2" "$3" "$TS" > "$1"
  if [ -n "${4:-}" ]; then echo "$4" >> "$1"; fi
}

# Skills folders to touch, one per line (paths may contain spaces).
DIRS="" FILES="" HAS_CLAUDE=0 HAS_SHARED_READER=0
IFS=',' read -r -a LIST <<< "$TOOLS"
for t in "${LIST[@]}"; do
  case "$t" in claude|codex|cursor|gemini|copilot|antigravity) ;;
    *) echo "unknown tool: $t (choose claude, codex, cursor, gemini, copilot, antigravity or all)"; exit 1 ;;
  esac
done
for t in "${LIST[@]}"; do
  [ "$t" = claude ] && HAS_CLAUDE=1
  { [ "$t" = cursor ] || [ "$t" = copilot ]; } && HAS_SHARED_READER=1
  while read -r d; do case "$NL$DIRS$NL" in *"$NL$d$NL"*) ;; *) DIRS="$DIRS$d$NL" ;; esac; done < <(skills_dirs "$t")
  f="$(rules_file "$t")"
  [ -n "$f" ] && case " $FILES " in *" $f "*) ;; *) FILES="$FILES $f" ;; esac
done

# Which of the kit's own skills this run handles (--skills), in the kit's order.
KIT_SKILLS=""
for s in "$SKILLS_SRC"/*/; do KIT_SKILLS="$KIT_SKILLS $(basename "$s")"; done
KIT_SKILLS="${KIT_SKILLS# }"
SEL="$KIT_SKILLS"
if [ -n "$ONLY" ]; then
  [ "$MODE" = restore ] && { echo "--skills does not apply to --restore (a restore puts back the whole backup set)"; exit 1; }
  WANT=" $(echo "$ONLY" | tr ',' ' ') "
  for s in $WANT; do
    [ "$s" = code-structure ] && { echo "--skills: code-structure is controlled by --no-code-structure"; exit 1; }
    in_list "$s" "$KIT_SKILLS" || { echo "unknown skill: $s (choose from: ${KIT_SKILLS// /, })"; exit 1; }
  done
  SEL=""
  for s in $KIT_SKILLS; do if in_list "$s" "$WANT"; then SEL="$SEL $s"; fi; done
  SEL="${SEL# }"
fi

# Backup sets are named by the second. If a set from this second already exists (scripted
# back-to-back runs), wait for the next second so set names stay unique and in order.
TS="$(date +%Y%m%d-%H%M%S)"
ts_taken() {
  local d x
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    for x in "$d-backup/$TS"*; do if [ -e "$x" ]; then return 0; fi; done
  done <<< "$DIRS"
  return 1
}
while ts_taken; do sleep 1; TS="$(date +%Y%m%d-%H%M%S)"; done

BAK=""   # the backup set for the skills folder being processed
backup_skill() { # <skills dir> <skill name>: move it into $BAK, with a copy of the record it replaces
  echo "   $2 -> $BAK/"
  if [ ! -d "$BAK" ]; then
    run mkdir -p "$BAK"
    if [ -f "$(manifest_for "$1")" ]; then run cp "$(manifest_for "$1")" "$BAK/"; fi
  fi
  run mv "$1/$2" "$BAK/"
}
backup_sets() { # <skills dir>: backup set names, newest first
  if [ -d "$1-backup" ]; then ls -1 "$1-backup" | LC_ALL=C sort -r; fi
}
prune_backups() { # keep the newest $KEEP_BACKUPS sets
  local root="$1-backup" o
  for o in $(backup_sets "$1" | tail -n +$((KEEP_BACKUPS + 1))); do
    echo "   pruned old backup $root/$o"; run rm -rf "${root:?}/$o"
  done
}
set_skills() { # <backup set dir>: the skill folders in it
  local x
  for x in "$1"/*/; do if [ -d "$x" ]; then basename "$x"; fi; done
}

CONFLICTS=""
stop_on_conflicts() {
  [ -n "$CONFLICTS" ] || return 0
  if [ "$FORCE" = 1 ]; then
    echo ">> --force: these skill folders were not installed by this kit; backing them up, then replacing:"
    printf '%s' "$CONFLICTS" | while IFS= read -r c; do if [ -n "$c" ]; then echo "   $c"; fi; done
    return 0
  fi
  echo "!! Stopped - nothing was changed. These skill folders exist but this kit did not install them"
  echo "   (your own skill, or another package's, with the same name):"
  printf '%s' "$CONFLICTS" | while IFS= read -r c; do if [ -n "$c" ]; then echo "   $c"; fi; done
  echo "   Rerun with --force to back them up (to <skills folder>-backup/) and replace them, or use"
  echo "   --skills / --no-code-structure to leave them alone. (Installed by kit 1.0.0, which kept no"
  echo "   install record? Then --force is safe.)"
  exit 1
}

# In a git project, keep the backup folders out of commits (local-only, never touches .gitignore).
exclude_backups() {
  local ex="" pat added=""
  if command -v git >/dev/null 2>&1 && ex="$(git -C "$PROJECT" rev-parse --git-path info/exclude 2>/dev/null)"; then
    case "$ex" in /*|?:*) ;; *) ex="$PROJECT/$ex" ;; esac
  elif [ -d "$PROJECT/.git" ]; then ex="$PROJECT/.git/info/exclude"
  else return 0; fi
  for pat in .agents/skills-backup/ .claude/skills-backup/; do
    if [ -f "$ex" ] && grep -qxF "$pat" "$ex"; then continue; fi
    added="$added $pat"
    if [ "$DRY" = 1 ]; then continue; fi
    mkdir -p "$(dirname "$ex")"
    if [ -s "$ex" ] && [ -n "$(tail -c 1 "$ex")" ]; then echo >> "$ex"; fi
    echo "$pat" >> "$ex"
  done
  if [ -n "$added" ]; then
    if [ "$DRY" = 1 ]; then echo ">> [dry-run] would add${added} to $ex"
    else echo ">> Backups kept out of git: added${added} to $ex"; fi
  fi
}
project_notes() {
  [ -n "$PROJECT" ] || return 0
  exclude_backups
  echo ""
  echo "Project install: this project's rules file is its AGENTS.md (the brewedops-app skill can write"
  echo "it). No global rules file was touched. Commit .agents/skills (and .claude/skills) plus the"
  echo "$RECORD file next to them if teammates should get the skills too."
}

# ---- uninstall ---------------------------------------------------------------------------------
if [ "$MODE" = uninstall ]; then
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    m="$(manifest_for "$d")"
    if [ ! -f "$m" ]; then echo ">> $d: no kit install record - nothing to remove"; continue; fi
    echo ">> Removing kit skills from $d (moved to backup, not deleted)"
    BAK="$d-backup/$TS-uninstall" keep=""
    for s in $(rec_skills "$m"); do
      if [ -n "$ONLY" ] && ! in_list "$s" "$SEL"; then keep="$keep $s"; continue; fi
      if [ -e "$d/$s" ]; then backup_skill "$d" "$s"; fi
    done
    write_record "$m" "$(rec_version "$m")" "${keep# }"
    prune_backups "$d"
  done <<< "$DIRS"
  project_notes
  echo ""
  echo "Your rules files were not touched - remove the framework sections by hand if you want."
  exit 0
fi

# ---- restore -----------------------------------------------------------------------------------
if [ "$MODE" = restore ]; then
  MISSING=0
  while IFS= read -r d; do   # check every folder before changing any
    [ -n "$d" ] || continue
    t="$(backup_sets "$d" | sed -n 1p)"
    if [ -z "$t" ]; then echo "!! $d: no backup set in $d-backup - nothing to restore"; MISSING=1; continue; fi
    cur="$(rec_skills "$(manifest_for "$d")")"
    for s in $(set_skills "$d-backup/$t"); do
      if [ -e "$d/$s" ] && ! in_list "$s" "$cur"; then CONFLICTS="$CONFLICTS$d/$s$NL"; fi
    done
  done <<< "$DIRS"
  stop_on_conflicts
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    t="$(backup_sets "$d" | sed -n 1p)"
    [ -n "$t" ] || continue
    src="$d-backup/$t" m="$(manifest_for "$d")"
    cur="$(rec_skills "$m")" inset=" $(set_skills "$src" | tr '\n' ' ')"
    old="" old_ver="$(rec_version "$m")" owned=""
    if [ -f "$src/$RECORD" ]; then old="$(rec_skills "$src/$RECORD")"; old_ver="$(rec_version "$src/$RECORD")"; fi
    # Only skills the set's own record lists were the kit's; anything else in it (a folder
    # --force moved aside) is restored but not claimed, so --uninstall never takes it.
    for s in $inset; do if in_list "$s" "$old"; then owned="$owned $s"; fi; done
    echo ">> Restoring $d from backup set $src"
    BAK="$d-backup/$TS-restore" keep="" moved=""
    # Out go the kit skills this set replaces, and any the set's own record did not have yet.
    for s in $cur; do
      if in_list "$s" "$inset" || { [ -f "$src/$RECORD" ] && ! in_list "$s" "$old"; }; then
        if [ -e "$d/$s" ]; then backup_skill "$d" "$s"; moved="$moved $s"; fi
      elif [ -e "$d/$s" ]; then keep="$keep $s"; fi
    done
    for s in $inset; do
      if [ -e "$d/$s" ] && ! in_list "$s" "$moved"; then backup_skill "$d" "$s"; fi   # --force only
      run cp -R "$src/$s" "$d/$s"; echo "   + $s"
    done
    write_record "$m" "${old_ver:-$VERSION}" "$(echo $keep $owned)" "restored_from=$t"
    prune_backups "$d"
  done <<< "$DIRS"
  project_notes
  if [ "$MISSING" = 1 ]; then echo ""; echo "!! Nothing to restore for the folders above (no backup set yet)."; exit 1; fi
  echo ""
  echo "Restored. The skills that were there before are in the newest -restore backup set;"
  echo "run --restore again to swap back."
  exit 0
fi

# ---- install / update --------------------------------------------------------------------------
NAMES="$SEL"
[ "$CODE_STRUCTURE" = 1 ] && NAMES="$NAMES code-structure"
while IFS= read -r d; do   # conflict check for every folder before changing any
  [ -n "$d" ] || continue
  cur="$(rec_skills "$(manifest_for "$d")")"
  for n in $NAMES; do
    if [ -e "$d/$n" ] && ! in_list "$n" "$cur"; then CONFLICTS="$CONFLICTS$d/$n$NL"; fi
  done
done <<< "$DIRS"
stop_on_conflicts

CS_TMP="" CS_FAIL=""
if [ "$CODE_STRUCTURE" = 1 ]; then
  echo ">> Fetching code-structure @ ${CS_COMMIT:0:7} from $CS_REPO (pinned; not redistributed here)"
  tmp="$(mktemp -d)"
  if command -v git >/dev/null 2>&1 && git -C "$tmp" init -q \
     && git -C "$tmp" fetch -q --depth 1 "$CS_REPO" "$CS_COMMIT" 2>/dev/null \
     && git -C "$tmp" -c core.autocrlf=false -c core.eol=lf checkout -q FETCH_HEAD 2>/dev/null && [ -f "$tmp/code-structure/SKILL.md" ]; then
    got="$( (sha256sum "$tmp/code-structure/SKILL.md" 2>/dev/null || shasum -a 256 "$tmp/code-structure/SKILL.md") | cut -d' ' -f1)" || got=""
    if [ "$got" = "$CS_SHA256" ]; then echo "   ok (hash verified)"; CS_TMP="$tmp"
    else echo "   !! code-structure hash mismatch - NOT installed (expected $CS_SHA256, got $got)"; CS_FAIL="hash"; fi
  else
    echo "   !! could not fetch code-structure - NOT installed"; CS_FAIL="fetch"
  fi
  [ -n "$CS_TMP" ] || rm -rf "$tmp"
fi

while IFS= read -r d; do
  [ -n "$d" ] || continue
  m="$(manifest_for "$d")"
  prev="$(rec_version "$m")" cur="$(rec_skills "$m")"
  if [ -n "$prev" ]; then echo ">> Skills -> $d (updating $prev -> $VERSION)"; else echo ">> Skills -> $d (installing $VERSION)"; fi
  run mkdir -p "$d"
  BAK="$d-backup/$TS" names=""
  for n in $SEL; do
    if [ -e "$d/$n" ]; then backup_skill "$d" "$n"; fi
    run cp -R "$SKILLS_SRC/$n" "$d/$n"; echo "   + $n"; names="$names $n"
  done
  if [ -n "$CS_TMP" ]; then
    if [ -e "$d/code-structure" ]; then backup_skill "$d" "code-structure"; fi
    run cp -R "$CS_TMP/code-structure" "$d/code-structure"; echo "   + code-structure"; names="$names code-structure"
  fi
  # Keep skills an earlier run installed and this one left alone (e.g. code-structure on a
  # --no-code-structure rerun, or the rest on a --skills rerun), so --uninstall still finds them.
  for p in $cur; do
    if ! in_list "$p" "$names" && [ -e "$d/$p" ]; then names="$names $p"; fi
  done
  write_record "$m" "$VERSION" "${names# }"
  prune_backups "$d"
done <<< "$DIRS"

if [ -n "$PROJECT" ]; then
  project_notes
  if [ "$RULES" = 1 ]; then echo "(--rules is for the global rules files; it does nothing with --project.)"; fi
elif [ "$RULES" = 1 ]; then
  for f in $FILES; do
    if [ -s "$f" ] && grep -q "agentic-framework-kit: global rules" "$f"; then
      echo ">> Rules: $f already has the framework rules - left alone"
    elif [ -s "$f" ]; then
      echo ">> Rules: $f exists - NOT overwritten. Template written to $f.framework-template.md;"
      echo "   ask your AI to merge the sections you are missing."
      run cp "$SKILLS_SRC/brewedops-app/references/global-rules.md" "$f.framework-template.md"
    else
      echo ">> Rules: $f created from the starter template - fill in the <ANGLE BRACKET> parts"
      run mkdir -p "$(dirname "$f")"
      run cp "$SKILLS_SRC/brewedops-app/references/global-rules.md" "$f"
    fi
  done
  case ",$TOOLS," in *,cursor,*) echo ">> Rules (Cursor): paste .agents/skills/brewedops-app/references/global-rules.md into Settings > Rules > User Rules" ;; esac
fi

[ -n "$CS_TMP" ] && rm -rf "$CS_TMP"

if [ "$HAS_CLAUDE" = 1 ] && [ "$HAS_SHARED_READER" = 1 ]; then
  echo ""
  echo "Note: Cursor and Copilot also read the Claude Code skills folder, so each skill may appear twice there."
fi
echo ""
if [ "$CS_FAIL" = hash ]; then
  echo "!! The kit's skills are installed, but code-structure is NOT: the download did not match the"
  echo "   pinned SHA-256, so it was refused. Please report it; to skip it, rerun with --no-code-structure."
  exit 1
elif [ "$CS_FAIL" = fetch ]; then
  echo "!! The kit's skills are installed, but code-structure is NOT: it could not be downloaded"
  echo "   (network, or git missing). Retry the same command, or install with --no-code-structure."
  exit 1
fi
echo "Done ($VERSION). Start a new session in your tool, then say \"brewedops app\" in an empty folder."
