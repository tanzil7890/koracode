#!/usr/bin/env bash
# check-upstream.sh — report drift from each upstream recorded in UPSTREAM.md.
#
# Reads the latest `To SHA` from each sync-log table in UPSTREAM.md and runs
# `git log <recorded-sha>..<remote-head>` against the matching remote to count
# unmerged commits.
#
# Usage: script/check-upstream.sh
# Exits 0 regardless of drift — this is informational, not a gate.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
UPSTREAM_FILE="$REPO_ROOT/UPSTREAM.md"

if [[ ! -f "$UPSTREAM_FILE" ]]; then
  echo "error: $UPSTREAM_FILE not found" >&2
  exit 1
fi

# Parse the latest `To SHA` under each section header.
# Section anchors are the exact "### " lines in UPSTREAM.md.
last_sha_after() {
  local anchor="$1"
  awk -v anchor="$anchor" '
    $0 ~ "^### " anchor { in_section = 1; next }
    in_section && /^### / { in_section = 0 }
    in_section && /^\| [0-9]{4}-[0-9]{2}-[0-9]{2} \|/ {
      # Columns: | Date | From SHA | To SHA | By | Notes |
      n = split($0, cols, "|")
      # cols[1] is empty (leading |); Date=cols[2], From=cols[3], To=cols[4]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", cols[4])
      # Skip placeholder dashes
      if (cols[4] != "—" && cols[4] != "-" && cols[4] != "") last = cols[4]
    }
    END { if (last) print last }
  ' "$UPSTREAM_FILE"
}

report_drift() {
  local label="$1"
  local remote="$2"
  local remote_branch="$3"
  local recorded_sha="$4"

  echo "=== $label ==="

  if [[ -z "$recorded_sha" ]]; then
    echo "  no sync recorded yet (nothing to compare against)"
    echo
    return
  fi

  if ! git remote | grep -qx "$remote"; then
    echo "  warning: remote '$remote' not configured. Add it to see drift:"
    echo "    git remote add $remote <url>"
    echo
    return
  fi

  # Strip backticks if present in the markdown cell.
  recorded_sha="${recorded_sha//\`/}"

  git fetch --quiet "$remote" "$remote_branch" 2>/dev/null || {
    echo "  warning: could not fetch $remote/$remote_branch"
    echo
    return
  }

  local remote_head
  remote_head="$(git rev-parse "$remote/$remote_branch")"

  local behind
  behind="$(git rev-list --count "$recorded_sha..$remote_head" 2>/dev/null || echo "?")"

  echo "  recorded:    $recorded_sha"
  echo "  remote HEAD: $remote_head ($remote/$remote_branch)"
  if [[ "$behind" == "0" ]]; then
    echo "  status:      up to date"
  else
    echo "  status:      $behind commits behind — review with:"
    echo "               git log --oneline $recorded_sha..$remote/$remote_branch"
  fi
  echo
}

opencode_sha="$(last_sha_after 'anomalyco/opencode → this repo')"

report_drift "anomalyco/opencode" "upstream" "dev" "$opencode_sha"

echo "Source of truth: UPSTREAM.md. Append a row when you pull."
