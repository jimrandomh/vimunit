# Writing tests

The format is specified in [format.md](format.md). This document is about
writing good tests, and the tools that help.

## Workflow

Vim is the reference implementation, so you don't work out expected results by
hand. Write the initial buffer and the keys, and let Vim fill in the rest:

```
:start Command x (count larger than the rest of the line)
:set startofline
	Lo|rem ipsum
:type 100x
:type x
:end
```

```sh
./vimunit fill level1/yanks.vimunit       # runs each step in vim, writes the results in
```

Then:

1. **Read every result.** Make sure each step tests what you meant it to, and
   that Vim's behavior isn't clearly broken. Vim is the ground truth for how
   commands are interpreted, but it's easy to write a test that accidentally
   exercises something other than what its description says.
2. **Check Neovim agrees:** `./vimunit run -e both level1/yanks.vimunit`. Vim
   and Neovim are both references. If they disagree, first check whether the
   test depends on an option whose default differs (see below). If it's a
   real difference in behavior, either rewrite the test to avoid it, or decide
   which editor is right and mark the test `:xfail <editor> <reason>`.
3. **Check for hidden dependencies:** `./vimunit lint --deep level1/yanks.vimunit`
   reruns the tests with commonly-varying options changed, with a different
   window size, and each test in a fresh editor. Add `:set` (or `:window`)
   declarations for the options it reports; fix tests that depend on state
   from earlier tests.
4. Run the whole suite in both editors before you finish:
   `./vimunit run -e both`.

`./vimunit fill --update` overwrites expected states that don't match Vim. Use
it with care, and read the diff.

Trailing whitespace in buffer lines is part of the test. Make sure your editor
doesn't strip it (the repository's `.editorconfig` says not to), and prefer
tests that don't depend on it unless that's the point.

## What makes a good test

**One behavior per test**, possibly in several steps. The description names
the command and what's being tested: `Command x (at end of line)`, `Motion w
(over punctuation)`. Descriptions must be unique within a file.

**Corner cases are the point.** Implementations usually get the common case
right. Most bugs and muscle-memory mismatches are in:

* counts, including zero-like cases and counts larger than what's available
  (`100x`, `5dd` with three lines left);
* the start and end of a line, and of the buffer;
* empty lines, whitespace-only lines, a buffer with one line, an empty buffer;
* tabs, and lines with leading whitespace (`^` vs `0`, cursor column after `j`);
* failure: a command that can't be carried out does nothing (and, within a
  macro, aborts it), but the keys typed after it still run;
* what a command leaves behind: where the cursor ends up, what's in the
  unnamed and numbered registers (check with `p`), what one `u` undoes, and
  what `.` repeats;
* charwise, linewise and blockwise variants of the same operation;
* the column the cursor remembers across `j`/`k` (`curswant`), and how `$`
  makes it stick to the end of the line.

**Make each step observable.** Since only the buffer and cursor are compared,
think about how to make the behavior you care about visible:

* To check where Insert mode put the cursor, type a marker character before
  `\<Esc>` (`aX\<Esc>`), since `\<Esc>` moves the cursor left.
* To check a register's contents, put it (`"ap`).
* To check a Visual selection, operate on it (`d`, `r*`, `U`).
* To check the scroll position, use `H` or `L`.
* To check a fold is closed, move over it with `j`, or delete it with `dd`.

**Keep buffers small and words distinct**, so it's easy to see where the
cursor is. Lorem ipsum works; so does code-like text when testing code-ish
commands like `%` and `[{`.

**Prefer several short steps to one long one**, so that failures point at the
problem. A step with many keys is right when the point is the interaction
between them (repeating with `.` after an insert that used arrow keys, say).

**Don't depend on anything from before the test.** Each test starts fresh:
`.`, `n`, `;`, `@@`, `p`, `gv` have nothing to work with until the test gives
them something.

## Options and window size

Tests run with the baseline options listed in [format.md](format.md). If a
test's result depends on an option whose default varies between editors
(`startofline`, `joinspaces`, `autoindent`, `smarttab`, `formatoptions`,
`nrformats`, `tabstop`, `shiftwidth`, `softtabstop`, `expandtab`, `wrap`,
`ignorecase`, `scrolloff`), declare the value it expects with `:set`, even if
that's the baseline value. This lets editors that can't emulate that value
skip the test. `./vimunit lint --deep` finds missing declarations.

Tests that depend on the window size (screen-line motions, scrolling,
`H`/`M`/`L`, wrapping) must declare it with `:window`, and should use a small
window (e.g. `:window 20x6`) with lines long enough to wrap.

## Where tests go

Put a test in the lowest level where its commands appear in the
[README](../README.md)'s list of levels, in a file named for the feature.
Optional feature areas go in `side/`. Unicode tests go in a `unicode.vimunit`
file in the level of the commands they exercise. Start each file with:

```
# This file is part of vim-unit: Unit tests for vim imitators
#
# <What this file covers.>
```

## Out of scope

* Multiple windows, buffers and tab pages; reading and writing files; the
  quickfix list; the command-line window (`q:`); Ex mode (`Q`, `gQ`).
* Vimscript, the expression register (`"=`), mappings, abbreviations,
  autocommands, plugins, `:set` of options not in the table.
* The system clipboard (`"+`, `"*`), and the `"%`, `"#` and `":` registers'
  dependence on files and history.
* Commands that run external programs, other than filtering through `sort`.
* Syntax highlighting, filetypes, language-aware indenting and folding,
  spell checking.
* Messages and the bell: only the buffer and cursor are checked.
* Mouse input, timing (`'timeoutlen'`), `CTRL-C` interrupts, `CTRL-Z`.
* Right-to-left text, non-UTF-8 encodings, zero-width characters, malformed
  UTF-8.
