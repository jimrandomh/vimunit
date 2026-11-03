vim-unit: CodeMirror 6 vim mode (`@replit/codemirror-vim`)
===========================================================

Runs the vim-unit suite against [replit/codemirror-vim](https://github.com/replit/codemirror-vim),
the vim mode for CodeMirror 6 (used by Replit, Obsidian, JupyterLab and many
web editors), in headless Chromium, typing every key as a real key event.

```sh
integrations/codemirror-vim/run.sh              # the whole suite
integrations/codemirror-vim/run.sh -l 0-3       # extra args go to `vimunit export` and `vimunit report`
integrations/codemirror-vim/run.sh -k 'Macro'
```

It writes `out/results-codemirror-vim.jsonl` and `out/report-codemirror-vim.txt`
(every failing step with expected and actual buffers, then the summary table).
A full run takes about 80 seconds.


Requirements
------------

* git, Node.js 20 or later with npm, [pnpm](https://pnpm.io) (the repository
  pins pnpm 11 in `packageManager`), python3.
* Network access on the first run: the clone, the workspace's npm packages,
  Playwright, and Playwright's Chromium headless shell (skipped if it's already
  in Playwright's cache). About 110 MB of disk for the checkout and its
  packages, and 200 MB for Chromium.

The editor is checked out into `$VIMUNIT_SRC/codemirror-vim` (default
`~/src/vimunit-integrations/codemirror-vim`). `run.sh` is idempotent: it
re-checks-out the pinned commit, reinstalls from the lockfiles, copies the
adapter in again and rebuilds.


Pinned version
--------------

`c3131c442069cbe762c7d3c78295b2d98e853bc6` (master, 2026-11-01: "fix: a q that
is another key's argument does not end macro recording (#282)"), which is
`@replit/codemirror-vim` 6.4.0 with the shared `@replit/codemirror-vim-core`
engine, on `@codemirror/view` 6.36.4, `@codemirror/state` 6.5.2 and
`@codemirror/commands` 6.8.0 from the repository's lockfile.


How the adapter works
---------------------

Files in `adapter/`:

* `page.ts`: the browser side. `run.sh` copies it into
  `packages/codemirror-vim/vimunit/` and bundles it with the workspace's own
  vite (`vite.config.mjs`), importing the plugin from its TypeScript source and
  CodeMirror from the workspace, so it runs exactly the checked-out code. It
  creates editors and reads and resets their state; it never sends keys.
* `driver.mjs`, `package.json`, `package-lock.json`: the Node side, in its own
  directory (`vimunit-driver/` in the checkout) with Playwright 1.64.1. It
  loads the page in headless Chromium, runs the tests and writes the results.
* `index.html`: the page.

For each test the driver:

1. **Skips** it if it can't be emulated (see below).
2. **Builds a fresh editor**: destroys the previous `EditorView`, calls
   `Vim.resetVimGlobalState_()` (registers, last search, last `f`/`t`, macros,
   jump list, option values) and `Vim.mapclear()`, and creates a new view with
   the initial buffer and cursor. The extensions are `vim()` (first, as its
   README requires), `history()`, `drawSelection()`, CodeMirror's
   `defaultKeymap` and `historyKeymap` (what Insert mode falls through to:
   `<CR>`, `<BS>`, `<Del>`, arrows, `<Home>`/`<End>`, ...), `Tab` bound to
   `insertTab` (without a binding the browser moves focus out of the editor),
   `tabSize`, `indentUnit`, and `EditorView.lineWrapping` when `wrap` is set. No
   language is loaded, no `basicSetup` (no auto-closing brackets, completion or
   line numbers). The text is monospace with no padding, and the editor is
   sized to the test's window (`window.width` x `window.height` character
   cells), then scrolled to the top.
3. **Types each step's keys as real key events**, with the Chrome DevTools
   Protocol's `Input.dispatchKeyEvent` (what Playwright's keyboard uses, but
   with exact control of `key`, `code` and modifiers). So keys take the same
   path as typing: `keydown` goes to the vim plugin's handler; when Vim mode
   doesn't take a key (Insert mode text, `<CR>`, `<BS>`), the browser's default
   action inserts the text through CodeMirror's EditContext input handling or
   runs CodeMirror's keymap; `:` and `/` open the plugin's prompt `<input>`,
   which the keys are then typed into. Ctrl and Shift are pressed and released
   around the keys that need them. Keys follow a US layout; a character that
   isn't on it (`é`, `日`, `😀`) is typed as a key whose `key` is that
   character and whose `code` is empty, as on a keyboard layout that has it.
   `<NL>` is CTRL-J, `<Nul>` is CTRL-SHIFT-2 and `<C-^>` is CTRL-SHIFT-6, as on
   a keyboard. After the last key it waits for an animation frame, then
   records the buffer and the cursor (the selection head, in UTF-16 code
   units: `"unit": "utf16"`).
