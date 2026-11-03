// vim-unit adapter for @replit/codemirror-vim (CodeMirror 6), Node side.
//
//   node driver.mjs --tests tests.json --page dist/index.html --out results.jsonl
//
// Loads the bundled page (page.ts) into headless Chromium with Playwright,
// and for each test builds a fresh editor, types each step's keys as real key
// events (Chrome DevTools Protocol Input.dispatchKeyEvent, the same path as
// keyboard input: keydown/keypress/beforeinput/EditContext, so Insert-mode
// text, <CR>, <BS> and the : and / prompts are handled by CodeMirror and the
// browser exactly as when typing), and records the buffer and cursor.

import fs from "fs";
import path from "path";
import { chromium } from "playwright";

function parseArgs(argv) {
  const args = { platform: "linux", headed: false, filter: null, stepTimeout: 10000, keyInterval: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tests") args.tests = next();
    else if (a === "--page") args.page = next();
    else if (a === "--out") args.out = next();
    else if (a === "--platform") args.platform = next();
    else if (a === "--headed") args.headed = true;
    else if (a === "-k" || a === "--filter") args.filter = new RegExp(next());
    else if (a === "--step-timeout") args.stepTimeout = Number(next());
    else if (a === "--key-interval") args.keyInterval = Number(next());
    else throw new Error("unknown argument " + a);
  }
  if (!args.tests || !args.page || !args.out) {
    throw new Error("usage: driver.mjs --tests tests.json --page index.html --out results.jsonl [--platform linux|mac] [-k regex]");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Options
//
// What CodeMirror's vim mode can be configured to do, and what it does
// regardless. A test that declares an option value outside these is skipped.

// Behavior CodeMirror's vim mode has no setting for, as the Vim option value
// it corresponds to.
const FIXED = {
  breakindent: false,
  showbreak: "",
  scrolloff: 0,
  sidescroll: 1, // scrolls just enough to show the cursor
  sidescrolloff: 0,
  scrolljump: 1,
  scroll: 0,
  smoothscroll: false,
  startofline: true,
  whichwrap: "", // <Space> and <BS> are mapped to l and h, which stop at the line ends
  virtualedit: "",
  iskeyword: "@,48-57,_,192-255",
  matchpairs: "(:),{:},[:]",
  jumpoptions: "",
  softtabstop: 0,
  smarttab: false,
  shiftround: false,
  autoindent: true, // o, O and Insert-mode <CR> copy the indent (no language is loaded)
  copyindent: false,
  preserveindent: false,
  smartindent: false,
  cindent: false,
  wrapmargin: 0,
  formatoptions: "tcq",
  comments: "s1:/*,mb:*,ex:*/,://,b:#,:%,:XCOMM,n:>,fb:-",
  joinspaces: false,
  nrformats: "bin,octal,hex", // CTRL-A treats a leading 0 as octal
  tildeop: false,
  delcombine: false,
  backspace: "indent,eol,start",
  cpoptions: "aABceFsz",
  selection: "inclusive",
  selectmode: "",
  keymodel: "",
  ignorecase: true, // / and ? always ignore case, with smartcase; * and # ignore case
  smartcase: true,
  wrapscan: true,
  gdefault: false,
  incsearch: false,
  complete: ".",
  completeopt: "menu",
  infercase: false,
  foldenable: false, // no marker or manual folds
};

// Options mapped onto the editor's configuration (see editorConfig).
const EMULATED = new Set([
  "wrap", "linebreak", "tabstop", "shiftwidth", "expandtab", "textwidth", "undolevels", "magic",
]);

const FOLD_OPTIONS = new Set([
  "foldmethod", "foldmarker", "foldlevel", "foldopen", "foldclose", "foldminlines", "foldnestmax",
]);

function sameValue(a, b) {
  return typeof a === "string" || typeof b === "string" ? String(a) === String(b) : a === b;
}

function skipReason(suite, test) {
  const opts = { ...suite.baselineOptions, ...test.options };
  if (test.definitions && test.definitions.length) {
    return "go-to-definition (:definition) is not supported";
  }
  const foldsOn = opts.foldenable !== false;
  for (const [name, value] of Object.entries(test.options)) {
    if (EMULATED.has(name)) continue;
    if (FOLD_OPTIONS.has(name)) {
      if (foldsOn) return `folding is not supported (${name}=${value})`;
      continue;
    }
    if (name in FIXED) {
      if (!sameValue(FIXED[name], value)) {
        const fixed = FIXED[name];
        const shown = typeof fixed === "boolean" ? (fixed ? name : "no" + name) : `${name}=${fixed}`;
        const want = typeof value === "boolean" ? (value ? name : "no" + name) : `${name}=${value}`;
        return `can't emulate ${want} (CodeMirror vim behaves like ${shown})`;
      }
      continue;
    }
    return `unknown option ${name}`;
  }
  if (opts.magic === false) return "can't emulate nomagic";
  if (!(opts.undolevels > 0)) return `can't emulate undolevels=${opts.undolevels}`;
  const ts = opts.tabstop;
  const sw = opts.shiftwidth || ts;
  if (!opts.expandtab && sw % ts !== 0) {
    return `can't emulate shiftwidth=${sw} with tabstop=${ts} and noexpandtab (indentUnit is all tabs or all spaces)`;
  }
  if (foldsOn && opts.foldmethod === "marker") {
    const marker = String(opts.foldmarker).split(",")[0];
    if (marker && test.initial.lines.some((l) => l.includes(marker))) {
      return "marker folding is not supported";
    }
  }
  return null;
}

function editorConfig(suite, test) {
  const opts = { ...suite.baselineOptions, ...test.options };
  const ts = opts.tabstop;
  const sw = opts.shiftwidth || ts;
  const unit = opts.expandtab ? " ".repeat(sw) : "\t".repeat(sw / ts);
  const vimOptions = [["pcre", false]]; // Vim regular expression syntax ('magic')
  if (opts.textwidth > 1) vimOptions.push(["textwidth", opts.textwidth]);
  const lines = test.initial.lines;
  let anchor = 0;
  for (let i = 0; i < test.initial.cursor.line; i++) anchor += lines[i].length + 1;
  anchor += test.initial.cursor.utf16Column;
  return {
    text: lines.join("\n"),
    anchor,
    tabSize: ts,
    indentUnit: unit,
    wrap: !!opts.wrap,
    linebreak: !!opts.linebreak,
    width: test.window.width,
    height: test.window.height,
    undoDepth: opts.undolevels,
    vimOptions,
  };
}

function offsetOf(lines, line, ch) {
  let off = 0;
  for (let i = 0; i < line; i++) off += lines[i].length + 1;
  return off + ch;
}

// ---------------------------------------------------------------------------
// Keys
//
// A US keyboard layout, as Chrome reports it in KeyboardEvent key, code and
// keyCode. Characters not on it are typed as a key that produces that
// character (as on a keyboard layout that has it), with no code.

const MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4, MOD_SHIFT = 8;

const PRINTABLE = new Map(); // char -> {code, keyCode, shift}
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i), upper = lower.toUpperCase();
  PRINTABLE.set(lower, { code: "Key" + upper, keyCode: 65 + i, shift: false });
  PRINTABLE.set(upper, { code: "Key" + upper, keyCode: 65 + i, shift: true });
}
for (let i = 0; i < 10; i++) {
  PRINTABLE.set(String(i), { code: "Digit" + i, keyCode: 48 + i, shift: false });
  PRINTABLE.set(")!@#$%^&*("[i], { code: "Digit" + i, keyCode: 48 + i, shift: true });
}
for (const [code, keyCode, plain, shifted] of [
  ["Space", 32, " ", null],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Backslash", 220, "\\", "|"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Backquote", 192, "`", "~"],
]) {
  PRINTABLE.set(plain, { code, keyCode, shift: false });
  if (shifted) PRINTABLE.set(shifted, { code, keyCode, shift: true });
}

