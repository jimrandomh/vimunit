vimunit: Fixing the World's Vim Imitations
============================
Unit Tests for Vim Imitators
by jimrandomh

The vim text editor's keybindings are widely copied; every major IDE has a
vim-imitation plugin or mode, as do Codex, Claude Code, and even EMACS.
However, for a power user with muscle memory for obscure vim commands, the
coverage and quality of these implementations is largely mediocre. This
project, vimunit, aims to fix that.

This project grew out of the unit test suite if Vanadium, a (currently
unpublished) vim-like editor which I wrote starting in 2016 and have been
daily-driving ever since. It is a test suite of behaviors for vim-like editors;
the intention is that any editor or editor-plugin with a vim-emulation mode
should be able to adopt it into its unit test suite, have an AI agent work on
it, and wind up with something that is close to "keystroke compatible"; that
is, a vim power user with muscle memory will find that their muscle-memory
commands still work as expected.


Philosophy
----------
This project, by its nature, contains a lot of opinion about how text editors
ought to work. I have done my best to ensure that those opinions are good
opinions, informed by experience writing and using vim-like editor of my own.
I have also done my best to ensure that these are _human_ opinions. There is no
AI-generated text in this README, or in pseudotest files (but READMEs and
code comments in integrations/ and doc/ may be AI-written). Many of the
structured tests are AI-generated, but all of them have been through a nonzero
amount of human review.

These tests are a starting point and you don't have to implement all of this
literally. If you disagree with the behavior described by some of the tests,
you should implement the behavior you think is best, not what the tests say.
You can still describe your project as passing the vimunit test suite up to
some level, as long as the divergences are deliberate opinions about how an
editor ought to work, rather than just being things that were hard to implement
or that no one has looked at.


Test Format
-----------
Most tests consist of a starting file state, and alternate between providing
some keystrokes to replay, and a new file state. Buffer states are indented by
one tab, and use a pipe (`|`) to mark the cursor position (the literal |
character does not appear in the expected buffer contents of any test). For
example, a simple test of the `h` (cursor left) command would look like this:

```
:start Motion h (left)
	L|orem ipsum
:type h
	|Lorem ipsum
:type h
	|Lorem ipsum
:end
```

Tests can also set options, controlling the window size for line-wrapping,
user-configurable or language-specific options like tab size, information that
would have come from a language server. Further details are in
[doc/format.md](doc/format.md).


Pseudotests
-----------
There are some things that an AI agent should be able to check without much
difficulty, but which don't fit the test format above and are harder to
automate. These are written in English in `.test.md` files, with free markdown
text interspersed with lines for "test cases", each of which is marked with a
heading that starts with `pseudotest-name`. For example:

```
    # General text editor best practices

    You can't be a good vim-like text editor without being a good text editor;
    while not strictly vim-keybinding-related, you should do your best to
    ensure that:

    ## `atomic-writes` Files are saved atomically

    There may be tools watching files for changes, eg a dev server that
    hot-reloads modules or a language server that maintains an index of
    definitions and usages. Outside of uncommon special cases, saving changes
    to a file should work by creating a new file, and renaming it into place,
    so that these tools never see a half-written file.
```

Pseudotest names are meant to be usable for keeping notes about what has been
checked. The names of pseudotests are unique across the test suite, and if the
contents of a pseudotest change substantially between versions, it will be
renamed. Pseudotests do _not_ necessarily make sense if you read only the block
underneath the heading; there may be necessary context elsewhere in the same
file, so any subagents should receive the whole file, not just a slice.


Compatibility Levels
--------------------
The tests here are organized into levels. The idea is that, when working on a
vim mode for an editor, you start at level 0 and go up, and when you have everything
in a level passing (or disagreeing on purpose), you can describe your editor as
"level 3 vim compatible".

## Level 0: Hooked Up the Test Suite

Level 0 basically tests that you've gotten the unit test suite working. It's a
small number of tests, of things that any vim-like editor will definitely have,
in uncomplicated situations. Covers:

 * Switching between Insert and Normal mode with i and `<Esc>`, and inserting ASCII text
 * Motions `h`, `j`, `k`, `l`, without counts, and command `dd`

