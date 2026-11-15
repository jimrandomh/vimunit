# The `.vimunit` test format

A test is a starting buffer and cursor position, followed by one or more
steps. Each step is a sequence of keystrokes and the buffer and cursor
position expected afterwards. This document is the specification; if you are
hooking up an editor, you will probably prefer to consume the JSON export
described in [integrating.md](integrating.md), which has already been parsed
and normalized.

```
# Comments start with '#' in the first column.

:start Motion w (next word)
:set startofline
	Lo|rem ipsum-dolor
	sit amet
:type w
	Lorem |ipsum-dolor
	sit amet
:type 2w
	Lorem ipsum-|dolor
	sit amet
:end
```

## Files

* Test files are UTF-8 with LF line endings and have the extension
  `.vimunit`.
* They live in `level0/` through `level5/` (see the compatibility levels in
  the [README](../README.md)). Within a directory, files are grouped by
  feature.
* Outside of tests, a file may contain only blank lines and comments.

## Tests

A test starts with a line `:start <description>` and ends with a line `:end`.
The description must be unique within its file. A test's **id** is its file's
path relative to the repository root, a colon and a space, and the
description: `level1/wordwise.vimunit: Motion w (next word)`.

Inside a test, in order:

1. Zero or more **header directives** (`:set`, `:window`, `:definition`,
   `:xfail`, `:cursor`), described below.
2. The **initial buffer**.
3. One or more **steps**, each a `:type` line followed by the expected buffer.

Lines beginning with `#` are comments anywhere inside a test.

### Buffers

A buffer is written as consecutive lines, each beginning with a tab character
which is not part of the text. A completely empty line in a test is an empty
buffer line. (So, inside a test, blank lines are never ignored.) Every other
character, including trailing whitespace and further tabs, is part of the
text.

Exactly one `|` in each buffer marks the cursor: the cursor is on the
character immediately after the `|`. On an empty line, the `|` is the line's
only content. Since steps end in Normal mode, the cursor is always on a
character, or on an empty line; the `|` is never at the end of a non-empty
line.

The `|` is not part of the text, so a buffer can't contain a literal `|`
unless the test picks a different marker with `:cursor`.

A buffer always has at least one line. The final line of the buffer does not
have a trailing newline in the text model; i.e., a buffer `\tfoo|` is one line
containing `foo`.

### Steps

```
:type <keys>
```

The keys are typed, in order, as if by a user at a keyboard. Then the buffer
and cursor are compared with the expected buffer that follows.

* Every step **starts and ends in Normal mode**. A step may pass through any
  other mode, but must return to Normal mode (usually with `\<Esc>`). A step
  ending in Insert, Visual or Operator-pending mode, or while a macro is being
  recorded, is malformed.
* Keys are **typed one at a time**, as by a person at normal typing speed:
  each key is completely processed before the next one arrives. (This is
  observable: with keys queued in advance, Vim inserts typed-ahead text in one
  piece, which moves the `'.` mark, and skips showing the completion menu,
  which changes what `CTRL-Y` does.)
* Keys are typed, not executed as a mapping or macro. If a command fails
  (rings the bell, or gives an error such as "pattern not found"), it is
  abandoned, along with any pending count, register or operator, and **the
  following keys are still processed**. This is what happens when a user types
  the same keys. (A failure does abort a macro being executed with `@`, and
  tests rely on this.)
* State carries over from one step to the next within a test: undo history,
  registers, marks, the jump list, the last search, the last `f`/`t`, the last
  change for `.`, Visual mode's last selection, the scroll position, and
  option changes made by the keys. Only the buffer text and cursor position
  are compared.
* If a step doesn't produce the expected state, a harness may reset the buffer
  and cursor to the expected state and continue with the next step, so that
  later steps can still be checked. Later steps in the same test may still
  fail as a consequence (for example, the undo history will differ).

If a `:type` line is not followed by a buffer, the expected state is not yet
known; `./vimunit fill` fills it in by running the step in Vim.

### Initial state