const NAMED = {
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  CR: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  BS: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Del: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let i = 1; i <= 12; i++) NAMED["F" + i] = { key: "F" + i, code: "F" + i, keyCode: 111 + i };

const MODIFIER_KEYS = [
  [MOD_CTRL, { key: "Control", code: "ControlLeft", keyCode: 17 }],
  [MOD_SHIFT, { key: "Shift", code: "ShiftLeft", keyCode: 16 }],
];

function printableKey(ch, modifiers) {
  const p = PRINTABLE.get(ch);
  if (!p) return { key: ch, code: "", keyCode: 0, text: ch, modifiers };
  return { key: ch, code: p.code, keyCode: p.keyCode, text: ch, modifiers: modifiers | (p.shift ? MOD_SHIFT : 0) };
}

// A keyTokens entry -> the key press to send.
function keyFor(token) {
  if (token.length === 1 || !(token.startsWith("<") && token.endsWith(">"))) {
    return printableKey(token, 0);
  }
  const name = token.slice(1, -1);
  if (name === "NL") return ctrlChar("j");
  if (name === "Nul") return ctrlChar("@");
  if (NAMED[name]) return { ...NAMED[name], modifiers: 0 };
  const m = /^([SC])-(.+)$/.exec(name);
  if (m) {
    const mod = m[1] === "S" ? MOD_SHIFT : MOD_CTRL;
    if (NAMED[m[2]]) return { ...NAMED[m[2]], modifiers: mod };
    if (mod === MOD_CTRL && m[2].length === 1) return ctrlChar(m[2]);
  }
  throw new Error("don't know how to type " + token);
}