## Level 1: The Very Basics

Level 1 is a narrow set of commands and motions, under uncomplicated
circumstances, roughly corresponding to the minimum set of things that would
make a text editor recognizably vim-like.

 * Counts with motions and commands
 * Yanking and putting: `x`, `X`, `y`, `yy`, `Y`, `p`, `P`
 * Variations on insert mode: `a`, `A`, `i`, `I`, `o`, `O` (without counts)
 * Common motions: `0`, `$`, `^`, `w`, `W`, `b`, `B`, `e`, `E`

## Level 2: Most of Vim

Level 2 covers the parts of a vim mode that are reasonably isolated from
broader editor concerns, without worrying about configuration differences, line
wrapping, or language-specific features. There are quite a lot of features in
this level, but they are all relatively shallow.

Excluded:
 * Line wrapping, lines longer than 60 characters, and anything sensitive to the size of the window
 * Anything involving programming-language-specific syntax awareness
 * Autoindent, and indentation handling in general
 * Ex mode (ie commands that start with typing a `:`)
 * External programs
 * Anything involving multiple files open at once
 * Unicode and character-set issues
 * Folding
 * Complex cases of undo/redo (eg undo branches, undo-line)
Included:
 * Most commands, motions, and modes
 * Undo/redo (in the straightforward cases)
 * Repeating commands: `.`, `q`, `@`, `@@`
 * Modes: Visual (`v`), linewise Visual (`V`), replace (`R`)
 * Searching with /, ?, n, N, *, #
 * Motions `ge`, `gE`, `f`, `t`, `F`, `T`, `;`, `,`, %, -, +, _, `<Space>`, `<BS>`, `<CR>`, |
 * Operators and commands: `gu`, `gU`, `g~`, `g?`, `~`, `r`, `s`, `S`, `c`, `C`, `D`, `J`, `gJ`
 * Registers and marks

# Level 3: Real Editor

Level 3 expands on level 2 by adding harder things and config-sensitive things:
line wrapping, Unicode, indentation, and some ex-mode commands. These tests are
sensitive to the window width, tab size, line wrapping rules, and other
subtleties that have legitimate variation between editors; the tests have
configuration options embedded in them.

Covers:
 * Line-wrapped motions: gj, gk
 * Unicode: Multi-byte and multi-codepoint glyphs are counted as a single character for motions, and a single column for wrapping
 * Motions interact correctly with tabs
 * Rewrapping lines with `gq`
 * Autoindent behaves reasonably (pseudotest, since there is not widespread agreement on what should happen when you press <Enter>)
 * Block visual mode

# Level 4: Fanciness

Level 4 is for things that aren't going to apply to every editor, correspond to
features that aren't universal, or have seriously nonobvious requirements. Each
subsection is independent.

 * Folding (commands for opening/closing/traversing, and interactions between closed folds and motions/commands. Doesn't test automatic generation from syntax, or summary line appearance)
 * Language-based navigation (jump to declaration/reference and similar things, with an index provided, in place of an LSP)
 * Scale: Programmatically generated large-file test cases, with a deadline, to test that things still work if you open a large generated file.
 * Filtering through external programs: `!`, `!!` (pseudotest)
 * Screen-relative motions
 * Split panes (pseudotest)

# Level 5: Vimscript

The very highest level of "vim-like" an editor can achieve would be to execute
a user's unmodified .vimrc and load unmodified vim plugins. In most contexts,
this is not a desired feature, and vimunit isn't trying to be a test suite for
full vimscript compatibility. This level exists in order to have somewhere to
put tests that didn't make sense to delete, and also didn't belong in any of
the other levels, 


Tooling
-------
`vimunit` is a bundle of utilities for running the tests against reference
implementations (vim and neovim), checking tests for unmarked
configuration-setting dependencies (eg, a test depends on tab size but doesn't
have a tab size specified), populating incomplete tests with results based on a
reference editor, and converting the tests into other formats like JSON. See
`./vimunit --help` for details.

The `integrations/` directory contains scripts that check out some other
editors that have vim modes, and tests them. See the README in each for
details.


