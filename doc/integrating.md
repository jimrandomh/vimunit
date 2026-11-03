# Running the suite against your editor

To test an editor's Vim mode, you write an *adapter*: a small program, usually
in the editor's own language and test framework, which reads the suite in
JSON, runs each test in the editor, and writes down what happened. The
`vimunit` script then scores the results.

```sh
./vimunit export -o out/tests.json            # 1. the suite, parsed and normalized
your-adapter out/tests.json > out/results.jsonl   # 2. run it in your editor
./vimunit report --results out/results.jsonl  # 3. score it
```

`integrations/` has adapters for several editors, each with a script that
checks out the editor's source, applies a patch to add the adapter, builds it,
and runs the suite. They are worked examples of everything below.

## The export

`./vimunit export` writes one JSON object (use `--pretty` to indent it, and
`-l`/`-k`/paths to select tests):

```jsonc
{
  "schemaVersion": 1,
  "defaultWindow": {"width": 80, "height": 24},
  "baselineOptions": {"wrap": true, "tabstop": 8, "startofline": true, ...},
  "options": [{"name": "wrap", "type": "bool", "baseline": true, "group": "display", "description": "..."}, ...],
  "specialKeys": ["<BS>", "<C-A>", "<CR>", "<Esc>", ...],
  "tests": [
    {
      "id": "level2/wordwise.vimunit: Motion w (next word)",
      "file": "level2/wordwise.vimunit",
      "line": 3,                       // of the :start line
      "group": "level2",               // or "side"
      "level": 2,                      // null for side branches
      "feature": "wordwise",
      "description": "Motion w (next word)",
      "options": {"startofline": true},// only the options the test sets
      "window": {"width": 80, "height": 24},
      "windowSpecified": false,        // true if the test depends on the size
      "definitions": [{"name": "helper", "line": 11, "column": 4}],  // 0-based
      "initial": {
        "lines": ["Lorem ipsum-dolor--", "sit amet consectetur."],
        "cursor": {"line": 0, "column": 2, "byteColumn": 2, "utf16Column": 2}
      },
      "steps": [
        {
          "line": 6,                   // of the :type line
          "keys": "2w",                // as written in the test file
          "keyTokens": ["2", "w"],
          "expected": {"lines": [...], "cursor": {...}}
        }
      ]
    }
  ]
}
```

Lines and columns are 0-based. Cursor columns are given in Unicode code points
(`column`), UTF-8 bytes (`byteColumn`) and UTF-16 code units (`utf16Column`);
use whichever your editor does natively.

`keyTokens` are single characters (which may be non-ASCII, and may be outside
the BMP), or a special key in angle brackets from `specialKeys`: `<Esc>`,
`<CR>`, `<NL>`, `<Tab>`, `<BS>`, `<Del>`, `<Insert>`, `<Up>`, `<Down>`,
`<Left>`, `<Right>`, `<Home>`, `<End>`, `<PageUp>`, `<PageDown>`, the shifted
and control variants `<S-Up>` ... `<S-Tab>`, `<C-Left>` ... `<C-End>`, control
characters `<C-A>` ... `<C-Z>`, `<C-]>`, `<C-\>`, `<C-^>`, `<C-_>`, `<Nul>`,
and `<F1>` ... `<F12>`. `<CR>` is the Enter key and `<NL>` is CTRL-J.

## What the adapter does

For each test:

1. **Decide whether you can run it.** If the test sets an option your editor
   can't emulate (or sets it to a value it can't emulate), or relies on a
   window size or `:definition`s you can't provide, record every step as
   skipped with a reason. Skipping is better than failing for things your
   editor deliberately doesn't do; the report counts skips separately.

   Tests declare the options they depend on whenever the option's default
   commonly differs between editors, even if they want the baseline value. So
   if your editor has no way to change an option, decide which value its fixed
   behavior corresponds to (usually the baseline), run the tests that declare
   that value, and skip the ones that declare any other.
