vim-unit
============================

Unit Tests for Vim Imitators
by jimrandomh

Overview
--------

The vim text editor and its keyboard mapping scheme has significant advantages
for editing text, but it doesn't integrate with programming languages as well
as IDEs do. As a result, many popular editors (including VS Code, IntelliJ, Zed,
Emacs, and the editors built into web apps and terminal coding agents) have
ended up with vim emulation modes, either as first-party features or third-party
plugins. Unfortunately, the quality of these vim emulators varies widely, and
some of them implement only tiny subsets. There are a lot of subtle corner cases
in vim commands, and switching back and forth between real vim and its
pretenders can mess up muscle memory.

This is a vim keystroke compatibility test suite. It is a collection of
easy-to-integrate unit tests for the parts of vim that are commonly emulated, so
that vim emulators can improve their implementations and potential users can
quickly judge how good a vim emulator is. It's meant to be something you can
point a developer, or a coding agent, at and say "make these pass": the tests
are data, not code, so they can be run against any editor.

The test cases are organized in levels, with the most commonly used features at
lower levels and more obscure features at higher levels. A vim-emulating editor
may advertise that it is "level N vim compliant" if it passes all the test cases
up to that level. All test cases are run against the latest versions of Vim and
Neovim as references, to ensure accuracy.


What's Tested
-------------

This test suite covers vim commands, motions, operators, modes, registers,
macros, and the subtleties thereof, including how they handle Unicode text. It
does not test the parts of vim which a third-party editor is likely to replace:
multiple windows and buffers, the vimscript scripting language, opening and
closing files, syntax highlighting, or plugins. Options are tested only where
they change what commands do. All tests that depend on line wrapping or the
scroll position are at level 6, and optional feature areas such as folding are
in `side/`.


Test Format
-----------

Each test is a starting buffer and cursor position, followed by steps: some
keystrokes, and the buffer and cursor position expected afterwards. The `|`
marks the cursor. For example, to test that the `h` command moves the cursor
left, except when it's at the start of the line:

```
:start Motion h (left, single)
	L|orem ipsum
:type h
	|Lorem ipsum
:type h
	|Lorem ipsum
:end
```

Tests can also set options (`:set shiftwidth=4`), give a window size for tests
of wrapping and scrolling (`:window 40x10`), and supply go-to-definition
metadata (`:definition helper 12:5`). Every step starts and ends in Normal
mode; special keys are written like `\<Esc>`. The full specification is in
[doc/format.md](doc/format.md).


Running the Tests
-----------------

`vimunit` is a Python 3 script with no dependencies. It runs the suite against
Vim and Neovim, the reference implementations, one editor process per test
file, in parallel:

```sh
./vimunit run                    # run everything in vim
./vimunit run -e both            # in vim and neovim, and list where they disagree
./vimunit run -l 0-2 level3/macros.vimunit -k 'Macro basics'   # select tests
./vimunit fill level2/new.vimunit  # write vim's results into a new test file
./vimunit lint --deep            # find tests with undeclared option dependencies
./vimunit export -o tests.json   # the parsed suite, for other editors
./vimunit report --results r.jsonl  # score another editor's results
./vimunit options                # list options tests may set, and their baseline values
```

`./test.sh` runs the suite in vim and saves the report in `out/`.

* [doc/format.md](doc/format.md): the test file format.
* [doc/writing-tests.md](doc/writing-tests.md): how to write tests.
* [doc/integrating.md](doc/integrating.md): how to run the suite against your
  editor.


Integrations
------------

`integrations/` contains scripts that check out other editors with vim modes,
hook the suite up to their test frameworks, and run it. See each directory's
README for details, skips, and per-level results.

