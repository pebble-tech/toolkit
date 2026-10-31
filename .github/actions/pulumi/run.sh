#!/usr/bin/env bash
# The pulumi action's step: `pebble-infra <command> <stack> --entries=<module> [--clear-lock] [--summary]`, run from the
# product's own node_modules in its infra directory. Every input arrives as a variable and reaches pebble-infra as one
# argument; none is ever shell text.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The CLI this action wraps is the one the product installed; refuse a major.minor other than the action's own.
node "$here/../installed.mjs" "$INFRA" @pebbletech/infra "$here/../../../packages/infra/package.json" > /dev/null

refuse() {
  echo "pulumi action: $1" >&2
  exit 2
}

case "$COMMAND" in
  up | preview | remove) ;;
  *) refuse "command is up, preview or remove, not \"$COMMAND\"" ;;
esac
case "$STACK" in
  '' | -*) refuse "stack is a stack name, not \"$STACK\"" ;;
esac

args=("$COMMAND" "$STACK" "--entries=$ENTRIES")
flag() {
  case "$2" in
    true) args+=("--$1") ;;
    false) ;;
    *) refuse "$1 is true or false, not \"$2\"" ;;
  esac
}
flag clear-lock "$CLEAR_LOCK"
flag summary "$SUMMARY"

if [ -n "${PULUMI_BACKEND_URL:-}" ]; then
  pulumi login "$PULUMI_BACKEND_URL"
fi
exec pnpm --dir "$INFRA" exec pebble-infra "${args[@]}"
