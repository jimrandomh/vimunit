VSCodeVim
=========

Runs the vim-unit suite against [VSCodeVim](https://github.com/VSCodeVim/Vim),
the Vim emulation extension for VS Code (also used in Cursor and other VS Code
forks). The adapter is a Mocha test file that runs in VS Code's extension host
alongside VSCodeVim, like VSCodeVim's own tests, and drives the real extension.

Requirements
------------

* macOS or Linux with a display (on a headless Linux machine, run under
  `xvfb-run -a`). A VS Code window opens while the tests run, and **it needs
  the keyboard focus** (see below).
* git, Node.js (tested with Node 26; VSCodeVim's CI uses Node 22), and yarn 1.x
  (if `yarn` is missing or isn't 1.x, `run.sh` uses `npx yarn@1.22.22`).
* Network access for the first run: the clone, VSCodeVim's npm dependencies,
  and VS Code itself (downloaded once by `@vscode/test-electron` into the
  checkout's `.vscode-test/`). About 1.5 GB of disk in all.

Running it
----------

```sh
integrations/vscodevim/run.sh            # the whole suite
integrations/vscodevim/run.sh -l 0-3     # some levels (passed to export and report)
integrations/vscodevim/run.sh level2/visual.vimunit
```

`run.sh` clones VSCodeVim into `${VIMUNIT_SRC:-~/src/vimunit-integrations}/vscodevim`,
checks out the pinned commit, installs dependencies (`yarn install
--frozen-lockfile --ignore-scripts`, skipped when already done for this
commit), copies `adapter/*.ts` into the checkout's `test/vimunit/`, compiles
the extension and its tests with `gulp prepare-test` (what `yarn build-test`
does), exports the suite, runs it, and writes `out/results-vscodevim.jsonl`
and `out/report-vscodevim.txt`. It's safe to rerun. To see each failure:

```sh
./vimunit report --ignore-errors --results out/results-vscodevim.jsonl -v
```

Environment variables: `VIMUNIT_SRC` (where to check out), `VIMUNIT_VSCODE_VERSION`
(default 1.144.1), `VIMUNIT_GREP` (a regex; only run tests whose id matches).
VS Code's own output goes to `<checkout>/.vimunit/vscode.log`.

Pinned versions: VSCodeVim commit `28f027545526363b1c0c577b71a3e175c3285123`
(the head of `master` on 2026-11-02; version 1.32.4), VS Code 1.144.1.

How the adapter works
---------------------

* `adapter/runVimunit.ts` downloads VS Code with `@vscode/test-electron` and
  launches it with VSCodeVim as the extension under development, a fresh
  user-data directory, other extensions disabled, and user settings that turn
  off VS Code features vim (with no plugins) doesn't have: completion popups,
  auto-closing brackets and quotes, auto-surround, format on type, indentation
  detection, and so on. It restarts VS Code if it crashes or stops making
  progress, and the adapter carries on after the test that was running (which
  is recorded as an error).
* `adapter/index.ts` is the extension-host entry point (like VSCodeVim's
  `test/index.ts`, it puts VSCodeVim in its test mode, where settings come from
  a mock configuration object), and `adapter/vimunit.adapter.ts` generates one
  Mocha test per vim-unit test.
* **Keys go through the same commands as real key presses.** Printable
  characters and Enter go to VS Code's `type` command, which VSCodeVim
  overrides (Enter reaches extensions as typing `"\n"`). Other keys go to the
  command that VSCodeVim's `package.json` keybindings bind them to
  (`extension.vim_escape`, `extension.vim_ctrl+r`, ...), if the binding's
  `when` clause holds at that moment (the adapter evaluates it against
  VSCodeVim's context keys, so for instance Tab, Home and End in Insert mode
  aren't VSCodeVim's); otherwise to VS Code's default command for the key on
  Linux and Windows (`tab`, `cursorHome`, `cursorWordStartLeft`,
  `cursorUpSelect`, ...), or nowhere if the key has no editing command (F1-F12,
  CTRL-\, CTRL-_, and CTRL-S and CTRL-Z, which VSCodeVim leaves to VS Code by
  default). VSCodeVim queues all of these on its task queue; the adapter waits
  for the queue to empty after each key.
* **Fresh state per test.** One editor on a plain-text file is reused. Before
  each test the adapter discards VSCodeVim's `ModeHandler` (which holds the
  mode, undo history, local marks and the last `f`/`t`), clears registers,
  global marks, the jump list, the last search, substitution, macro and `.`
  command, and search history, loads the buffer, places the cursor, scrolls to
  the top, and creates a new `ModeHandler` the way the extension does.
* **Options.** VSCodeVim's settings start from its `package.json` defaults,
  except that its emulated plugins are off (it enables vim-surround by default;
  vim-unit assumes no plugins). The baseline and test options are then applied:
  `startofline`, `joinspaces`, `ignorecase` (VSCodeVim's default is on),
  `smartcase`, `autoindent`, `tildeop`, `whichwrap`, `matchpairs`, `gdefault`,
  `wrapscan`, `incsearch`, `scroll`, `scrolloff` and `wrap` become `vim.*`
  settings; `iskeyword` becomes `vim.iskeyword` (which lists separator
  characters, so it's translated for ASCII); `textwidth` becomes `vim.textwidth`
  (0 becomes 79, what `gq` uses in an 80-column window); `tabstop`, `expandtab`
  and `shiftwidth` become the editor's `tabSize`, `insertSpaces` and
  `indentSize`; `autoindent` also sets `editor.autoIndent` (`keep` or `none`),
  and `smarttab` sets `editor.useTabStops`.
* **After a step** the adapter records the buffer and the primary cursor (in
  UTF-16 code units, `"unit": "utf16"`). A step that ends outside Normal mode,
  while recording a macro, or with several cursors is recorded with an `error`
  (along with the state), since vim-unit steps must end in Normal mode. If the
  step doesn't match, the adapter returns VSCodeVim to Normal mode (with
  `<Esc>`), sets the buffer and cursor to the expected state, and goes on.
* **Go to definition.** The test's `:definition`s are served by a definition
  provider and a declaration provider registered for the document, which is
  what VSCodeVim's `CTRL-]` (`editor.action.revealDefinition`) and `gd`/`gD`
  (`editor.action.goToDeclaration`) use.
* **Prompts.** Some commands wait for an answer in a VS Code input box or
  quick pick: `:s///c` asks "Replace with ...?" in an input box, and CTRL-X
  CTRL-L in Insert mode, CTRL-F on the command line and `q:` use quick picks. A
  user answers by typing into the widget, which doesn't go through VS Code
  commands, so the adapter replaces `vscode.window.showInputBox` and
  `showQuickPick` with emulations: while one is open, the keys typed go to it
  (characters edit its text, `<BS>` deletes, `<CR>` accepts unless the input
  box's validation shows an error, `<Esc>` cancels; a quick pick filters its
  items by substring and `<Up>`/`<Down>`/CTRL-P/CTRL-N move through them), and
  the input box's `validateInput` is called after each change, as VS Code
  does. VSCodeVim's `:s///c` closes its input box as soon as one of y/n/a/q/l
  is typed, so each of those keys answers one prompt. A step that ends with a
  prompt still open is recorded as an error. File dialogs are answered with
  "cancel".
* **Runaway commands.** VSCodeVim doesn't stop a recursive macro when a motion
  fails at the end of the buffer, so a recursive macro can run forever. A key
  may take at most 5 seconds and a step 10 seconds; after that the adapter
  closes any open prompt, makes that `ModeHandler` throw on every further
  action so the command unwinds, records the step as an error, and starts the
  next step or test with a new `ModeHandler`. If the command still doesn't
  stop, the launcher restarts VS Code and carries on with the next test.
* **Keyboard focus.** VSCodeVim inserts typed text with VS Code's `type`
  command, which only acts on the focused editor, so typing is lost when the
  VS Code window doesn't have the keyboard focus. Before each test the adapter
  checks that typing reaches the editor, taking the focus back with
  `workbench.action.focusWindow` if needed, and it reruns a test (up to three
  times) if the window lost the focus while it ran. If you use the computer
  while the suite runs, expect the window to come back to the front.

What's skipped
--------------

* Tests that depend on the window size (`windowSpecified`): the size of the
  editor's text area can't be set in the test instance. (A test whose window
  is only as wide as its `textwidth` is run: `vim.textwidth` doesn't depend on
  the window.)
* Tests whose buffer contains fold markers (with `foldenable`): VS Code folds
  by indentation or language rules, not by `{{{`/`}}}` markers, and folds don't
  start out closed.
* Tests that set an option VSCodeVim has no setting for to a value other than
  the one its fixed behavior corresponds to. That's the baseline value, except
  for `nrformats` (VSCodeVim's CTRL-A recognizes octal and hex but not binary,
  so it behaves like `nrformats=octal,hex`) and `shiftround` (`>` and `<` use
  VS Code's indent commands, which round to a multiple of the indent size).
  The options this covers include `softtabstop`, `copyindent`,
  `preserveindent`, `smartindent`, `cindent`, `formatoptions`, `comments`,
  `delcombine`, `backspace`, `virtualedit`, `selection`, `keymodel`,
  `cpoptions`, `jumpoptions`, `linebreak`, `sidescroll` and the fold options.
* Tests that set `shiftwidth` different from `tabstop` with `noexpandtab`:
  when indenting with tabs, VS Code's indent commands (which `>`, `<`, CTRL-T
  and CTRL-D use) indent by a whole tab stop, ignoring the indent size.
* `iskeyword` values that differ from the baseline outside ASCII.

Limitations
-----------

* VSCodeVim runs in its test mode (`Globals.isTesting`), as in its own tests:
  settings come from a mock configuration object rather than VS Code's
  settings. The one other behavioral difference in that mode is that
  overlapping text edits throw an error instead of being applied one at a
  time.
* Keys that VSCodeVim doesn't bind go to VS Code's defaults on Linux and
  Windows, whatever platform the suite runs on (on macOS, some of these keys
  have different default bindings).
* The adapter assumes that no completion or parameter-hint widget is open when
  it evaluates keybinding `when` clauses (those widgets are turned off). With
  completion popups off, VSCodeVim's Insert-mode CTRL-N and CTRL-P (which only
  move through the popup) do nothing; with them on they would select a
  suggestion without inserting it, so the completion tests fail either way.
* VS Code's input boxes and quick picks are emulated rather than real (see
  Prompts above); quick picks filter by substring rather than VS Code's fuzzy
  matching.
* Results include two fields the report ignores: `ms` (how long the step took)
  and `vscodevimErrors` (exceptions VSCodeVim raised and swallowed while
  handling the keys, which a user would only see in the log).

Latest results
--------------

2026-11-02, VSCodeVim `28f0275455` in VS Code 1.144.1 on macOS, against the
suite as of that day (953 tests, 2620 steps):

```
== VSCodeVim 28f0275455
  level0       11/13   tests     22/26    steps
  level1       47/56   tests    156/169   steps
  level2       78/89   tests    271/299   steps
  level3      116/176  tests    392/512   steps  (35 skipped)
  level4      158/247  tests    491/655   steps  (48 skipped)
  level5      102/225  tests    346/557   steps  (14 skipped)
  level6        4/93   tests     22/282   steps  (209 skipped)
  side          7/54   tests     17/120   steps  (84 skipped)
  total       523/953  tests   1717/2620  steps
  compliance level: none
```

Two full runs gave identical results. Skipped tests: 49 window-size, 20
folding, 17 `shiftwidth` with tabs, 14 `nrformats`, 14 `formatoptions`,
and a few `delcombine`, `smartindent`, `softtabstop`, `copyindent`,
`preserveindent`.

The main kinds of failure (spot-checked by hand against VSCodeVim's source
to rule out adapter problems):

* **Columns are characters, not screen cells.** `j`/`k` keep the character
  index rather than the screen column across tabs (both level-0 failures),
  `|` counts characters, and `gR` doesn't handle tabs.
* **Unicode.** Combining marks are separate characters to `l`, `h`, `x`, `r`,
  `~` and `s`; emoji and mathematical alphanumerics (outside the BMP) aren't
  their own word class for `w`/`b`; `^` treats U+3000 as a blank; blockwise
  Visual mode ignores double-width characters.
* **Failed commands don't fail.** `dj`/`dk` on the last/first line, `2dd` and
  `2D` on the last line delete instead of doing nothing; macros don't stop at
  a failing motion, so `100@a` keeps going and a recursive macro
  (`qaqqaA;<Esc>j@aq@a`) never ends: the adapter has to stop it (before it
  did, VS Code's renderer process got killed).
* **Undo** often leaves the cursor where it was instead of at the start of the
  undone change; `U` doesn't undo itself.
* **Autoindent and Enter.** Enter doesn't drop the whitespace after the cursor,
  an autoindent isn't removed when nothing is typed on the line (`o<Esc>`),
  `O` above a tab-indented line indents with spaces.
* **Regular expressions** are JavaScript syntax with a few Vim escapes:
  `\|`, `\+`, `\=`, `\{n,m}`, `\(\)`, `\zs`/`\ze` and `[[:upper:]]` don't work.
* **Command line.** CTRL-J (`<NL>`) doesn't end a search or command line; the
  cursor after `:d`, `:m`, `:j` and `:s` differs; `:g` mostly fails; search
  offsets (`/foo/e+1`, `;`) and `d/foo/+1` are incomplete; `:s///c` works
  (through an input box) but leaves the cursor at the start of the line.
* **Insert-mode completion**: CTRL-N and CTRL-P only move through VS Code's
  suggestion widget; there's no keyword completion. (Insert-mode `<Home>` is
  VS Code's "smart home", to the first non-blank, since VSCodeVim doesn't bind
  it.)
* **Visual mode.** Blockwise `I`/`A`/`$A`/`p` and shifting from the block's
  left edge differ (some leave several cursors); repeating a text object in
  Visual mode (`viwiw`, `vapap`) doesn't extend the selection; counts before
  `v` and forced motions (`dvj`, `dV`) aren't supported.
* **Jumps.** `<Tab>` in Normal mode isn't CTRL-I; counts with `g;`/`g,` and
  CTRL-T don't work.