4. **On a mismatch** (or if the step ends outside Normal mode, with several
   cursors, or with the editor unfocused), puts the editor back into the
   expected state before the next step: presses `<Esc>` to close an open
   prompt, sends `<Esc>` through `Vim.handleKey` to leave Insert or Visual mode,
   stops a recording, and replaces just the differing part of the buffer and
   the cursor. The correction is recorded in the undo history, merged into the
   step's own last change (or as a change of its own if the step changed
   nothing), so that a later `u` goes back to the state before the step, as it
   would have if the step had been right.
5. If a step doesn't finish within 10 seconds (CodeMirror's vim mode can't be
   interrupted, and e.g. `999999999@a` with a macro that never fails loops for a
   long time), records an `error`, opens a new page and continues the test from
   the step's expected state.

The platform is reported as Linux (`navigator.platform`), because CodeMirror
and the plugin choose key bindings from it: on macOS, CodeMirror's
`defaultKeymap` adds Emacs-style CTRL bindings that apply in Insert mode (and
to CTRL keys Vim mode doesn't map). Only two steps differ: with
`--platform mac`, Insert-mode `<C-H>` deletes a character and `<C-Left>`
doesn't move by words.

Result records carry some diagnostics that `vimunit report` ignores:
`endMode` (the step ended in Insert/Replace/Visual mode, with the command line
open, with pending keys or while recording), `message` (a notification the
plugin showed, e.g. `Not an editor command ":1m$"`), `pageErrors` (uncaught
exceptions, e.g. from the regex translation), `selections`, `focusLost`, and
`loneSurrogates` (see limitations).

Running the driver by hand, after `run.sh` has set things up:

```sh
cd ~/src/vimunit-integrations/codemirror-vim
node vimunit-driver/driver.mjs --tests vimunit-driver/tests.json \
  --page packages/codemirror-vim/vimunit/dist/index.html --out /tmp/r.jsonl \
  [-k REGEX] [--platform linux|mac] [--key-interval MS] [--step-timeout MS] [--headed]
```


Options
-------

Mapped onto the editor:

| Option | How |
|--------|-----|
| `tabstop` | `EditorState.tabSize` |
| `shiftwidth`, `expandtab` | `indentUnit`: `shiftwidth` spaces with `expandtab`, else `shiftwidth/tabstop` tabs |
| `wrap` | `EditorView.lineWrapping` |
| `linebreak` | off: CSS `line-break: anywhere` so lines fill to the last column; on: CodeMirror's own word wrapping |
| `textwidth` | `Vim.setOption('textwidth')` (used by `gq`; there's no automatic wrapping) |
| `undolevels` | `history({minDepth})` |
| `magic` | `:set nopcre` (Vim regular expression syntax) for every test |

Everything else is fixed. A test that declares a value other than these is
skipped: `startofline`, `autoindent`, `wrapscan`, `ignorecase` and `smartcase`
(`/` and `?` always ignore case with smartcase, `*` and `#` ignore case),
`nrformats=bin,octal,hex` (CTRL-A reads a leading 0 as octal),
`whichwrap=` (`<Space>` and `<BS>` are `l` and `h`), `sidescroll=1`, and the
baseline value of all the other options (`scrolloff=0`, `softtabstop=0`,
`nosmarttab`, `noshiftround`, `formatoptions=tcq`, `nojoinspaces`, ...).
`foldenable` is treated as off: there are no marker or manual folds.

Also skipped:

* `shiftwidth` not a multiple of `tabstop` with `noexpandtab`: CodeMirror's
  indent unit is all tabs or all spaces, so it can't mix them like Vim.
* Tests with `:definition`s: no go-to-definition.
* Tests with folding options, or with fold markers in the buffer (with the
  baseline `foldmethod=marker`).

Window-dependent tests (`:window`) are run: with the text area sized in
character cells, wrapping, `gj`/`gk`, `H`/`M`/`L` and `CTRL-D` near the end of
the buffer behave as in Vim, so failures there are the editor's.


Limitations
-----------

* Keys are typed as fast as the browser takes them. CodeMirror's undo history
  joins adjacent changes made within 500 ms, so the result can depend on
  typing speed: with `--key-interval 1000` (the clock runs 1 s ahead per key,
  without waiting) 9 more steps fail, all undoing an Insert-mode session that
  is then split into several undo steps.
* Characters outside the BMP are typed as one key with a two-unit `key`, which
  the plugin turns into a `<😀>` key name, so `f😀` and `r😀` do nothing. Real
  emoji input (an emoji picker or IME) doesn't fare better: the plugin ignores
  text input longer than one UTF-16 unit in Normal mode.
* Commands that split a surrogate pair leave half of it in the buffer.
  `vimunit report` can't decode such a line, so it is recorded as U+FFFD (one
  UTF-16 unit too, so the column is unaffected); the record gets
  `"loneSurrogates": true`. The step fails either way.
* `<Tab>` is bound to `insertTab`. An application may bind it differently
  (`indentWithTab` is common); since the plugin doesn't map `<Tab>` in Normal
  mode, what Normal-mode `<Tab>` does depends on that binding.
* `vimunit report` reads the suite from disk after the run, so tests added
  while it runs show up as missing steps.


Latest results
--------------

2026-11-02, suite of 953 tests (2620 steps):

```
== codemirror-vim
  level0        9/13   tests     20/26    steps
  level1       39/56   tests    147/169   steps  (1 skipped)
  level2       60/89   tests    249/299   steps  (5 skipped)
  level3       84/176  tests    332/512   steps  (78 skipped)
  level4       83/247  tests    345/655   steps  (49 skipped)
  level5       54/225  tests    254/557   steps  (52 skipped)
  level6       17/93   tests    118/282   steps  (45 skipped)
  side          2/54   tests      4/120   steps  (111 skipped)
  total       348/953  tests   1469/2620  steps
  compliance level: none
```

138 tests are skipped, mostly for declaring `noignorecase` (24), folding
(21), a `shiftwidth` CodeMirror can't express with tabs (15), `formatoptions`
other than `tcq` (14), `nrformats=bin,hex` (13) and `:definition`s (10).

The main kinds of failure (see the report for every step):

* **Commands that should fail don't.** `j` on the last line goes to the end of
  the line and `k` on the first to the start (deliberately, in `moveByLines`),
  so `dj`/`dk` there delete, `kl` lands in the wrong column, and macros that
  rely on `j` failing never stop: `qaA;<Esc>j@aq` appends hundreds of `;`,
  `100@a` runs 100 times, and running the recursive macro again doesn't finish
  within the adapter's 10-second timeout (the one `error` in the results).
  `5dd` with fewer lines left, `2D` on the last line and `:2,9d` past the end
  all do something instead of failing.
* **Columns are UTF-16 code units, not characters or screen cells.** `j`/`k`
  keep a character index, not a screen column, so tabs and double-width
  characters throw them off; `|` counts characters. `l`, `h`, `x` step into
  surrogate pairs (`2l` over emoji, `xp` on an emoji leaves halves), and
  combining marks are separate characters for `l`, `x`, `r`, `~` and `s`.
  `w`/`e`/`b` treat a run of CJK text as one word (no character classes).
* **Cursor placement after commands.** `P` leaves the cursor one past the put
  text; `yh`, `y0`, `yk`, `yiw` don't move the cursor to the start; undoing
  `dd` puts the cursor on the end of the line above; `:d` leaves it in column
  0 rather than on the first non-blank; `~` with a count goes past the end of
  the line.
* **Undo granularity.** An Insert-mode session with `<CR>` in it is several
  undo steps (`<CR>` starts a new history event), undoing `o` leaves the new
  empty line, and undo grouping depends on typing speed (above).
* **Linewise/charwise edge cases.** `v$` doesn't include the line break,
  `vd` on an empty line doesn't delete it, `Vjc` deletes the lines without
  leaving one to type into, `2dw`/`2de` over whole lines aren't linewise, `J`
  adds a space before `)` and after a trailing tab.
* **Insert mode.** Autoindent isn't removed from a line left empty; `O` copies
  the indent of the line above; `<C-W>`/`<C-U>` don't stop at the start of the
  insert; `<C-A>`, `<C-@>`, `<C-E>`, `<C-Y>`, `<C-K>` digraphs, `<C-V>` with a
  code and `<C-R><C-R>` aren't implemented (unmapped CTRL keys fall through to
  CodeMirror's keymap: `<C-A>` selects all, `<C-Y>` redoes); `<Home>` goes to
  the first non-blank; `<Left>`/`<Right>` wrap across lines; an arrow key
  doesn't end the insert, so `3ifoo<Left>X` repeats the wrong text. Replace
  mode `<BS>` doesn't restore the replaced characters.
* **Search and the command line.** `<NL>` (CTRL-J) doesn't execute the command
  line; search offsets (`/foo/e`, `d/foo/+1`) aren't supported; many Vim regex
  atoms (`\%u`, `\_.`, `\_s`, `\=`, `\a`, `\u`, `\l`, `\k`, `\z`,
  `[[:upper:]]`) become invalid JavaScript regexes, which throws and leaves the
  prompt open; `?` from inside a match goes to the previous match.
* **Missing commands.** `:m`, `:t`, `:co`; `g_`, `{count}%`, `gp`/`gP`,
  `]p`/`[p`, `gR`, `g;`/`g,`, `gm`/`gM`; `!` filters; Visual mode with a count
  (`1v`, `2V`). Normal-mode `<Tab>` isn't CTRL-I: it falls through to the
  editor's `Tab` binding (here it inserts a tab).
* **Scrolling.** `CTRL-E`/`CTRL-Y` leave the cursor past the end of a short
  line and can't scroll past the end of the buffer; `CTRL-F`/`CTRL-B` move the
  cursor by a whole window height, keeping its column, instead of scrolling by
  two lines less and going to the first non-blank.
