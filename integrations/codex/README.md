# vim-unit integration: OpenAI Codex CLI

Runs the vim-unit suite against the Vim mode of the [Codex CLI](https://github.com/openai/codex)'s
prompt composer (the `codex-rs/tui` crate; turned on with `/vim` or the `tui.vim_mode` setting).
Codex is a terminal chat client, and its composer is a multi-line text area whose Vim mode covers
a deliberately small subset of Vim.

**Pinned commit:** `23bc6e5f2a5af241e82f0ef18bd7418acb41837e` (head of `main` on 2026-11-02,
"Preserve modified Ctrl+C keys in active TUI views (#58990)").

## Requirements

* git, Python 3
* [rustup](https://rustup.rs) and cargo. `run.sh` installs the toolchain that
  `codex-rs/rust-toolchain.toml` pins (1.95.0) if it's missing.
* cmake and a C compiler (Xcode command-line tools on macOS), for native dependencies
  (aws-lc, OpenSSL, zstd, ...).
* Time and disk space for the first build: the `codex-tui` test binary pulls in about 1,200
  crates. Later runs rebuild only the adapter.

## Running

```sh
integrations/codex/run.sh            # the whole suite
integrations/codex/run.sh -l 0-3     # export/report arguments are passed through
CARGO_JOBS=8 integrations/codex/run.sh
```

`run.sh` clones Codex into `${VIMUNIT_SRC:-~/src/vimunit-integrations}/codex` (a blobless clone),
checks out the pinned commit, applies `adapter.patch` (one `mod` declaration), copies
`adapter/vimunit_adapter.rs` into `codex-rs/tui/src/bottom_pane/chat_composer/`, exports the suite,
builds and runs the adapter with `cargo test -p codex-tui --lib`, and writes
`out/results-codex.jsonl` and `out/report-codex.txt` (with `-v`, so the report lists every
failure). It can be run repeatedly.

## How the adapter works

The adapter is an ignored `#[test]` in the `codex-tui` crate, in a child module of
`chat_composer`, so it can reach the composer's internals. It reads the export named by
`VIMUNIT_TESTS`, runs each test on its own single-threaded tokio runtime with the clock paused
(so a panic in one test can't affect the next), and writes results to `VIMUNIT_RESULTS`.

* **Fresh state per test.** Each test gets a new `ChatComposer`, built the way `BottomPane::new`
  builds it (default `ChatComposerConfig`, default keymap, paste-burst detection on), with Vim mode
  enabled, so it starts in Normal mode with no undo history, register, last change or search. The
  initial buffer is loaded as a restored draft (`set_text_content`) and the cursor placed with
  `set_current_cursor`.
* **Real key path.** Every key goes to `ChatComposer::handle_key_event`, which is where the TUI
  sends terminal key presses when no modal view is open: it owns Vim undo/redo, `.` repeat,
  paste-burst detection, popups and submission before handing the key to the textarea's Vim state
  machine. Keys are the `crossterm` `KeyEvent`s a terminal without the kitty keyboard protocol
  produces: upper-case letters carry `SHIFT`, `<C-X>` is `Ctrl+x`, `<NL>` is `Ctrl+j`, `<C-]>`
  is `Ctrl+5`, `<S-Tab>` is `BackTab`, and so on.
* **Human-speed typing.** By default Codex holds each typed character for a few milliseconds to
  tell typing from an unbracketed paste, and releases it on the next frame tick. The adapter runs
  on tokio's paused clock: after each key it advances the clock 150 ms, runs the composer's
  paste-burst flush (what the app does before drawing a frame), and lays the textarea out at the
  window width (what drawing does). Codex's `j`/`k` move by screen rows of the most recent layout,
  so this matters.
* **Window.** The textarea wraps at `window.width` columns, so tests with `windowSpecified` run.
  The window height isn't observable: the composer has no commands that depend on the scroll
  position.
* **Shortcuts above the composer.** Some keys never reach the composer because the app or chat
  widget acts on them first. The adapter doesn't emulate those actions; if a step types one of
  them, it stops there and reports the step as an error naming the shortcut. With the default
  keymap and no task running: Ctrl+C (clears the draft), Ctrl+V and Alt+V (image paste), and,
  when no popup is open, Ctrl+D on an empty draft (quit), Shift+Tab (collaboration mode), Ctrl+T,
  F2, F3, F4, Ctrl+G (external editor), Ctrl+O (copy), Ctrl+L, Alt+R, Ctrl+/ (and Ctrl+7, which
  is how legacy terminals send it, so `<C-_>`), Shift+Up/Down and Alt+, / Alt+. (reasoning
  effort).
* **Results.** After each step the adapter records `current_text()` and `current_cursor()`, the
  draft as the user sees it, with columns in bytes (`"unit": "byte"`). If the step doesn't end in
  plain Normal mode (Insert or Replace mode, a pending operator, an unfinished `/` search, or
  history search), it's a failure: when the buffer matched anyway the record gets an `error`
  saying so. Key presses that submit the prompt or dispatch a slash command are listed in a
  `note` field.
* **After a failing step** the composer is set to the expected buffer and cursor. If it was in
  plain Normal mode the text is replaced in place, keeping undo history, the register and the
  last change; otherwise the draft is reloaded, which also returns it to Normal mode but clears
  those.

## Skips

Codex has no settings for Vim options, so each option counts as fixed at the value its behavior
corresponds to, and tests that set a different value are skipped (with the reason in the
results):

| Option | Codex behaves like | Why |
|--------|--------------------|-----|
| `wrap` | `wrap` | the composer always wraps long lines |
| `linebreak` | `linebreak` | it wraps at word boundaries (textwrap) |
| `smoothscroll` | `smoothscroll` | it scrolls by screen rows |
| `tabstop` | `tabstop=1` | it displays a tab as one column |
| `autoindent` | `noautoindent` | `o`, `O` and new lines never copy the indent |
| `undolevels` | at least 64 | it keeps 64 undo steps; tests setting fewer are skipped |
| everything else | the baseline | Codex has no such feature or setting |

Codex's `h` and `l` cross line breaks and its Normal-mode cursor can rest after the end of a
line, but those are treated as inaccuracies (failures), not as `whichwrap`/`virtualedit`
settings to skip.

Tests with `:definition`s are skipped: the composer has no go-to-definition.

## What to expect

From reading the source at the pinned commit (`tui/src/keymap.rs`,
`tui/src/bottom_pane/textarea/vim*.rs`), the Vim mode implements: `i a I A o O R`, `h j k l`
and the arrow keys, `w b e`, `0 $`, `f F t T`, `G`, `x s D C Y p r .`, the operators `d c y`
with those motions and `dd cc yy`, the text objects `iw aw iW aW` and the bracket and quote
objects, `u` and CTRL-R, and `/ ? n N` (literal, case-sensitive, wrapping search). There are no
counts, no Visual mode, no named registers, no macros, no marks, and no `P`, `gg`, `W B E`,
`ge`, `;`, `,`, `%`, `J`, `~`, `<`, `>`, `*`, `#` or Ex commands.

Enter submits the prompt (in both Normal and Insert mode; Codex's newline key is Shift+Enter or
Ctrl+J), and so does Tab, so steps that type `<CR>` or `<Tab>` leave an empty draft in Insert
mode. In Insert mode, `@` or a leading `/` opens a completion popup that takes Enter, Tab,
Escape and the arrow keys.

## Limitations

* The app and chat widget aren't present. Besides the shortcuts above, what they do with a
  submitted prompt or slash command isn't emulated (the composer itself clears the draft and
  returns to Insert mode on submission), nor is Esc Esc on an empty draft (which opens the
  backtrack view), and file-search results for `@` completion never arrive.
* Keys are encoded as a legacy (non-kitty) terminal sends them. With the kitty keyboard protocol
  a few control keys arrive differently (for example `<C-]>` as Ctrl+] rather than Ctrl+5).
* After a failing step that ended outside Normal mode, the reset clears the undo history and the
  last change and search, so later steps that depend on them may fail too.

## Results

Not yet run: building and running Codex's code in this session was not permitted. Run `run.sh`
to produce `out/report-codex.txt`, and paste its per-level table here with the date and the
suite size.
