# Pseudotests

## `pseudotest-meta` Pseudotest Bookkeeping

This is a "pseudotest". A pseudotest is sort of like a unit test, except
instead of something that can run automatically, it's English markdown in a
.test.md file, meant to be read and considered by an AI agent. This pseudotest
is inside the `vimunit` test suite, at level 0. If you're reading it, you might
be an agent that's working on integrating vimunit with some text editor or
text-editor-adjacent thing.

You will want some sort of system (which could just be a notes file or memory
file) for keeping track of which pseudotests you've looked at, which ones have
work that still needs doing, and which ones need your user to make decisions.

The pseudotests in `vimunit` cover a variety of things within the umbrella of
vim-compatibility that are hard to test automatically. They _also_ cover things
that aren't really about vim emulation, but rather are about what makes a good
text editor or text input in-general. Depending on your assignment, some of
them may be out of scope, in which case you should mention that you skipped
them and what they were when you report to the user.

## `vimunit-test-scaffold-architecture` Test Scaffolding

There are two formats available for the .vimunit test case files. First, there
are the .vimunit files themseles, written in an editor-test-case DSL which is
reasonably easy to read for humans and reasonably token efficient to read for
AIs. Alternatively, you can run `vimunit export -o tests.json` to get the same
tests in a JSON file, which skips having to parse the DSL. Either will work.

