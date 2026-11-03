#!/usr/bin/env bash
# Runs the vim-unit suite against VSCodeVim (https://github.com/VSCodeVim/Vim).
# See README.md. Extra arguments are passed to `./vimunit export` and
# `./vimunit report`, e.g. `./run.sh -l 0-3` or `./run.sh level2/visual.vimunit`.
set -euo pipefail

NAME=vscodevim
REPO_URL=https://github.com/VSCodeVim/Vim.git
# Head of master on 2026-11-02 (committed 2026-10-03, "Simplify cursor swapping in `executeMovement`").
COMMIT=28f027545526363b1c0c577b71a3e175c3285123

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIMUNIT_DIR="$(cd "$HERE/../.." && pwd)"
SRC="${VIMUNIT_SRC:-$HOME/src/vimunit-integrations}/$NAME"
OUT="$VIMUNIT_DIR/out"
WORK="$SRC/.vimunit"   # export and VS Code log; inside the checkout, ignored by git

for tool in git node; do
  command -v "$tool" >/dev/null || { echo "run.sh: $tool is required" >&2; exit 1; }
done
if command -v yarn >/dev/null && [[ "$(yarn --version)" == 1.* ]]; then
  YARN=(yarn)
else
  YARN=(npx --yes yarn@1.22.22)
fi

# 1. Check out VSCodeVim at the pinned commit.
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone "$REPO_URL" "$SRC"
fi
cd "$SRC"
if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch origin
  git checkout --quiet --detach "$COMMIT"
fi
grep -qx '/.vimunit/' .git/info/exclude 2>/dev/null || echo '/.vimunit/' >> .git/info/exclude
grep -qx '/test/vimunit/' .git/info/exclude 2>/dev/null || echo '/test/vimunit/' >> .git/info/exclude

# 2. Dependencies (no install scripts are needed to build and test).
if [ "$(cat node_modules/.vimunit-stamp 2>/dev/null)" != "$COMMIT" ]; then
  "${YARN[@]}" install --frozen-lockfile --ignore-scripts --network-concurrency 4
  echo "$COMMIT" > node_modules/.vimunit-stamp
fi

# 3. Add the adapter to VSCodeVim's tests and build them (tsc into out/, as `yarn build-test` does).
rm -rf test/vimunit out
mkdir -p test/vimunit
cp "$HERE"/adapter/*.ts test/vimunit/
npx gulp prepare-test

# 4. Export the suite and run it in VS Code.
mkdir -p "$WORK" "$OUT"
"$VIMUNIT_DIR/vimunit" export --ignore-errors -o "$WORK/tests.json" "$@"
node out/test/vimunit/runVimunit.js "$WORK/tests.json" "$OUT/results-$NAME.jsonl" "$WORK/vscode.log"

# 5. Score it.
"$VIMUNIT_DIR/vimunit" report --ignore-errors --results "$OUT/results-$NAME.jsonl" \
  --name "VSCodeVim ${COMMIT:0:10}" "$@" | tee "$OUT/report-$NAME.txt"
echo "Failures in detail: $VIMUNIT_DIR/vimunit report --ignore-errors --results $OUT/results-$NAME.jsonl -v"
