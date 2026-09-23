#!/usr/bin/env bash
# Install the BrewedOps Agentic Framework kit for one or more AI coding tools.
#
#   ./install.sh --tool codex                 # claude | codex | cursor | gemini | copilot | antigravity
#   ./install.sh --tool claude,cursor         # several at once
#   ./install.sh --tool all
#   ./install.sh --tool codex --rules         # also place the global rules starter
#   ./install.sh --tool codex --dry-run       # show what would happen, change nothing
#   ./install.sh --tool codex --no-code-structure
#
# Safe by default: an existing skill folder is moved to <skills folder>-backup/<timestamp>/ before it is
# replaced, and an existing rules file is never overwritten (the template is written next to it).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$KIT/.agents/skills"
TOOLS="" RULES=0 DRY=0 CODE_STRUCTURE=1
TS="$(date +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --tool) TOOLS="${2:-}"; shift 2 ;;
    --rules) RULES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-code-structure) CODE_STRUCTURE=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
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
    *) echo "unknown tool: $1" >&2; exit 1 ;;
  esac
}
rules_file() {
  case "$1" in
    claude) echo "$HOME/.claude/CLAUDE.md" ;;
    codex) echo "$HOME/.codex/AGENTS.md" ;;
    gemini) echo "$HOME/.gemini/GEMINI.md" ;;
    antigravity) echo "$HOME/.gemini/GEMINI.md" ;;  # shared with Gemini CLI - one file, read by both
    copilot) echo "$HOME/.copilot/copilot-instructions.md" ;;
    cursor) echo "" ;;
  esac
}

# Collect unique skills folders and rules files across the chosen tools.
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

CS_TMP=""
if [ "$CODE_STRUCTURE" = 1 ]; then
  echo ">> Fetching code-structure from github.com/michaelshimeles/skills (not redistributed here)"
  CS_TMP="$(mktemp -d)"
  if git clone -q --depth 1 https://github.com/michaelshimeles/skills "$CS_TMP/ms" 2>/dev/null \
     && [ -f "$CS_TMP/ms/code-structure/SKILL.md" ]; then
    echo "   ok"
  else
    echo "   !! could not fetch code-structure - install it later by hand (see references/setup.md)"
    CS_TMP=""
  fi
fi

install_skill() { # <source dir> <target skills dir>
  # Backups go in a SIBLING folder: a copy left inside the skills folder would be discovered
  # by the tool as a second skill with the same name.
  local src="$1" dest="$2/$(basename "$1")" bak="$2-backup/$TS"
  if [ -e "$dest" ]; then
    echo "   existing $(basename "$src") -> backed up to $bak/"
    run mkdir -p "$bak"
    run mv "$dest" "$bak/"
  fi
  run cp -R "$src" "$dest"
}

for d in $DIRS; do
  echo ">> Skills -> $d"
  run mkdir -p "$d"
  for s in "$SKILLS_SRC"/*/; do install_skill "${s%/}" "$d"; echo "   + $(basename "$s")"; done
  if [ -n "$CS_TMP" ]; then install_skill "$CS_TMP/ms/code-structure" "$d"; echo "   + code-structure"; fi
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
echo "Done. Next: open a project in your AI tool and say \"brewedops app\" to set one up,"
echo "or read AGENTS.md in this kit for what each skill does."
