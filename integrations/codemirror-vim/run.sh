#!/usr/bin/env bash
# Run the vim-unit suite against @replit/codemirror-vim (CodeMirror 6's vim
# mode) in headless Chromium. See README.md.
#
#   integrations/codemirror-vim/run.sh [export args, e.g. -l 0-3 or -k REGEX]
#
# Writes out/results-codemirror-vim.jsonl and out/report-codemirror-vim.txt
# in the vim-unit repository.
set -euo pipefail

NAME=codemirror-vim
REPO_URL=https://github.com/replit/codemirror-vim.git
# Head of master on 2026-11-02: "fix: a q that is another key's argument does
# not end macro recording (#282)".
COMMIT=c3131c442069cbe762c7d3c78295b2d98e853bc6

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIMUNIT="$(cd "$HERE/../.." && pwd)"
SRC="${VIMUNIT_SRC:-$HOME/src/vimunit-integrations}/$NAME"
OUT="$VIMUNIT/out"

need() { command -v "$1" >/dev/null 2>&1 || { echo "run.sh: '$1' is required" >&2; exit 1; }; }
need git
need node
need npm
need pnpm
need python3

# 1. The editor's source, at the pinned commit.
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone "$REPO_URL" "$SRC"
fi
cd "$SRC"
if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch origin
  git checkout --quiet --detach "$COMMIT"
fi

# 2. Its dependencies, from its lockfile. No lifecycle scripts are needed: the
#    adapter bundles the plugin from source, so the packages' own builds
#    (`prepare`) don't have to run.
pnpm install --frozen-lockfile --ignore-scripts --reporter=silent

# 3. The adapter: page.ts is bundled with the plugin's sources by the
#    workspace's own vite; the driver (Playwright) lives in its own directory.
mkdir -p packages/codemirror-vim/vimunit vimunit-driver
cp "$HERE/adapter/page.ts" "$HERE/adapter/vite.config.mjs" packages/codemirror-vim/vimunit/
cp "$HERE/adapter/driver.mjs" "$HERE/adapter/package.json" "$HERE/adapter/package-lock.json" vimunit-driver/
(cd vimunit-driver && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
# Downloads Chromium (headless shell) for this Playwright version, unless it's
# already in Playwright's cache.
(cd vimunit-driver && ./node_modules/.bin/playwright install chromium-headless-shell)

(cd packages/codemirror-vim && ./node_modules/.bin/vite build --config vimunit/vite.config.mjs)
cp "$HERE/adapter/index.html" packages/codemirror-vim/vimunit/dist/

# 4. Export the suite, run it, and score it.
mkdir -p "$OUT"
TESTS="$SRC/vimunit-driver/tests.json"
RESULTS="$OUT/results-$NAME.jsonl"
REPORT="$OUT/report-$NAME.txt"
"$VIMUNIT/vimunit" export --ignore-errors -o "$TESTS" "$@"
node vimunit-driver/driver.mjs --tests "$TESTS" \
  --page packages/codemirror-vim/vimunit/dist/index.html --out "$RESULTS"
"$VIMUNIT/vimunit" report --ignore-errors --results "$RESULTS" --name "$NAME" -v "$@" > "$REPORT"
# The summary table is at the end of the report, after the failures.
sed -n '/^== /,$p' "$REPORT"
echo "results: $RESULTS"
echo "report:  $REPORT"
