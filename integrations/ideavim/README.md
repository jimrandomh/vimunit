# IdeaVim

[IdeaVim](https://github.com/JetBrains/ideavim) is the Vim emulation plugin for
IntelliJ-based IDEs (IntelliJ IDEA, PyCharm, CLion, ...). This integration
runs the vim-unit suite against it in IdeaVim's own headless test framework.

```sh
integrations/ideavim/run.sh            # the whole suite
integrations/ideavim/run.sh -l 0-3     # arguments are passed to `vimunit export` and `vimunit report`
./vimunit report --results out/results-ideavim.jsonl -v   # list each failure
```

## Requirements

* git, curl, Python 3 (for `vimunit`), and network access on the first run.
* **JDK 21.** IdeaVim's build insists that Gradle itself runs on Java 21.
  `run.sh` uses `$JAVA_HOME` if it is a JDK 21, else `/usr/libexec/java_home
  -v 21` on macOS, else it downloads Eclipse Temurin 21 from adoptium.net into
  `<checkout>/.vimunit-jdk/` (macOS and Linux, x64 and arm64).
* About 10 GB of disk for the first build: the Gradle distribution, the
  IntelliJ IDEA 2026.1 platform SDK (downloaded by the IntelliJ Platform Gradle
  Plugin into `~/.gradle`), and IdeaVim's build output. `run.sh` refuses to
  start with less than 15 GB free (`VIMUNIT_IGNORE_DISK=1` overrides).
* The first run takes a long time (downloads and a full Kotlin build of
  IdeaVim); later runs recompile only the adapter.

## What run.sh does

1. Clones `https://github.com/JetBrains/ideavim.git` into
   `${VIMUNIT_SRC:-~/src/vimunit-integrations}/ideavim` and checks out the
   pinned commit **`0c7bfca612312d13a9fc0513518bb9a80940b085`** (master on
   2026-11-02, "Merge pull request #2174 from JetBrains/VIM-4365/air-module").
2. Copies `VimUnitSuiteTest.kt` into the checkout as
   `src/test/java/org/jetbrains/plugins/ideavim/vimunit/VimUnitSuiteTest.kt`
   (no other change to IdeaVim is needed; the file is added to the checkout's
   `.git/info/exclude`).
3. `./vimunit export --ignore-errors` into `<checkout>/build/vimunit/tests.json`.
4. `./gradlew --no-daemon --max-workers=4 :test --tests
   org.jetbrains.plugins.ideavim.vimunit.VimUnitSuiteTest --rerun`, which
   builds IdeaVim and runs the adapter. The adapter writes
   `<checkout>/build/vimunit/results.jsonl` and, for anything IdeaVim threw or
   logged as an error, `<checkout>/build/vimunit/diagnostics.log`. The Gradle
   output is in `<checkout>/build/vimunit/gradle.log`.
5. Copies the results to `out/results-ideavim.jsonl` and writes
   `out/report-ideavim.txt` with `./vimunit report --ignore-errors`.

## How the adapter works

`VimUnitSuiteTest` extends IdeaVim's `VimTestCase`, the base class of
IdeaVim's own several thousand tests, and is a JUnit 5 parameterized test with
one invocation per vim-unit test, so each test gets `VimTestCase`'s fresh light
fixture: a new project file and editor, empty undo history, and IdeaVim's
registers, marks, jumps, search state, history and options reset. The adapter
additionally resets the global state `VimTestCase` keeps between tests (the
last `f`/`t` for `;`, the last change for `.`, the last macro for `@@`, the
last `:s` replacement string, the last inserted text and the last `:!`
command) to IdeaVim's start-up values, and turns off `ideastrictmode`, which
`VimTestCase` turns on but the IDE doesn't.

For each test it

* applies the options (see below), loads the buffer with
  `configureByText(...)` with the cursor at the test's position (in UTF-16
  code units), sizes the editor's visible area to `window.width` by
  `window.height` columns and lines with `VimTestCase.setEditorVisibleSize`,
  and scrolls it to the top;
* types each step's keys the way `VimTestCase` does in its default "via IDE"
  mode, which follows the IDE's real keyboard path: a key that types a
  character goes to the editor's typed-action handler (which IdeaVim
  replaces), and every other key press (`<Esc>`, `<CR>`, `<C-V>`, arrows, ...)
  is offered to IdeaVim's `VimShortcutKeyAction` as a `KEY_PRESSED` action
  event. If IdeaVim declines a key (it hands Enter, Tab and the arrow keys to
  the IDE while a completion popup is open), the adapter performs the IDE
  action bound to it in the active keymap, as the IDE would. Special keys are
  converted with IdeaVim's own key parser (`<Nul>` as `<C-@>`); a character
  outside the BMP is typed as its two UTF-16 halves, which is how the IDE
  delivers it;
* reads the document text and the primary caret's offset, and reports the
  cursor column in UTF-16 code units (`"unit": "utf16"`), the document's
  native unit;
