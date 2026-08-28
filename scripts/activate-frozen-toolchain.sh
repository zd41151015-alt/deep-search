#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)

EXPECTED_NODE=$(tr -d '[:space:]' < "$REPO_ROOT/.node-version")
EXPECTED_NPM="11.16.0"

usage() {
  cat <<EOF
Usage:
  ./scripts/activate-frozen-toolchain.sh npm ci
  ./scripts/activate-frozen-toolchain.sh npm run harness -- doctor --json
  ./scripts/activate-frozen-toolchain.sh npm run harness -- help

Finds Node.js v$EXPECTED_NODE with npm $EXPECTED_NPM before running the command.
Set STARTUP_OPPORTUNITY_NODE24_BIN=/path/to/node/bin when the exact pair is installed outside the usual locations.
EOF
}

candidate_dirs=""
selected_dir=""
node_mismatches=""
npm_mismatches=""

append_line() {
  if [ -z "$1" ]; then
    return
  fi
  if [ -z "$2" ]; then
    printf '%s' "$1"
  else
    printf '%s\n%s' "$2" "$1"
  fi
}

add_candidate_dir() {
  dir=$1
  if [ -z "$dir" ]; then
    return
  fi
  case "
$candidate_dirs
" in
    *"
$dir
"*) ;;
    *) candidate_dirs=$(append_line "$dir" "$candidate_dirs") ;;
  esac
}

add_colon_list() {
  list=$1
  old_ifs=$IFS
  IFS=:
  for dir in $list; do
    add_candidate_dir "$dir"
  done
  IFS=$old_ifs
}

if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

add_candidate_dir "${STARTUP_OPPORTUNITY_NODE24_BIN:-}"
add_colon_list "${STARTUP_OPPORTUNITY_TOOLCHAIN_CANDIDATES:-}"
add_colon_list "${PATH:-}"

if [ "${STARTUP_OPPORTUNITY_TOOLCHAIN_SKIP_DEFAULTS:-}" != "1" ]; then
  add_candidate_dir "/opt/homebrew/opt/node@24/bin"
  add_candidate_dir "/usr/local/opt/node@24/bin"
  add_candidate_dir "$HOME/.nvm/versions/node/v$EXPECTED_NODE/bin"
  add_candidate_dir "$HOME/.volta/tools/image/node/$EXPECTED_NODE/bin"
  add_candidate_dir "$HOME/.asdf/installs/nodejs/$EXPECTED_NODE/bin"
fi

old_ifs=$IFS
IFS='
'
for dir in $candidate_dirs; do
  if [ ! -x "$dir/node" ]; then
    continue
  fi
  node_version=$(PATH="$dir:$PATH" "$dir/node" --version 2>/dev/null || true)
  if [ "$node_version" != "v$EXPECTED_NODE" ]; then
    node_mismatches=$(append_line "  $dir: node ${node_version:-unreadable}" "$node_mismatches")
    continue
  fi
  if [ ! -x "$dir/npm" ]; then
    npm_mismatches=$(append_line "  $dir: node $node_version, npm missing" "$npm_mismatches")
    continue
  fi
  npm_version=$(PATH="$dir:$PATH" "$dir/npm" --version 2>/dev/null || true)
  if [ "$npm_version" = "$EXPECTED_NPM" ]; then
    selected_dir=$dir
    break
  fi
  npm_mismatches=$(append_line "  $dir: node $node_version, npm ${npm_version:-unreadable}" "$npm_mismatches")
done
IFS=$old_ifs

if [ -z "$selected_dir" ]; then
  {
    printf 'startup-opportunity toolchain: expected Node.js v%s with npm %s, but no exact runnable pair was found.\n' "$EXPECTED_NODE" "$EXPECTED_NPM"
    if [ -n "$npm_mismatches" ]; then
      printf 'Node.js v%s candidates with wrong npm:\n%s\n' "$EXPECTED_NODE" "$npm_mismatches"
    fi
    if [ -n "$node_mismatches" ]; then
      printf 'Other Node.js candidates checked:\n%s\n' "$node_mismatches"
    fi
    printf 'Install or activate Node.js %s with npm %s, or set STARTUP_OPPORTUNITY_NODE24_BIN=/path/to/bin and rerun:\n' "$EXPECTED_NODE" "$EXPECTED_NPM"
    printf '  ./scripts/activate-frozen-toolchain.sh npm run harness -- doctor --json\n'
  } >&2
  exit 127
fi

export PATH="$selected_dir:$PATH"

if [ $# -eq 0 ]; then
  printf 'startup-opportunity toolchain active: %s\n' "$selected_dir"
  usage
  exit 0
fi

exec "$@"