Each test starts in a fresh editor, as if the initial buffer had just been
read from a file, with the cursor placed at the marked position:

* Normal mode, with no pending count, register or operator.
* No undo history; nothing to repeat with `.`.
* All registers empty. No marks set. Empty jump list and change list. No
  previous search pattern, `f`/`t` target, substitution, or macro.
* The baseline options, with the test's `:set` directives applied.
* The window is scrolled to the top: the first line of the buffer is at the
  top of the window, and it is not scrolled horizontally. Tests that depend
  on the scroll position start with the cursor within the first screenful.

## Keys

In a `:type` line, every character (after the space following `:type`) is one
key, except for backslash, which begins an escape:

| Escape      | Meaning                                                  |
|-------------|----------------------------------------------------------|
| `\<name>`   | A special key, in Vim's `<>` notation; case-insensitive. |
| `\\`        | A literal backslash.                                     |

Non-ASCII characters are typed as single keys. A trailing space is
significant, but easily lost, so tests write `\<Space>` instead.

Special key names:

| Name(s)                                   | Key                                  |
|-------------------------------------------|--------------------------------------|
| `Esc`, `C-[`                              | Escape                               |
| `CR`, `Enter`, `Return`, `C-M`            | Enter                                |
| `NL`, `C-J`                               | Linefeed (CTRL-J)                    |
| `Tab`, `C-I`                              | Tab                                  |
| `BS`                                      | Backspace                            |
| `Del`                                     | Delete                               |
| `Insert`                                  | Insert                               |
| `Up`, `Down`, `Left`, `Right`             | Arrow keys                           |
| `Home`, `End`, `PageUp`, `PageDown`       |                                      |
| `S-Up`, `S-Down`, `S-Left`, `S-Right`, `S-Tab` | Shifted keys                    |
| `C-Left`, `C-Right`, `C-Home`, `C-End`    | Control with special keys            |
| `C-A` ... `C-Z` (except `C-I`, `C-J`, `C-M`) | Control characters                |
| `C-]`, `C-\`, `C-^`, `C-_`                | Control characters                   |
| `Nul`, `C-@`                              | CTRL-@                               |
| `F1` ... `F12`                            | Function keys                        |
| `Space`, `lt`, `gt`, `Bslash`, `Bar`      | The characters ` `, `<`, `>`, `\`, `\|` |

`C-H` (CTRL-H) and `BS` are different keys, as they are in Vim, although they
usually do the same thing.

In the JSON export, keys are given as a list of tokens: either a single
character, or one of the canonical names above in angle brackets (`<Esc>`,
`<CR>`, `<C-V>`, `<S-Tab>`, ...). Named printable characters (`<Space>`,
`<lt>`, ...) become plain one-character tokens, and aliases are mapped to their
canonical names (`<C-[>` becomes `<Esc>`).

## Header directives

### `:set`

```
:set shiftwidth=4 expandtab noautoindent
```

Sets options for the test, using the syntax of Vim's `:set`: `name` or
`noname` for boolean options, `name=value` for number and string options
(write `\ ` for a space in a value). Only full option names are allowed, and
only the options in the table below.

Options not set by the test have their **baseline** value. The baseline is
Vim's default, except where noted. Tests also declare options when they merely
*depend* on the baseline value of one that commonly varies between editors
(`:set startofline` in a test of `G`); `./vimunit lint --deep` finds tests
that need such a declaration. An editor that can't emulate an option value a
test declares should skip that test rather than fail it.

<!-- BEGIN OPTIONS TABLE (generated by ./vimunit options --markdown) -->
| Option | Baseline | Description |
|--------|----------|-------------|
| `wrap` | on | Long lines wrap onto further screen lines. |
| `linebreak` | off | Wrap at a character in 'breakat' rather than at the last column. |
| `breakindent` | off | Wrapped screen lines are indented like the start of the line. |
| `showbreak` | (empty) | String shown at the start of wrapped screen lines (takes up columns). |
| `scrolloff` | `0` | Minimum number of lines kept above and below the cursor. |
| `sidescroll` | `0` | Columns to scroll horizontally when the cursor leaves the screen (nowrap). |
| `sidescrolloff` | `0` | Minimum number of columns kept left and right of the cursor (nowrap). |
| `scrolljump` | `1` | Minimum lines to scroll when the cursor moves off the screen. |
| `scroll` | `0` | Lines scrolled by CTRL-D and CTRL-U; 0 means half the window height. |
| `smoothscroll` | off | Scroll by screen lines rather than buffer lines. |
| `startofline` | on | Commands like G, gg, dd, CTRL-D move the cursor to the first non-blank. (Neovim's default is off.) |
| `tabstop` | `8` | Width of a tab character. |
| `shiftwidth` | `8` | Width of one level of indentation for >, <, CTRL-T, CTRL-D, autoindent. |
| `softtabstop` | `0` | Number of columns that <Tab> and <BS> act on in Insert mode. |
| `expandtab` | off | Insert spaces instead of tabs. |
| `smarttab` | off | <Tab> at the start of a line inserts 'shiftwidth'. (Neovim's default is on.) |
| `shiftround` | off | Round indentation from > and < to a multiple of 'shiftwidth'. |
| `autoindent` | on | New lines copy the indent of the current line. (Differs from Vim's default, which is off.) |
| `copyindent` | off | Autoindent copies the existing indent characters exactly. |
| `preserveindent` | off | Changing indent preserves existing indent characters. |
| `smartindent` | off | Simple C-like automatic indenting after { and before }. |
| `cindent` | off | C indenting rules (with default 'cinoptions'). |
| `textwidth` | `0` | Maximum line width for automatic wrapping and gq; 0 disables. |
| `wrapmargin` | `0` | Wrap this many columns from the right edge of the window when 'textwidth' is 0. |
| `formatoptions` | `tcq` | Flags controlling automatic formatting. (Neovim's default is tcqj.) |
| `comments` | `s1:/*,mb:*,ex:*/,://,b:#,:%,:XCOMM,n:>,fb:-` | Comment leaders recognized by formatting and J with formatoptions+=j. |
| `commentstring` | `/* %s */` | Template for a comment, used by zf to add fold markers. (Neovim's default is empty.) |
| `joinspaces` | off | J inserts two spaces after '.', '?' and '!'. (Differs from Vim's default, which is on.) |
| `nrformats` | `bin,hex` | Number formats recognized by CTRL-A and CTRL-X. (Differs from Vim's default, which includes octal.) |
| `tildeop` | off | ~ behaves like an operator. |
| `delcombine` | off | x deletes only the last combining character of a character. |
| `backspace` | `indent,eol,start` | What <BS> can delete in Insert mode. (Differs from Vim's default, which is empty.) |
| `whichwrap` | `b,s` | Which keys move across line boundaries. |
| `virtualedit` | (empty) | Allow the cursor where there is no character. |
| `selection` | `inclusive` | Whether the character under the cursor is part of a Visual selection. |
| `selectmode` | (empty) | When to start Select mode instead of Visual mode. |
| `keymodel` | (empty) | Whether shifted special keys start a selection. |
| `iskeyword` | `@,48-57,_,192-255` | Characters that make up a word (for w, b, e, *, iw, ...). |
| `matchpairs` | `(:),{:},[:]` | Pairs of characters that % jumps between. |
| `cpoptions` | `aABceFsz` | Vi-compatibility flags. The 'z' flag enables the cw and d special cases. |
| `undolevels` | `1000` | Maximum number of changes that can be undone. |
| `jumpoptions` | (empty) | Jumplist behavior. (Neovim's default is clean.) |
| `ignorecase` | off | Ignore case in search patterns. |
| `smartcase` | off | Override 'ignorecase' when the pattern contains uppercase letters. |
| `wrapscan` | on | Searches wrap around the end of the buffer. |
| `magic` | on | Special characters in patterns ('magic'). |
| `gdefault` | off | :substitute replaces all matches in a line by default. |
| `incsearch` | off | Show matches while typing a search pattern. |
| `complete` | `.` | Where CTRL-N and CTRL-P look for completions. (Differs from Vim's default, to keep tests self-contained.) |
| `completeopt` | `menu` | Insert-mode completion behavior. |
| `infercase` | off | Adjust the case of completed words. |
| `foldmethod` | `marker` | Fold method: marker or manual only. (Differs from Vim's default, which is manual.) |
| `foldmarker` | `{{{,}}}` | Fold start and end markers. |
| `foldlevel` | `0` | Folds deeper than this are closed. |
| `foldenable` | on | Folds are in effect. |
| `foldopen` | `block,hor,mark,percent,quickfix,search,tag,undo` | Commands that open closed folds when the cursor moves into them. |
| `foldclose` | (empty) | Close folds automatically when the cursor leaves them. |
| `foldminlines` | `1` | Minimum lines a fold must span to be closed. |
| `foldnestmax` | `20` | Maximum nesting of folds. |
<!-- END OPTIONS TABLE -->

These settings are fixed for every test and can't be changed: a single window
with no line numbers, sign column, fold column or status line; `encoding` is
UTF-8; `ambiwidth=single`; `emoji` is on (emoji are two columns wide); no
mappings, abbreviations, autocommands, plugins or filetype; the system
clipboard is not used by the unnamed register.

### `:window`

```
:window 40x10
```

The size of the window's text area, in columns and lines. The default is
80x24, and the minimum is 12x2. Tests whose results depend on the window size (screen-line motions like
`gj`, scrolling, `H`/`M`/`L`, `gq` with `textwidth=0`) must give it, along
with the options that affect wrapping (`wrap`, `linebreak`, ...) if they
differ from the baseline.

### `:definition`

```
:definition helper 12:5
```

Says that the definition of the identifier `helper` is at line 12, column 5
(both 1-based, the column counting characters) of the buffer. This stands in
for what a language server or tags file would provide; parsing source code to
find definitions is out of scope.

The reference harness exposes definitions as tags, so `CTRL-]` on a keyword
jumps to its definition, pushing the tag stack and the jump list; `CTRL-T`
and `CTRL-O` jump back. An editor that implements go-to-definition through a
language server should answer definition requests for the test from this
metadata.

Positions refer to the buffer at the time of the jump, so tests shouldn't
insert or delete lines above a definition before jumping to it.

### `:xfail`

```
:xfail nvim Neovim maps Y to y$ (see :help Y-default)
```

The test is expected to fail in one of the reference editors (`vim` or
`nvim`), for the given reason. This is only for cases where Vim and Neovim
disagree; the expected states follow whichever one is considered correct.
Editor-specific expectations for other editors belong in their integration,
not in the test files.

### `:cursor`

```
:cursor ^
	if (a |^| b)
```

Use a different character as the cursor marker in this test, so that `|` can
appear in the text. The marker must be a single character other than tab,
space, `#` or `:`.

## Folding

Folds are marker-based: lines containing `{{{` and `}}}` (optionally followed
by a level number) start and end folds, and with the baseline `foldlevel=0`
all folds start out closed. Language-aware folding and fold summaries are out
of scope. Since the fold state isn't part of the compared state, tests observe
it through its effect on motions and operators (for example, `j` moves over a
closed fold, and `dd` on a closed fold deletes all of it).

## Unicode

Test files are UTF-8, and any text can appear in buffers and keys. In the JSON
export, cursor columns are given in Unicode code points, UTF-8 bytes and UTF-16
code units. The cursor is always at the start of a character; a base character
together with its combining characters counts as one character for the
purposes of cursor movement, as in Vim.

In scope: precomposed and combining characters, double-width (East Asian)
characters, and characters outside the Basic Multilingual Plane, as they
interact with motions, operators, and line wrapping.

Out of scope: right-to-left and bidirectional text, encodings other than
UTF-8, zero-width characters (including joiners and variation selectors),
malformed UTF-8, and byte-order marks.
