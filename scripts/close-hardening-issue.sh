#!/usr/bin/env bash
# close-hardening-issue.sh <issue-number> <test-pattern>
#
# Helper that ties a GH issue close to actual test evidence, per the
# "Test discipline for security and bug fixes" rule in CLAUDE.md.
#
# Usage:
#   scripts/close-hardening-issue.sh 4 "visualColumnWidth"
#
# Behaviour:
#   1. Runs jest filtered to <test-pattern> against the v*-hardening files.
#   2. If green, posts a comment on issue <issue-number> with the test output
#      and closes the issue.
#   3. If red, leaves the issue open and prints the failing tests so the
#      operator knows the fix isn't proven yet.
#
# Requires: gh, npx, jest config at jest.config.cjs.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <issue-number> <test-pattern>" >&2
  exit 2
fi

ISSUE_NUMBER="$1"
TEST_PATTERN="$2"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

echo "[close-hardening-issue] Running tests matching: $TEST_PATTERN" >&2
if ! npx jest --config jest.config.cjs \
       --testPathPatterns "v[0-9]+\\.[0-9]+-hardening" \
       --testNamePattern "$TEST_PATTERN" \
       --runInBand \
       > "$OUT" 2>&1; then
  echo
  echo "Tests are RED — issue stays open. Last 30 lines:"
  tail -30 "$OUT"
  exit 1
fi

# Trim to the summary lines so the comment stays focused.
SUMMARY="$(tail -8 "$OUT" | sed 's/^/  /')"

BODY=$(cat <<EOF
Closing — fix is covered by passing hardening tests.

Test pattern: \`$TEST_PATTERN\`

\`\`\`
$SUMMARY
\`\`\`

Re-run locally: \`scripts/close-hardening-issue.sh $ISSUE_NUMBER "$TEST_PATTERN"\`.
The test file is the canonical proof; if it ever fails on main the
\`hardening\` CI workflow surfaces it before the next release.
EOF
)

gh issue comment "$ISSUE_NUMBER" --body "$BODY"
gh issue close "$ISSUE_NUMBER"
echo "[close-hardening-issue] Issue #$ISSUE_NUMBER commented + closed."
