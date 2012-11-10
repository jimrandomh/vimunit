vim-unit
============================

Unit Tests for Vim Imitators
by jimrandomh

Overview
--------

The vim text editor and its keyboard mapping scheme has significant advantages
for editing text, but it doesn't integrate with programming languages as well
as IDEs do. As a result, many popular editors (including Eclipse, MonoDevelop,
EMACS, IntelliJ, and Visual Studio) have all ended up with vim emulation modes,
either as first-party features or third-party plugins. Unfortunately, the
quality of these vim emulators varies widely, and some of them implement only
tiny subsets.  There are a lot of subtle corner cases in vim commands, and
switching back and forth between real vim and its pretenders can mess up muscle
memory.

This is a vim keystroke compatibility test suite. It is a collection of
easy-to-integrate unit tests for the parts of vim that are commonly emulated, so
that vim emulators can improve their implementations and potential users can
quickly judge how good a vim emulator is. The test cases themselves are
organized in levels, with the most commonly used features at lower levels and
more obscure features at higher levels. A vim-emulating editor may advertise
that it is "level N vim compliant" if it passes all the test cases up to that
level. All test cases are run against the latest official version of vim as a
reference, to ensure accuracy.


What's Tested
-------------

This test suite covers vim commands, motions, and the subtleties thereof. It
does not test the parts of vim which a third-party editor is likely to replace.
It does not test multiple buffers, the vimscript scripting language, opening
and closing files, syntax highlighting, vim configuration options or plugins.
All tests that depend on line wrapping, or interact with the scroll position,
are at level 6 or higher.

Some things are important, but hard to test automatically through the same test
file syntax as the main tests. These are organized into levels in
'otherTests.txt'. You may wish to write your own editor-specific unit tests for
these, or test them manually.


Using the Test Suite
--------------------

Test cases are organized into files by subject and level. Each file contains
multiple test cases, and each test begins with a line ":start <description>" and
ends with a line ":end". In between there is text to initialize the buffer with,
some keystrokes to simulate, text to expect after the keystrokes have been
simulated, more keystrokes and so on. The character '|' represents the cursor
position, and will always appear exactly once in a buffer text block and will
never be used as literal text. For example, to test that the 'h' command moves
the cursor left, except when it's at the start of the line, a test case would
look like this:

:start Motion h (left, single)
	L|orem ipsum
:type h
	|Lorem ipsum
:type h
	|Lorem ipsum
:end

Any text after the :start is a description of the test. The first tab in each
line should be ignored; it's not part of the test, it's just there to make the
test cases more readable. Every :type directive starts and ends in command mode
with a non-empty file. If special keys are pressed, they start with a backslash;
eg,
	:type iHello\<esc>
	:type \<^M>
If the keys in a single :type directive generate a bell (eg, trying to move
outside the range of the file), the rest of the :type directive is ignored; this
is used to test that the bell is triggered at the right times in level 4 tests,
and should not come up in any test in levels 0-3 (any bell-ringing command will
be the last in the :type directive).

The goal is to test corner-cases in your vim keyboard emulation, not in your
unit-test parser; the unit test files are pretty strongly normalized. The levels
are meant to cover escalating degrees of completeness and difficulty, and also
to be a sensible order in which to implement features if you're starting from
scratch.


Compatibility Levels
--------------------

Level 0
- The test framework works
- Switching between insert and command mode with i and <esc>
- Motions h,j,k,l, without modifiers
- Commands: d

Level 1
- Counts with motions and commands
- Yanking and pasting: x,X,y,Y,p,P
- Insert-mode entering commands: a,A,i,I,o,O (no counts)
- Miscellaneous motions: 0,$,^

Level 2
- Word-wise motion: w,W,b,B,e,E
- Undo history: u
- Visual and line visual modes
- Command repetition with . (for d,x,X,p,P,i,I,a,A,o,O)
- Simple search with /text
- Commands: n,N

Level 3
- Replace mode
- Motions: ge, gE
- Commands: <,>,gu,gU,g~,g?,r,R,s,S,c,C,D
- Macros
- Registers
- Letterwise motions: t,f,T,F,;,,
- Motions: %,-,+,_,space,backspace,enter,|
- Commands: J,*,#,q,@
- Marks: m,',`
- End of line corner case for dw

These levels are planned, but not yet implemented:

Level 4
- Block visual mode
- Repetition with visual mode
- Compose /text search as a motion
- Basic text objects
- Increment/decrement commands
- Bells
- Jumplist and backtracking: ^O,^I
- Insert-mode entering commands with counts
- Misc commands: gJ, gR, gp, gP, 
- Misc visual commands: X,Y,C,D,r,gu/gU/g~/g?,
- Misc motions: g_, G, gg, {count}%
- Arrow keys in insert mode (and interaction with repetition)
- Text object motions
- Text object selection

=== Level 5 ===
- Basic ex commands
- Basic regular expression search
- Special registers
- Special marks
- Insert mode commands: ^W, ^U, del, ^A, ^R, ^T, ^D, ^E, ^Y, 

=== Level 6 ===
- Basic modelines (options tabsize,shiftwidth,textwidth,wrap,wrapmargin,winheight)
      This is only for fixing values of parameters that would affect the other
      tests; emulating modeline support as part of the test framework is fine,
      and no usage besides the narrow usage found in tests need be supported.
- Line wrapping: gj, gk
- Formatting: gq
- Window scrolling commands
- Window-relative motions
      (Also tests to see if the window ever gets scrolled inappropriately, eg if
	  commands have intermediate steps and the window scrolls based on
	  intermediate cursor positions)
- Detailed regular expression search
- More ex commands
- Filter programs (!,=)
- Motion-mode modifiers
- Visual mode with a count

=== Side branches ===
- Folding
- Autoindent
- Comment extension/wrapping
