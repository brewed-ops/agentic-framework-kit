#!/usr/bin/env bash
# Install, update or remove the BrewedOps Agentic Framework kit for your AI coding tools.
#
#   ./install.sh --tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   ./install.sh --tool claude,cursor         # several at once, or --tool all
#   ./install.sh --tool codex --rules         # also place the global rules starter
#   ./install.sh --tool codex --dry-run       # show what would happen, change nothing
#   ./install.sh --tool codex --uninstall     # remove the kit's skills (kept in a backup folder)
#   ./install.sh --tool codex --no-code-structure
#   ./install.sh --version
#
# Update: git pull, then run the same install command again.
# Safe by default: replaced skills go to <skills folder>-backup/<timestamp>/ (the newest 3 sets are
# kept), and an existing rules file is never overwritten (the template is written next to it).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$KIT/.agents/skills"
VERSION="$(tr -d '[:space:]' < "$KIT/VERSION")"
KEEP_BACKUPS=3
# code-structure is fetched from its author at a PINNED commit and checked against a hash, so a
# change upstream never reaches users without a kit release. Bump all three together.
CS_REPO="https://github.com/michaelshimeles/skills"
CS_COMMIT="4b72f46b045e6fef52e6a98d4c162dd309826aed"
CS_SHA256="2f0ed408b525c65d422699490a159584fd977d0cfca5b15a5c9a47cf07b95f71"

TOOLS="" RULES=0 DRY=0 CODE_STRUCTURE=1 UNINSTALL=0
TS="$(date +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --tool) TOOLS="${2:-}"; shift 2 ;;
    --rules) RULES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-code-structure) CODE_STRUCTURE=0; shift ;;
    --version) echo "agentic-framework-kit $VERSION"; exit 0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 1 ;;
  esac
done
[ -n "$TOOLS" ] || { echo "pass --tool <claude|codex|cursor|gemini|copilot|antigravity|all>"; exit 1; }
[ "$TOOLS" = "all" ] && TOOLS="claude,codex,cursor,gemini,copilot,antigravity"

run() { if [ "$DRY" = 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }

skills_dirs() {
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
manifest_for() { echo "$(dirname "$1")/agentic-framework-kit.installed"; }

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
  while read -r d; do case " $DIRS " in *" $d "*) ;; *) DIRS="$DIRS $d" ;; esac; done < <(skills_dirs "$t")
  f="$(rules_file "$t")"
  [ -n "$f" ] && case " $FILES " in *" $f "*) ;; *) FILES="$FILES $f" ;; esac
done

backup_skill() { # <skills dir> <skill name> <label>
  local bak="$1-backup/$TS$3"
  echo "   $2 -> $bak/"
  run mkdir -p "$bak"
  run mv "$1/$2" "$bak/"
}
prune_backups() { # keep the newest $KEEP_BACKUPS sets
  local root="$1-backup" old
  [ -d "$root" ] || return 0
  old="$(ls -1 "$root" | sort -r | tail -n +$((KEEP_BACKUPS + 1)))"
  for o in $old; do echo "   pruned old backup $root/$o"; run rm -rf "${root:?}/$o"; done
}

# ---- uninstall ---------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  for d in $DIRS; do
    m="$(manifest_for "$d")"
    if [ ! -f "$m" ]; then echo ">> $d: no kit install record - nothing to remove"; continue; fi
    echo ">> Removing kit skills from $d (moved to backup, not deleted)"
    for s in $(sed -n 's/^skills=//p' "$m"); do [ -e "$d/$s" ] && backup_skill "$d" "$s" "-uninstall"; done
    run rm -f "$m"
    prune_backups "$d"
  done
  echo ""
  echo "Your rules files were not touched - remove the framework sections by hand if you want."
  exit 0
fi

# ---- install / update --------------------------------------------------------------------------
CS_TMP=""
if [ "$CODE_STRUCTURE" = 1 ]; then
  echo ">> Fetching code-structure @ ${CS_COMMIT:0:7} from $CS_REPO (pinned; not redistributed here)"
  CS_TMP="$(mktemp -d)"
  if git -C "$CS_TMP" init -q && git -C "$CS_TMP" fetch -q --depth 1 "$CS_REPO" "$CS_COMMIT" 2>/dev/null \
     && git -C "$CS_TMP" checkout -q FETCH_HEAD; then
    got="$( (sha256sum "$CS_TMP/code-structure/SKILL.md" 2>/dev/null || shasum -a 256 "$CS_TMP/code-structure/SKILL.md") | cut -d' ' -f1)"
    if [ "$got" = "$CS_SHA256" ]; then echo "   ok (hash verified)"
    else echo "   !! code-structure hash mismatch - NOT installed (expected $CS_SHA256, got $got)"; CS_TMP=""; fi
  else
    echo "   !! could not fetch code-structure - install it later by hand (see references/setup.md)"
    CS_TMP=""
  fi
fi

for d in $DIRS; do
  m="$(manifest_for "$d")"
  prev="$(sed -n 's/^version=//p' "$m" 2>/dev/null || true)"
  if [ -n "$prev" ]; then echo ">> Skills -> $d (updating $prev -> $VERSION)"; else echo ">> Skills -> $d (installing $VERSION)"; fi
  run mkdir -p "$d"
  names=""
  for s in "$SKILLS_SRC"/*/; do
    n="$(basename "$s")"; names="$names $n"
    [ -e "$d/$n" ] && backup_skill "$d" "$n" ""
    run cp -R "${s%/}" "$d/$n"; echo "   + $n"
  done
  if [ -n "$CS_TMP" ]; then
    names="$names code-structure"
    [ -e "$d/code-structure" ] && backup_skill "$d" "code-structure" ""
    run cp -R "$CS_TMP/code-structure" "$d/code-structure"; echo "   + code-structure"
  fi
  # Keep skills an earlier run installed (e.g. code-structure on a --no-code-structure rerun),
  # so --uninstall still finds them.
  for p in $(sed -n 's/^skills=//p' "$m" 2>/dev/null || true); do
    case " $names " in *" $p "*) ;; *) [ -e "$d/$p" ] && names="$names $p" ;; esac
  done
  if [ "$DRY" = 1 ]; then echo "   [dry-run] write install record $m"
  else printf 'version=%s\nskills=%s\ninstalled=%s\n' "$VERSION" "${names# }" "$TS" > "$m"; fi
  prune_backups "$d"
done

if [ "$RULES" = 1 ]; then
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
  echo "Note: Cursor and Copilot also read ~/.claude/skills, so each skill may appear twice there."
fi
echo ""
echo "Done ($VERSION). Start a new session in your tool, then say \"brewedops app\" in an empty folder."
