#!/usr/bin/env bash
# Sourced by scripts that record workspace state or check the config. They ask
# the pappardelle binary to do it, so the state files and the database have one
# writer and the config has one validator.

_STATE_CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# pappardelle_state <verb> [args...]
# Looks for the binary the way start-agent-session.sh finds the status
# monitor, then falls back to the sources for a checkout with no build.
pappardelle_state() {
    local bun="${LASAGNA_BUN:-$(command -v bun || true)}"
    if [[ -x "${LASAGNA_EXECUTABLE:-}" ]]; then
        "$LASAGNA_EXECUTABLE" --internal-state "$@"
    elif [[ -x "$_STATE_CLI_DIR/../dist/lasagna" ]]; then
        "$_STATE_CLI_DIR/../dist/lasagna" --internal-state "$@"
    elif [[ -x "$bun" && -f "$_STATE_CLI_DIR/../source/state-cli.ts" ]]; then
        "$bun" --no-env-file --config=/dev/null "$_STATE_CLI_DIR/../source/state-cli.ts" "$@"
    else
        echo "lasagna: no binary or Bun found to run lasagna --internal-state $1" >&2
        return 127
    fi
}
