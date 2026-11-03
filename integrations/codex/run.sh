#!/usr/bin/env bash
# Run the vim-unit suite against the Vim mode of the OpenAI Codex CLI's composer
# (codex-rs/tui). See README.md.
#
#   integrations/codex/run.sh [export args, e.g. -l 0-3 or -k REGEX]
#
# Writes out/tests-codex.json, out/results-codex.jsonl and out/report-codex.txt
# in the vim-unit repository. Set CARGO_JOBS to change build parallelism
# (default 4).
set -euo pipefail

NAME=codex
REPO_URL=https://github.com/openai/codex.git
# Head of main on 2026-11-02: "Preserve modified Ctrl+C keys in active TUI views
# (#58990)".
COMMIT=23bc6e5f2a5af241e82f0ef18bd7418acb41837e
# The adapter runs as an ignored unit test inside the codex-tui crate.
TEST=bottom_pane::chat_composer::vimunit_adapter::vimunit_adapter

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIMUNIT="$(cd "$HERE/../.." && pwd)"
SRC="${VIMUNIT_SRC:-$HOME/src/vimunit-integrations}/$NAME"
OUT="$VIMUNIT/out"

need() { command -v "$1" >/dev/null 2>&1 || { echo "run.sh: '$1' is required" >&2; exit 1; }; }
need git
need python3
need rustup
need cargo
need cmake

# 1. The editor's source, at the pinned commit. (A blobless clone: the full
#    history is large.)
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone --filter=blob:none "$REPO_URL" "$SRC"
fi
cd "$SRC"
if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch origin
  # --force discards a previously applied adapter.patch.
  git checkout --quiet --force --detach "$COMMIT"
fi

# 2. The adapter: a module declaration (adapter.patch) and the module itself.
if git apply --reverse --check "$HERE/adapter.patch" 2>/dev/null; then
  : # already applied
else
  git apply "$HERE/adapter.patch"
fi
cp "$HERE/adapter/vimunit_adapter.rs" codex-rs/tui/src/bottom_pane/chat_composer/

# 3. The Rust toolchain that codex-rs/rust-toolchain.toml pins.
cd codex-rs
TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
rustup run "$TOOLCHAIN" rustc --version >/dev/null 2>&1 \
  || rustup toolchain install "$TOOLCHAIN" --profile minimal

# 4. Export the suite, build and run the adapter, and score the results.
mkdir -p "$OUT"
TESTS="$OUT/tests-$NAME.json"
RESULTS="$OUT/results-$NAME.jsonl"
REPORT="$OUT/report-$NAME.txt"
"$VIMUNIT/vimunit" export --ignore-errors -o "$TESTS" "$@"
rm -f "$RESULTS"
VIMUNIT_TESTS="$TESTS" VIMUNIT_RESULTS="$RESULTS" \
  cargo test -j "${CARGO_JOBS:-4}" -p codex-tui --lib -- \
  --ignored --exact "$TEST" --nocapture --test-threads=1
"$VIMUNIT/vimunit" report --ignore-errors --results "$RESULTS" --name "$NAME" -v "$@" > "$REPORT"
# The summary table is at the end of the report, after the failures.
sed -n '/^== /,$p' "$REPORT"
echo "results: $RESULTS"
echo "report:  $REPORT"