// CTRL plus the key for a character (CTRL-^ is CTRL-SHIFT-6, as on a keyboard).
function ctrlChar(ch) {
  const k = printableKey(/[A-Z]/.test(ch) ? ch.toLowerCase() : ch, MOD_CTRL);
  return { ...k, text: "" };
}

class Keyboard {
  constructor(cdp) {
    this.cdp = cdp;
  }
  async send(type, k, modifiers) {
    await this.cdp.send("Input.dispatchKeyEvent", {
      type,
      modifiers,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      text: type === "keyDown" ? k.text : undefined,
      unmodifiedText: type === "keyDown" ? k.text : undefined,
    });
  }
  async press(k) {
    let held = 0;
    for (const [bit, mk] of MODIFIER_KEYS) {
      if (k.modifiers & bit) {
        held |= bit;
        await this.send("rawKeyDown", mk, held);
      }
    }
    await this.send(k.text ? "keyDown" : "rawKeyDown", k, k.modifiers);
    await this.send("keyUp", k, k.modifiers);
    for (const [bit, mk] of [...MODIFIER_KEYS].reverse()) {
      if (k.modifiers & bit) {
        held &= ~bit;
        await this.send("keyUp", mk, held);
      }
    }
  }
}

// ---------------------------------------------------------------------------

const ORIGIN = "http://vimunit.test/";
const SETUP_TIMEOUT = 30000;

const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