2. **Start fresh.** New buffer, empty undo history, empty registers, no marks,
   no previous search, `f`/`t` or `.`; Normal mode. Reusing one editor
   instance is fine if you can reset all of that.
3. **Configure.** Apply `baselineOptions`, then the test's `options`. Set the
   window's text area to `window.width` by `window.height` if your editor has
   such a thing (it matters only when `windowSpecified` is true). Make
   `definitions` available to go-to-definition, if you support it.
4. **Load the buffer**: the `initial.lines` joined with newlines, cursor at
   `initial.cursor`, scrolled to the top.
5. **For each step:** send the `keyTokens` to the Vim mode, one at a time, as
   key presses. Then record the buffer's lines and the cursor position. If
   they don't match `expected`, you may set the buffer and cursor to
   `expected` before the next step, so that later steps can still pass.

A few things that commonly go wrong in adapters, rather than in Vim modes:

* Send keys through the same path as real keyboard input. Some Vim modes
  behave differently for programmatic input (no undo grouping, no recording
  into macros, no `.` repetition).
* Send one key at a time, and let the editor finish handling each key
  (including any asynchronous work, such as updating a completion menu)
  before sending the next.
* Errors and bells must not stop the step. If a command fails, the rest of
  the step's keys are still typed (see [format.md](format.md#steps)).
* Read the cursor in your editor's native units and say which in the results
  (`unit`), rather than converting.

## Results

Write one JSON object per line, per step:

```json
{"id": "level2/wordwise.vimunit: Motion w (next word)", "step": 1, "lines": ["Lorem ipsum-dolor--", "sit amet consectetur."], "cursor": [0, 6]}
{"id": "level2/wordwise.vimunit: Motion w (next word)", "step": 2, "lines": [...], "cursor": [0, 11], "unit": "utf16"}
{"id": "side/folding.vimunit: Command zc (close fold)", "step": 1, "skipped": "folding not supported"}
{"id": "level3/macros.vimunit: Macro basics (q,@)", "step": 4, "error": "adapter threw: ..."}
```

* `id` and `step` (1-based) identify the step.
* `lines` and `cursor` (`[line, column]`, 0-based) are the state after the
  step. `unit` says what the column counts: `codepoint` (the default),
  `utf16`, or `byte`.
* `mode` (optional) is the mode the editor was left in, using the codes of
  Vim's `mode(1)`: `n` for Normal mode, `i` for Insert, `v` for Visual, `no`
  for Operator-pending, and so on. A step that doesn't end in Normal mode
  fails, whatever the buffer.
* `skipped` (a reason) marks a step that wasn't run, and `error` one that
  couldn't be completed.
* Any other fields (such as the mode the editor ended in, or messages it
  showed) are ignored when scoring, and shown alongside failures by
  `report -v`.

Steps missing from the results count as failures.

## Scoring

```sh
./vimunit report --results out/results.jsonl --name "my editor"
./vimunit report --results out/results.jsonl -v        # show each failure
./vimunit report --results out/results.jsonl -l 0-2    # only some levels
./vimunit report --results out/results.jsonl --tests out/tests.json  # score against the export the adapter ran
```

The report shows how many tests and steps pass in each level, and the
**compliance level**: the highest level N such that every test in levels 0
through N passes. An editor may advertise that it is "level N vim compliant".

## Writing an integration script

Integrations in `integrations/<name>/` follow a common layout:

* `run.sh` checks out the editor's repository at a pinned commit into
  `$VIMUNIT_SRC/<name>` (default `~/src/vimunit-integrations/<name>`), applies
  the patch, builds, exports the suite, runs the adapter, and writes
  `out/results-<name>.jsonl` and `out/report-<name>.txt` in this repository.
  It should be safe to run repeatedly.
* `adapter.patch` (or adapter source files copied in by `run.sh`) adds the
  adapter to the editor's own test framework, so it can drive the real Vim
  mode without a GUI.
* `README.md` says what's needed to run it, the pinned commit, how the
  adapter drives the editor, what it skips and why, and the latest results.
