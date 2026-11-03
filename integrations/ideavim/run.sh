#!/usr/bin/env bash
# Runs the vim-unit suite against IdeaVim, the Vim emulation plugin for IntelliJ-based IDEs.
#
# Usage: integrations/ideavim/run.sh [vimunit export arguments, e.g. -l 0-3, -k REGEX or test paths]
#
# Checks out IdeaVim at a pinned commit into ${VIMUNIT_SRC:-~/src/vimunit-integrations}/ideavim, copies the adapter
# (VimUnitSuiteTest.kt) into its test sources, exports the suite, runs the adapter with Gradle (which downloads the
# IntelliJ Platform SDK on the first run), and writes out/results-ideavim.jsonl and out/report-ideavim.txt. Safe to run
# repeatedly. See README.md.
set -euo pipefail

NAME=ideavim
REPO_URL=https://github.com/JetBrains/ideavim.git
# The head of master on 2026-11-02 ("Merge pull request #2174 from JetBrains/VIM-4365/air-module")
PINNED_COMMIT=0c7bfca612312d13a9fc0513518bb9a80940b085
TEST_CLASS=org.jetbrains.plugins.ideavim.vimunit.VimUnitSuiteTest
ADAPTER_PATH=src/test/java/org/jetbrains/plugins/ideavim/vimunit/VimUnitSuiteTest.kt
MIN_FREE_GB=15

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VIMUNIT=$(cd "$HERE/../.." && pwd)
SRC_ROOT=${VIMUNIT_SRC:-$HOME/src/vimunit-integrations}
CHECKOUT=$SRC_ROOT/$NAME
DATA=$CHECKOUT/build/vimunit # where the adapter reads tests.json and writes results.jsonl
OUT=$VIMUNIT/out

log() { printf '[%s] %s\n' "$NAME" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# --- Check out IdeaVim at the pinned commit -------------------------------------------------------------------------

mkdir -p "$SRC_ROOT"
if [ ! -d "$CHECKOUT/.git" ]; then
  log "cloning $REPO_URL into $CHECKOUT"
  git clone --quiet "$REPO_URL" "$CHECKOUT"
fi
cd "$CHECKOUT"
if ! git cat-file -e "$PINNED_COMMIT^{commit}" 2>/dev/null; then
  git fetch --quiet origin
fi
if [ "$(git rev-parse HEAD)" != "$PINNED_COMMIT" ]; then
  log "checking out $PINNED_COMMIT"
  git checkout --quiet --detach "$PINNED_COMMIT" || die "couldn't check out $PINNED_COMMIT in $CHECKOUT"
fi

# --- Add the adapter --------------------------------------------------------------------------------------------------

mkdir -p "$(dirname "$ADAPTER_PATH")"
cmp -s "$HERE/VimUnitSuiteTest.kt" "$ADAPTER_PATH" || cp "$HERE/VimUnitSuiteTest.kt" "$ADAPTER_PATH"
# Keep the adapter and the downloaded JDK out of `git status` in the checkout
for pattern in "/$ADAPTER_PATH" "/.vimunit-jdk/"; do
  grep -qxF "$pattern" .git/info/exclude 2>/dev/null || echo "$pattern" >>.git/info/exclude
done

# --- Find (or download) JDK 21, which IdeaVim's build requires Gradle itself to run on --------------------------------

is_jdk21() { [ -x "$1/bin/java" ] && "$1/bin/java" -version 2>&1 | head -1 | grep -q 'version "21[."]'; }

find_jdk21() {
  local candidate
  if [ -n "${JAVA_HOME:-}" ] && is_jdk21 "$JAVA_HOME"; then
    echo "$JAVA_HOME"
    return
  fi
  if [ -x /usr/libexec/java_home ] && candidate=$(/usr/libexec/java_home -v 21 2>/dev/null) && is_jdk21 "$candidate"; then
    echo "$candidate"
    return
  fi
  for candidate in "$CHECKOUT"/.vimunit-jdk/*/Contents/Home "$CHECKOUT"/.vimunit-jdk/*; do
    if is_jdk21 "$candidate"; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

download_jdk21() {
  local os arch dir=$CHECKOUT/.vimunit-jdk
  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux) os=linux ;;
    *) die "no JDK 21 found; set JAVA_HOME to one" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=aarch64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "no JDK 21 found; set JAVA_HOME to one" ;;
  esac
  log "downloading Temurin JDK 21 ($os/$arch) into $dir"
  rm -rf "$dir"
  mkdir -p "$dir"
  curl -fsSL -o "$dir/jdk.tar.gz" "https://api.adoptium.net/v3/binary/latest/21/ga/$os/$arch/jdk/hotspot/normal/eclipse"
  tar -xzf "$dir/jdk.tar.gz" -C "$dir"
  rm "$dir/jdk.tar.gz"
}

JDK=$(find_jdk21) || {
  download_jdk21
  JDK=$(find_jdk21) || die "couldn't set up JDK 21"
}
log "using JDK 21 at $JDK"

# --- Export the suite -------------------------------------------------------------------------------------------------

mkdir -p "$DATA" "$OUT"
rm -f "$DATA/results.jsonl" "$DATA/diagnostics.log"
(cd "$VIMUNIT" && ./vimunit export --ignore-errors -o "$DATA/tests.json" "$@")

# --- Build IdeaVim and run the adapter --------------------------------------------------------------------------------

free_gb=$(df -Pk "$SRC_ROOT" | awk 'NR == 2 { print int($4 / 1048576) }')
if [ "$free_gb" -lt "$MIN_FREE_GB" ] && [ -z "${VIMUNIT_IGNORE_DISK:-}" ]; then
  die "only ${free_gb} GB free; the first build downloads the IntelliJ Platform (several GB). Set VIMUNIT_IGNORE_DISK=1 to go ahead anyway."
fi

log "building IdeaVim and running the suite (Gradle log: $DATA/gradle.log)"
# --rerun: the test task's inputs don't include tests.json, so Gradle would otherwise consider it up to date.
# --no-daemon: don't leave a large Gradle daemon running afterwards.
status=0
JAVA_HOME=$JDK ./gradlew --no-daemon --console=plain --max-workers=4 \
  :test --tests "$TEST_CLASS" --rerun >"$DATA/gradle.log" 2>&1 || status=$?

if [ ! -s "$DATA/results.jsonl" ]; then
  tail -n 40 "$DATA/gradle.log" >&2
  die "the adapter wrote no results (Gradle exit status $status); see $DATA/gradle.log"
fi
if [ "$status" -ne 0 ]; then
  # Mismatches don't fail JUnit tests, so this means the adapter hit an exception in some tests (recorded as errors).
  log "Gradle exited with status $status; see $DATA/gradle.log and $DATA/diagnostics.log"
fi

# --- Score -------------------------------------------------------------------------------------------------------------

cp "$DATA/results.jsonl" "$OUT/results-$NAME.jsonl"
(cd "$VIMUNIT" && ./vimunit report --ignore-errors --results "$OUT/results-$NAME.jsonl" \
  --name "IdeaVim ${PINNED_COMMIT:0:10}" "$@") >"$OUT/report-$NAME.txt"
cat "$OUT/report-$NAME.txt"
log "results: $OUT/results-$NAME.jsonl; report: $OUT/report-$NAME.txt; IdeaVim errors: $DATA/diagnostics.log"