* if the step doesn't match, puts IdeaVim back in Normal mode (closing the
  command line and stopping macro recording if needed) and sets the expected
  text and cursor before the next step. The text is set in an undoable IDE
  command, so a later `u` may undo the reset.

An error from a key doesn't stop the step: exceptions thrown while handling a
key, and errors IdeaVim logs (which throw in IntelliJ's test framework but are
only logged in the IDE), are written to `diagnostics.log`, and the remaining
keys are still typed.

Mismatches don't fail the JUnit tests (`vimunit report` scores them); skipped
vim-unit tests show up as skipped JUnit tests, and a JUnit test fails only if
the adapter itself couldn't run the test, in which case its remaining steps
are recorded as errors.

## Options

The adapter applies the baseline options and then the test's options:

* **IdeaVim options**, set as `:set` would set them (local and global values):
  `wrap`, `breakindent`, `scrolloff`, `sidescroll`, `sidescrolloff`,
  `scrolljump`, `scroll`, `startofline`, `autoindent`, `textwidth`,
  `comments`, `nrformats`, `whichwrap`, `virtualedit`, `selection`,
  `selectmode`, `keymodel`, `iskeyword`, `matchpairs`, `undolevels`,
  `ignorecase`, `smartcase`, `wrapscan`, `gdefault`, `incsearch`, `foldlevel`.
  This overrides some IdeaVim defaults that differ from the baseline, e.g.
  `keymodel` (IdeaVim: `continueselect,stopselect`), `iskeyword` (no
  `192-255`) and `foldlevel` (999).
* **`tabstop`, `shiftwidth`, `expandtab`** aren't IdeaVim options: IdeaVim
  takes them from the IDE's code style. The adapter sets temporary code style
  settings for plain text (tab size, indent size, "use tab character") and the
  editor's tab size. `shiftwidth=0` means `tabstop`.
* **`nrformats`**: IdeaVim doesn't support binary numbers, so it has no `bin`
  value. The adapter drops `bin` and runs the test, so tests of `CTRL-A` on
  `0b...` numbers fail rather than being skipped.
* **`undolevels`** is accepted by IdeaVim but not used.
* **Options IdeaVim doesn't have** (`linebreak`, `showbreak`, `smoothscroll`,
  `softtabstop`, `smarttab`, `shiftround`, `copyindent`, `preserveindent`,
  `smartindent`, `cindent`, `wrapmargin`, `formatoptions`, `joinspaces`,
  `tildeop`, `delcombine`, `backspace`, `cpoptions`, `jumpoptions`, `magic`,
  `complete`, `completeopt`, `infercase`, and the fold options other than
  `foldlevel`): IdeaVim's fixed behaviour is taken to be the baseline value,
  except `foldmethod`, which corresponds to `manual`. Tests that set any other
  value are skipped.

Everything else is IdeaVim's default configuration, including
`clipboard=ideaput,autoselect` (puts go through the IDE's paste handling) and
the IDE's default editor settings (for example, no virtual space after the end
of the file).

## Skipped tests

* Tests that set an option IdeaVim doesn't have to a non-baseline value (see
  above), or a value IdeaVim rejects.
* Marker folding: tests whose buffers contain fold markers while
  `foldmethod=marker` is in effect (including `side/folding.vimunit`, which
  sets it). IntelliJ has no folding for plain text, and IdeaVim has no
  `foldmethod`.
* `:definition`: IntelliJ's go-to-declaration can't be given the test's
  definitions for a plain text file without a language plugin.
* Window-dependent tests (`:window`) with `wrap` on and a line that is within
  a column of the window width: IntelliJ's soft wraps break lines at word
  boundaries and keep a column free for the wrap sign, so screen lines can't
  match Vim's. Window-dependent tests without such lines (most scrolling and
  `H`/`M`/`L` tests) and those with `nowrap` are run, with the editor sized to
  the window.
* Tests whose buffer contains IntelliJ test-fixture markup (`<caret>`,
  `<selection>`, `<block>`), which the fixture would interpret.

## Limitations

* Keys go through the IDE's action and typed-character handlers, but not
  through the AWT event queue and `IdeKeyEventDispatcher` themselves, and the
  key-declined fallback tries only the active keymap's actions for the key.
* The editor is a headless test editor. Its visible area is set in pixels from
  the font's character width and line height, which is how IdeaVim's own
  scrolling tests size it.
* IntelliJ's "detect indents from file content" is off in tests, so the code
  style settings above are what IdeaVim sees; in the IDE, detected indents
  would override them.
* Resetting after a mismatch is an undoable edit (see above).
* A test that sends IdeaVim into an infinite loop hangs the run (there is no
  per-test timeout).

## Results

Not yet available: the adapter was written against the pinned commit by
reading IdeaVim's source, but the build and run step (`./gradlew ... :test`)
has not been executed yet. Run `integrations/ideavim/run.sh` and paste the
per-level table from `out/report-ideavim.txt` here, with the date and the
suite size.