class Browser {
  constructor(args) {
    this.args = args;
  }
  async start() {
    this.browser = await chromium.launch({ headless: !this.args.headed });
    await this.newPage();
  }
  async newPage() {
    if (this.context) await this.context.close().catch(() => {});
    const contextOptions = { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 };
    if (this.args.platform === "linux") contextOptions.userAgent = LINUX_UA;
    this.context = await this.browser.newContext(contextOptions);
    if (this.args.platform === "linux") {
      // CodeMirror and the vim plugin pick their key bindings from
      // navigator.platform (e.g. Emacs-style CTRL bindings on macOS). Report
      // Linux so that results don't depend on the host.
      await this.context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
      });
    }
    // Date.now() runs --key-interval ms ahead per key typed, as if the keys
    // were typed that far apart (CodeMirror's undo history groups changes
    // made within 500ms), without waiting.
    await this.context.addInitScript(() => {
      let offset = 0;
      const realNow = Date.now;
      Date.now = () => realNow() + offset;
      window.__vimunitAdvanceClock = (ms) => { offset += ms; };
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(Math.max(30000, this.args.stepTimeout));
    // Serve the page from an http origin (not file:), so that uncaught
    // exceptions in the editor are reported with their messages.
    const dir = path.dirname(path.resolve(this.args.page));
    await this.page.route(ORIGIN + "**", (route) => {
      const file = path.join(dir, decodeURIComponent(new URL(route.request().url()).pathname));
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      const type = file.endsWith(".js") ? "text/javascript" : "text/html";
      return route.fulfill({ status: 200, contentType: type + "; charset=utf-8", body: fs.readFileSync(file) });
    });
    await this.page.goto(ORIGIN + path.basename(this.args.page));
    await this.page.waitForFunction(() => window.vimunit && window.vimunit.ready);
    this.cdp = await this.context.newCDPSession(this.page);
    this.keyboard = new Keyboard(this.cdp);
  }
  async close() {
    await this.browser.close();
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms ${typeof what === "function" ? what() : what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function matches(st, expected) {
  if (!expected) return true;
  if (st.lines.length !== expected.lines.length) return false;
  for (let i = 0; i < st.lines.length; i++) if (st.lines[i] !== expected.lines[i]) return false;
  return st.line === expected.cursor.line && st.ch === expected.cursor.utf16Column;
}

async function runTest(b, suite, test, emit) {
  const steps = test.steps;
  const reason = skipReason(suite, test);
  if (reason) {
    steps.forEach((_, i) => emit({ id: test.id, step: i + 1, skipped: reason }));
    return;
  }
  const cfg = editorConfig(suite, test);
  const timeout = b.args.stepTimeout;
  await withTimeout(b.page.evaluate((c) => window.vimunit.setup(c), cfg), SETUP_TIMEOUT, "setting up");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const rec = { id: test.id, step: i + 1 };
    let st, errors;
    try {
      let typed = 0;
      const typing = (async () => {
        await b.page.evaluate(() => window.vimunit.beginStep());
        for (const token of step.keyTokens) {
          if (b.args.keyInterval) {
            await b.cdp.send("Runtime.evaluate", { expression: `__vimunitAdvanceClock(${b.args.keyInterval})` });
          }
          await b.keyboard.press(keyFor(token));
          typed++;
        }
        return b.page.evaluate(async () => {
          await window.vimunit.settle();
          return { state: window.vimunit.state(), errors: window.vimunit.takeErrors() };
        });
      })();
      typing.catch(() => {}); // it may still reject after a timeout
      ({ state: st, errors } = await withTimeout(typing, timeout, () => `after ${typed} of ${step.keyTokens.length} keys`));
    } catch (e) {
      emit({ ...rec, error: "adapter: " + firstLine(e) });
      if (!step.expected) {
        for (let j = i + 1; j < steps.length; j++) emit({ id: test.id, step: j + 1, error: "adapter: an earlier step failed" });
        return;
      }
      // The page may be wedged (e.g. in an endless loop): start a new one,
      // and continue from the expected state with fresh editor state.
      await b.newPage();
      await startFrom(b, cfg, step.expected);
      continue;
    }
    // A change that splits a surrogate pair leaves half of it in the buffer.
    // Such a line can't match, and `vimunit report` can't decode it, so record
    // it as U+FFFD (also one UTF-16 unit, so the column still counts right).
    rec.lines = st.lines.map((l) => l.replace(LONE_SURROGATE, "\uFFFD"));
    if (rec.lines.some((l, j) => l !== st.lines[j])) rec.loneSurrogates = true;
    rec.cursor = [st.line, st.ch];
    rec.unit = "utf16";
    // Diagnostics, ignored by `vimunit report`.
    const notNormal = [];
    if (st.insert) notNormal.push(st.replace ? "Replace" : "Insert");
    if (st.visual) notNormal.push("Visual");
    if (st.dialog) notNormal.push("command line");
    if (st.pending) notNormal.push(`pending keys ${JSON.stringify(st.pending)}`);
    if (st.recording) notNormal.push("recording");
    if (notNormal.length) rec.endMode = notNormal.join(", ");
    if (st.ranges > 1) rec.selections = st.ranges;
    if (!st.focused && !st.dialog) rec.focusLost = true;
    if (st.message) rec.message = st.message;
    if (errors.length) rec.pageErrors = errors.slice(0, 3).map((e) => e.slice(0, 200));
    emit(rec);
    if (step.expected && (!matches(st, step.expected) || notNormal.length || st.ranges > 1 || rec.focusLost)) {
      try {
        await withTimeout(resetTo(b, step.expected, st.dialog), timeout, "resetting");
      } catch (e) {
        await b.newPage();
        await startFrom(b, cfg, step.expected);
      }
    }
  }
}

function firstLine(e) {
  return String((e && e.message) || e).split("\n")[0];
}

// A fresh editor whose initial state is a step's expected state.
async function startFrom(b, cfg, expected) {
  const c = {
    ...cfg,
    text: expected.lines.join("\n"),
    anchor: offsetOf(expected.lines, expected.cursor.line, expected.cursor.utf16Column),
  };
  await withTimeout(b.page.evaluate((c) => window.vimunit.setup(c), c), SETUP_TIMEOUT, "setting up");
}

async function resetTo(b, expected, dialogOpen) {
  // Close a : or / prompt the way a user would, then reset in the page.
  for (let n = 0; dialogOpen && n < 3; n++) {
    await b.keyboard.press(keyFor("<Esc>"));
    dialogOpen = await b.page.evaluate(() => window.vimunit.state().dialog);
  }
  const text = expected.lines.join("\n");
  const anchor = offsetOf(expected.lines, expected.cursor.line, expected.cursor.utf16Column);
  await b.page.evaluate(([t, a]) => window.vimunit.reset(t, a), [text, anchor]);
}

async function main() {
  const args = parseArgs(process.argv);
  const suite = JSON.parse(fs.readFileSync(args.tests, "utf8"));
  if (suite.schemaVersion !== 1) throw new Error("unsupported schemaVersion " + suite.schemaVersion);
  const out = fs.createWriteStream(args.out);
  const emit = (rec) => out.write(JSON.stringify(rec) + "\n");
  const b = new Browser(args);
  await b.start();
  const tests = suite.tests.filter((t) => !args.filter || args.filter.test(t.id));
  const started = Date.now();
  let n = 0;
  for (const test of tests) {
    const done = new Set();
    try {
      await runTest(b, suite, test, (rec) => { done.add(rec.step); emit(rec); });
    } catch (e) {
      // Setting up the test (or recovering from a failure) failed.
      test.steps.forEach((_, i) => {
        if (!done.has(i + 1)) emit({ id: test.id, step: i + 1, error: "adapter: " + firstLine(e) });
      });
      await b.newPage();
    }
    if (++n % 100 === 0) process.stderr.write(`  ${n}/${tests.length} tests\n`);
  }
  await new Promise((resolve) => out.end(resolve));
  await b.close();
  process.stderr.write(`ran ${tests.length} tests in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