| Editor | Integration | Result (2026-11-02, suite of 953 tests, 2620 steps) |
|--------|-------------|-----------------------------------------|
| Vim 9.2, Neovim 0.12 | built in (`./vimunit run -e both`) | reference: all pass |
| [CodeMirror 6 vim](https://github.com/replit/codemirror-vim) (Replit, Obsidian, JupyterLab) | `integrations/codemirror-vim` | 348 tests, 1468 steps pass (138 tests skipped); not level-0 compliant |
| [VSCodeVim](https://github.com/VSCodeVim/Vim) | `integrations/vscodevim` | 523 tests, 1717 steps pass (121 tests skipped); not level-0 compliant |
| [IdeaVim](https://github.com/JetBrains/ideavim) (IntelliJ IDEs) | `integrations/ideavim` | adapter written, not yet built or run |
| [Codex CLI](https://github.com/openai/codex) composer | `integrations/codex` | adapter written, not yet built or run |

Editors whose source isn't public, such as Claude Code, can run the suite from
the JSON export; see [doc/integrating.md](doc/integrating.md).


Compatibility Levels
--------------------

Level 0
- The test framework works
- Switching between Insert and Normal mode with i and `<Esc>`
- Motions h, j, k, l, without counts
- Command dd

Level 1
- Counts with motions and commands
- Yanking and putting: x, X, y, yy, Y, p, P
- Entering Insert mode: a, A, i, I, o, O (without counts)
- Motions 0, $, ^
- Non-ASCII text (accented letters, other scripts, CJK) with the commands above

Level 2
- Word motions: w, W, b, B, e, E
- Undo and redo: u, CTRL-R
- Visual mode (v) and linewise Visual mode (V)
- Repeating changes with . (for d, x, X, p, P, i, I, a, A, o, O)
- Searching with /, ?, n, N
- Characters outside the Basic Multilingual Plane (emoji); word motions in
  non-Latin scripts

Level 3
- Replace mode: R
- Motions ge, gE
- Operators and commands: <, >, gu, gU, g~, g?, ~, r, s, S, c, C, D, J
- Macros: q, @, @@, and macros stopping at the first failing command
- Registers: "a to "z, appending with "A to "Z
- Character motions: f, t, F, T, ;, ,
- Motions %, -, +, _, `<Space>`, `<BS>`, `<CR>`, |
- Commands *, #
- Marks: m, ', `
- The special cases of dw and cw
- Combining characters; double-width characters and screen columns

Level 4
- Blockwise Visual mode (CTRL-V), including I, A, c and $
- Visual-mode commands: o, O, gv, X, Y, C, D, S, R, r, J, gJ, u, U, ~, <, >,
  p, P
- Repeating Visual-mode changes with .
- Searches as motions (d/foo), and search offsets
- Text objects: iw, aw, iW, aW, is, as, ip, ap, and the bracket, quote and tag
  objects
- Motions G, gg, {count}%, g_, (, ), {, }, [[, ]], [], ][, [(, [{, ]), ]}
- Increment and decrement: CTRL-A, CTRL-X
- Jump list and change list: CTRL-O, CTRL-I, g;, g,
- Counts with Insert-mode commands (3ifoo`<Esc>`, 2o)
- Commands gJ, gR, gp, gP, ]p, [p, gi, gI, U
- Arrow keys in Insert mode, and how they affect undo and .
- Unicode with blockwise Visual mode and text objects

Level 5
- Ex commands: :s, :d, :m, :t, :co, :j, :>, :<, :y, :pu, :normal, :g, :v,
  :sort, with line ranges and addresses
- Regular expressions in searches and :s
- Special registers: "0, "1 to "9, "-, "_, "., "/
- Special marks: `[, `], `<, `>, `., `^, ``
- Insert-mode commands: CTRL-W, CTRL-U, CTRL-H, `<Del>`, CTRL-A, CTRL-R,
  CTRL-T, CTRL-D, CTRL-E, CTRL-Y, CTRL-V, CTRL-K, CTRL-O, CTRL-N, CTRL-P
- Command-line editing
- Repeating substitutions: &, g&

Level 6
- Line wrapping and screen lines: gj, gk, g0, g^, g$, gm, gM
- Scrolling: CTRL-E, CTRL-Y, CTRL-D, CTRL-U, CTRL-F, CTRL-B, zt, zz, zb, and
  'scrolloff'
- Window-relative motions: H, M, L
- Formatting: gq, gw, and automatic wrapping with 'textwidth'
- Filtering through an external program: !, !!
- Forcing a motion to be charwise, linewise or blockwise: dv, dV, d CTRL-V
- Visual mode with a count
- Unicode and line wrapping

Side branches (`side/`)
- Folding, with fold markers
- Indentation options: expandtab, softtabstop, smarttab, shiftround,
  smartindent
- Comments: continuing comment leaders, joining and formatting comments
- Go to definition, with CTRL-], CTRL-T, gd and gD
