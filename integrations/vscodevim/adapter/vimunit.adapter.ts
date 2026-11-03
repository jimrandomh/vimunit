// vim-unit adapter for VSCodeVim.
//
// Reads the suite exported by `./vimunit export` (VIMUNIT_EXPORT), runs each
// test against VSCodeVim in this VS Code instance, and writes one JSON line
// per step to VIMUNIT_RESULTS (see doc/integrating.md in vim-unit).
//
// Keys are delivered the way VS Code delivers real key presses: printable
// characters and Enter through the `type` command (which VSCodeVim
// overrides), and other keys through the command that VSCodeVim's
// package.json keybindings bind them to, if that binding's `when` clause
// holds in the current mode; otherwise through VS Code's own default command
// for the key (e.g. `tab` for Tab in Insert mode), if any. VSCodeVim queues
// all of these on its task queue, and the adapter waits for the queue to
// drain after each key.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getAndUpdateModeHandler } from '../../extensionBase';
import { ExCommandLine, SearchCommandLine } from '../../src/cmd_line/commandLine';
import { Cursor } from '../../src/common/motion/cursor';
import { Mode } from '../../src/mode/mode';
import { ModeHandler } from '../../src/mode/modeHandler';
import { ModeHandlerMap } from '../../src/mode/modeHandlerMap';
import { Register } from '../../src/register/register';
import { globalState } from '../../src/state/globalState';
import { taskQueue } from '../../src/taskQueue';
import { VSCodeContext } from '../../src/util/vscodeContext';
import { Configuration } from '../testConfiguration';
import { reloadConfiguration } from '../testUtils';

// ---------------------------------------------------------------------------
// The export

type OptionValue = boolean | number | string;

interface ExportCursor {
  line: number;
  column: number;
  byteColumn: number;
  utf16Column: number;
}

interface ExportState {
  lines: string[];
  cursor: ExportCursor;
}

interface ExportStep {
  line: number;
  keys: string;
  keyTokens: string[];
  expected: ExportState | null;
}

interface ExportTest {
  id: string;
  options: Record<string, OptionValue>;
  window: { width: number; height: number };
  windowSpecified: boolean;
  definitions: Array<{ name: string; line: number; column: number }>;
  initial: ExportState;
  steps: ExportStep[];
}

interface Export {
  schemaVersion: number;
  defaultWindow: { width: number; height: number };
  baselineOptions: Record<string, OptionValue>;
  tests: ExportTest[];
}

const exportPath = process.env.VIMUNIT_EXPORT!;
const resultsPath = process.env.VIMUNIT_RESULTS!;
const suiteData: Export = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const baseline = suiteData.baselineOptions;

const KEY_TIMEOUT_MS = 5000;
// The most a step may take; after that it's recorded as an error.
const STEP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Options

/**
 * Options that are mapped onto VSCodeVim settings (`vim.*`), VS Code editor
 * options or VS Code settings. Each function returns a skip reason if the
 * value can't be emulated.
 */
const CONFIGURABLE: Record<
  string,
  (value: OptionValue, o: Record<string, OptionValue>) => string | undefined
> = {
  startofline: () => undefined,
  joinspaces: () => undefined,
  ignorecase: () => undefined,
  smartcase: () => undefined,
  autoindent: () => undefined,
  tildeop: () => undefined,
  whichwrap: () => undefined,
  matchpairs: () => undefined,
  gdefault: () => undefined,
  wrapscan: () => undefined,
  incsearch: () => undefined,
  expandtab: () => undefined,
  textwidth: () => undefined,
  // VS Code's editor.useTabStops makes <BS> in leading whitespace delete back
  // to the previous indent stop, as 'smarttab' does.
  smarttab: () => undefined,
  scroll: () => undefined,
  scrolloff: () => undefined,
  wrap: () => undefined,
  tabstop: (v) => ((v as number) > 0 ? undefined : 'tabstop must be positive'),
  // VS Code's indent commands (used by >, <, CTRL-T, CTRL-D) indent by a whole
  // tab when indenting with tabs, ignoring the indent size.
  shiftwidth: (v, o) =>
    !o.expandtab && v !== 0 && v !== o.tabstop
      ? `shiftwidth=${v} with tabstop=${o.tabstop} noexpandtab not supported (VS Code indents with tabs by a whole tab stop)`
      : undefined,
  iskeyword: (v) =>
    iskeywordToSeparators(String(v)) === undefined
      ? `iskeyword=${v} not supported (VSCodeVim's vim.iskeyword lists separator characters, so only changes within ASCII can be emulated)`
      : undefined,
};

/**
 * Options VSCodeVim has no setting for: the value its fixed behavior
 * corresponds to. Tests that declare a different value are skipped. Options
 * not listed here or in CONFIGURABLE are taken to be fixed at the baseline.
 */
const FIXED: Record<string, OptionValue> = {
  // CTRL-A/CTRL-X recognize octal (leading 0) and hex, but not binary.
  nrformats: 'octal,hex',
  // > and < use VS Code's indent commands, which indent to the next multiple
  // of the indent size.
  shiftround: true,
};

/** Options whose values are comma-separated lists or sets of flags. */
const LIST_OPTIONS = new Set(['nrformats', 'backspace', 'whichwrap', 'foldopen', 'matchpairs']);
const FLAG_OPTIONS = new Set(['cpoptions', 'formatoptions']);

function sameOptionValue(name: string, a: OptionValue, b: OptionValue): boolean {
  if (LIST_OPTIONS.has(name)) {
    const norm = (v: OptionValue) =>
      String(v)
        .split(',')
        .filter((x) => x !== '')
        .sort()
        .join(',');
    return norm(a) === norm(b);
  }
  if (FLAG_OPTIONS.has(name)) {
    const norm = (v: OptionValue) => [...new Set(String(v))].sort().join('');
    return norm(a) === norm(b);
  }
  return a === b;
}

function formatOption(name: string, value: OptionValue): string {
  if (typeof value === 'boolean') {
    return value ? name : `no${name}`;
  }
  return `${name}=${value}`;
}

/**
 * Converts a Vim 'iskeyword' value to VSCodeVim's `vim.iskeyword`, which is a
 * list of the (ASCII) characters that separate words. Returns undefined if
 * the value differs from the baseline outside ASCII, which VSCodeVim can't
 * express.
 */
function iskeywordToSeparators(spec: string): string | undefined {
  const set = parseIskeyword(spec);
  const base = parseIskeyword(String(baseline.iskeyword));
  if (set === undefined || base === undefined) {
    return undefined;
  }
  for (let c = 128; c < 256; c++) {
    if (set[c] !== base[c]) {
      return undefined;
    }
  }
  let separators = '';
  for (let c = 33; c < 127; c++) {
    if (!set[c]) {
      separators += String.fromCharCode(c);
    }
  }
  return separators;
}

/** Parses a Vim 'iskeyword'-style value into membership flags for 0-255. */
function parseIskeyword(spec: string): boolean[] | undefined {
  const set = new Array<boolean>(256).fill(false);
  const isAlpha = (c: number) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 192 && c <= 255 && c !== 215 && c !== 247);
  // (A comma itself can only be given by number, 44.)
  const parts = spec.split(',').filter((p) => p !== '');
  const charOf = (s: string): number | undefined => {
    if (/^\d+$/.test(s)) {
      return Number(s);
    }
    if ([...s].length === 1) {
      return s.codePointAt(0);
    }
    return undefined;
  };
  for (let part of parts) {
    let value = true;
    if (part.length > 1 && part.startsWith('^')) {
      value = false;
      part = part.slice(1);
    }
    if (part === '@') {
      for (let c = 0; c < 256; c++) {
        if (isAlpha(c)) {
          set[c] = value;
        }
      }
      continue;
    }
    if (part === '@-@') {
      set[64] = value;
      continue;
    }
    const m = /^(.+?)-(.+)$/.exec(part);
    if (m && part.length > 1) {
      const a = charOf(m[1]);
      const b = charOf(m[2]);
      if (a === undefined || b === undefined) {
        return undefined;
      }
      for (let c = a; c <= Math.min(b, 255); c++) {
        set[c] = value;
      }
      continue;
    }
    const c = charOf(part);
    if (c === undefined) {
      return undefined;
    }
    if (c < 256) {
      set[c] = value;
    }
  }
  return set;
}

function skipReason(t: ExportTest): string | undefined {
  if (t.windowSpecified) {
    return "depends on the window size, which can't be set in the VS Code test instance";
  }
  const effective = { ...baseline, ...t.options };
  for (const [name, value] of Object.entries(t.options)) {
    const check = CONFIGURABLE[name];
    if (check) {
      const reason = check(value, effective);
      if (reason) {
        return reason;
      }
      continue;
    }
    const fixed = name in FIXED ? FIXED[name] : baseline[name];
    if (!sameOptionValue(name, value, fixed)) {
      return `${formatOption(name, value)} not supported (VSCodeVim has no '${name}' setting; it behaves like ${formatOption(name, fixed)})`;
    }
  }
  const marker = String(effective.foldmarker ?? '{{{,}}}').split(',');
  if (
    effective.foldenable &&
    t.initial.lines.some((l) => marker.some((m) => m !== '' && l.includes(m)))
  ) {
    return "marker folds not supported (VS Code folds by indentation or language, and folds don't start closed)";
  }
  return undefined;
}

/** VSCodeVim's defaults for a real user (package.json), plus the per-test options. */
function makeConfiguration(o: Record<string, OptionValue>): Configuration {
  const config = new Configuration();
  const ts = o.tabstop as number;
  Object.assign(config, {
    // package.json defaults where test/testConfiguration.ts differs
    useCtrlKeys: true,
    handleKeys: { '<C-d>': true, '<C-s>': false, '<C-z>': false },
    leader: '\\',
    maxmapdepth: 1000,
    inccommand: 'replace',
    // vim-unit runs vim without plugins; VSCodeVim enables vim-surround by default.
    surround: false,
    sneak: false,
    easymotion: false,
    camelCaseMotion: { enable: false },
    replaceWithRegister: false,
    targets: { ...config.targets, enable: false },
    // vim-unit: no line numbers, no hlsearch
    number: false,
    relativenumber: false,
    showMarksInGutter: false,
    hlsearch: false,
    // the test's options
    startofline: o.startofline,
    joinspaces: o.joinspaces,
    ignorecase: o.ignorecase,
    smartcase: o.smartcase,
    autoindent: o.autoindent,
    tildeop: o.tildeop,
    whichwrap: o.whichwrap,
    matchpairs: o.matchpairs,
    gdefault: o.gdefault,
    wrapscan: o.wrapscan,
    incsearch: o.incsearch,
    tabstop: ts,
    expandtab: o.expandtab,
    iskeyword: iskeywordToSeparators(String(o.iskeyword)),
    scroll: o.scroll,
    scrolloff: o.scrolloff,
    wrap: o.wrap,
  });
  return config;
}

/** VS Code settings that some options map to (applied only when they change). */
const vscodeSettingsState = new Map<string, unknown>([
  ['editor.autoIndent', 'keep'],
  ['vim.textwidth', 79],
  ['editor.wordWrap', 'on'],
  ['editor.cursorSurroundingLines', 0],
  ['editor.useTabStops', false],
]);

/** Returns true if any settings changed. */
async function applyVSCodeSettings(o: Record<string, OptionValue>, t: ExportTest): Promise<boolean> {
  const tw = o.textwidth as number;
  const wanted: Array<[string, unknown]> = [
    ['editor.autoIndent', o.autoindent ? 'keep' : 'none'],
    // textwidth=0 makes gq use the window width (at most 79)
    ['vim.textwidth', tw > 0 ? tw : Math.min(79, t.window.width - 1)],
    ['editor.wordWrap', o.wrap ? 'on' : 'off'],
    ['editor.cursorSurroundingLines', o.scrolloff],
    ['editor.useTabStops', o.smarttab],
  ];
  let changed = false;
  for (const [key, value] of wanted) {
    if (vscodeSettingsState.get(key) !== value) {
      const dot = key.indexOf('.');
      await vscode.workspace
        .getConfiguration(key.slice(0, dot))
        .update(key.slice(dot + 1), value, vscode.ConfigurationTarget.Global);
      vscodeSettingsState.set(key, value);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Keys

/** vim-unit key token -> VS Code key, as written in keybindings. */
const VSCODE_KEYS: Record<string, string> = {
  '<Esc>': 'escape',
  '<NL>': 'ctrl+j',
  '<Tab>': 'tab',
  '<BS>': 'backspace',
  '<Del>': 'delete',
  '<Insert>': 'insert',
  '<Up>': 'up',
  '<Down>': 'down',
  '<Left>': 'left',
  '<Right>': 'right',
  '<Home>': 'home',
  '<End>': 'end',
  '<PageUp>': 'pageup',
  '<PageDown>': 'pagedown',
  '<S-Up>': 'shift+up',
  '<S-Down>': 'shift+down',
  '<S-Left>': 'shift+left',
  '<S-Right>': 'shift+right',
  '<S-Tab>': 'shift+tab',
  '<C-Left>': 'ctrl+left',
  '<C-Right>': 'ctrl+right',
  '<C-Home>': 'ctrl+home',
  '<C-End>': 'ctrl+end',
  '<C-]>': 'ctrl+]',
  '<C-\\>': 'ctrl+\\',
  '<C-^>': 'ctrl+6',
  '<C-_>': 'ctrl+shift+-',
  '<Nul>': 'ctrl+shift+2',
};
for (let c = 65; c <= 90; c++) {
  const l = String.fromCharCode(c);
  VSCODE_KEYS[`<C-${l}>`] = `ctrl+${l.toLowerCase()}`;
}
for (let n = 1; n <= 12; n++) {
  VSCODE_KEYS[`<F${n}>`] = `f${n}`;
}

/**
 * VS Code's default command for keys that VSCodeVim doesn't bind (in the
 * current mode), from VS Code's default keybindings on Linux and Windows.
 * Keys not listed (function keys, CTRL-\, ...) do nothing in the editor.
 */
const VSCODE_DEFAULT_COMMANDS: Record<string, string> = {
  tab: 'tab',
  'shift+tab': 'outdent',
  home: 'cursorHome',
  end: 'cursorEnd',
  'ctrl+home': 'cursorTop',
  'ctrl+end': 'cursorBottom',
  'ctrl+left': 'cursorWordStartLeft',
  'ctrl+right': 'cursorWordEndRight',
  'shift+up': 'cursorUpSelect',
  'shift+down': 'cursorDownSelect',
  'shift+left': 'cursorLeftSelect',
  'shift+right': 'cursorRightSelect',
  pageup: 'cursorPageUp',
  pagedown: 'cursorPageDown',
  up: 'cursorUp',
  down: 'cursorDown',
  left: 'cursorLeft',
  right: 'cursorRight',
  backspace: 'deleteLeft',
  delete: 'deleteRight',
};

interface Keybinding {
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  command: string;
  when: string;
}

let keybindings: Array<{ key: string; command: string; when: string }> = [];

function loadKeybindings(packageJSON: { contributes: { keybindings: Keybinding[] } }) {
  keybindings = packageJSON.contributes.keybindings
    .filter((kb) => !kb.when.includes('listFocus') && !kb.command.startsWith('notebook'))
    .map((kb) => {
      const key =
        (process.platform === 'darwin'
          ? kb.mac
          : process.platform === 'linux'
            ? kb.linux
            : kb.win) ?? kb.key;
      return { key: key.toLowerCase(), command: kb.command, when: kb.when };
    });
}

/** Context keys that VSCodeVim doesn't set; the editor has focus and no widgets are open. */
const FIXED_CONTEXT: Record<string, boolean> = {
  editorTextFocus: true,
  inputFocus: true,
  inDebugRepl: false,
  inlineEditIsVisible: false,
  suggestWidgetVisible: false,
  parameterHintsVisible: false,
  editorHasSelection: false,
  listFocus: false,
  notebookEditorFocused: false,
};

function contextValue(key: string): unknown {
  return key in FIXED_CONTEXT ? FIXED_CONTEXT[key] : VSCodeContext.get(key);
}

function evalWhen(when: string): boolean {
  return when.split('||').some((conj) =>
    conj.split('&&').every((term) => {
      term = term.trim();
      const m = /^(\S+)\s*(==|!=)\s*'([^']*)'$/.exec(term);
      if (m) {
        const v = contextValue(m[1]);
        return m[2] === '==' ? v === m[3] : v !== m[3];
      }
      if (term.startsWith('!')) {
        return !contextValue(term.slice(1).trim());
      }
      return !!contextValue(term);
    }),
  );
}

/** The command VS Code would run for this key: VSCodeVim's, or VS Code's default. */
function commandForKey(vsKey: string): string | undefined {
  // Later keybindings take precedence.
  for (let i = keybindings.length - 1; i >= 0; i--) {
    const kb = keybindings[i];
    if (kb.key === vsKey && evalWhen(kb.when)) {
      return kb.command;
    }
  }
  return VSCODE_DEFAULT_COMMANDS[vsKey];
}

function isCharacter(token: string): boolean {
  return [...token].length === 1;
}

async function pressKey(token: string): Promise<void> {
  if (prompt !== undefined) {
    // An input box or quick pick has the keyboard focus.
    await prompt.key(token);
  } else if (isCharacter(token)) {
    await vscode.commands.executeCommand('type', { text: token });
  } else if (token === '<CR>') {
    // Enter reaches extensions as typing a newline.
    await vscode.commands.executeCommand('type', { text: '\n' });
  } else {
    const vsKey = VSCODE_KEYS[token];
    if (vsKey === undefined) {
      throw new Error(`unknown key ${token}`);
    }
    const command = commandForKey(vsKey);
    if (command !== undefined) {
      await vscode.commands.executeCommand(command);
    }
  }
  await drainTaskQueue();
}

// ---------------------------------------------------------------------------
// VSCodeVim's task queue

/** Errors VSCodeVim raised while handling keys (it logs and swallows them). */
let taskErrors: string[] = [];

function onTaskError(err: unknown) {
  taskErrors.push(String(err instanceof Error ? err.message : err));
}

function attachTaskErrorListener() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (taskQueue as any).taskQueue.addListener('error', onTaskError);
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs fn on VSCodeVim's task queue, after the tasks already queued. */
function runInQueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    taskQueue.enqueueTask(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Waits until VSCodeVim has handled everything queued so far, or is waiting
 * for input in a prompt (see below).
 */
async function drainTaskQueue(): Promise<void> {
  try {
    await withTimeout(
      Promise.race([runInQueue(async () => undefined), waitForPrompt()]),
      KEY_TIMEOUT_MS,
      'waiting for VSCodeVim',
    );
  } finally {
    promptWaiters = [];
  }
}

// ---------------------------------------------------------------------------
// Prompts
//
// Some commands ask for input in a VS Code input box or quick pick (`:s///c`
// asks "Replace with ...?" in an input box; CTRL-X CTRL-L, CTRL-F on the
// command line and `q:` use quick picks) and wait until it's answered. A user
// answers by typing into it, which doesn't go through VS Code commands, so the
// adapter replaces these APIs with emulations: while one is open, the keys
// typed go to it instead of to the editor. File dialogs are answered with
// "cancel".

interface Prompt {
  kind: string;
  key(token: string): Promise<void>;
  cancel(): void;
}

let prompt: Prompt | undefined;
let promptWaiters: Array<() => void> = [];

function waitForPrompt(): Promise<void> {
  return prompt !== undefined
    ? Promise.resolve()
    : new Promise((resolve) => promptWaiters.push(resolve));
}

function openPrompt(p: Prompt): void {
  prompt = p;
  promptWaiters.forEach((resolve) => resolve());
}

function makePrompt<T>(
  kind: string,
  token: vscode.CancellationToken | undefined,
  resolve: (value: T | undefined) => void,
  key: (k: string, finish: (value: T | undefined) => void) => Promise<void>,
): Prompt {
  let done = false;
  const finish = (value: T | undefined) => {
    if (!done) {
      done = true;
      if (prompt === p) {
        prompt = undefined;
      }
      resolve(value);
    }
  };
  const p: Prompt = { kind, key: (k) => key(k, finish), cancel: () => finish(undefined) };
  token?.onCancellationRequested(() => finish(undefined));
  return p;
}

function emulateInputBox(
  options: vscode.InputBoxOptions = {},
  token?: vscode.CancellationToken,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let value = options.value ?? '';
    let blocked = false;
    const validate = async () => {
      const m: unknown = await options.validateInput?.(value);
      // A message blocks <CR> unless it's an info or warning message.
      blocked =
        typeof m === 'string'
          ? m !== ''
          : m != null && (m as vscode.InputBoxValidationMessage).severity === 3;
    };
    const p = makePrompt<string>('input box', token, resolve, async (k, finish) => {
      if (k === '<Esc>') {
        finish(undefined);
      } else if (k === '<CR>') {
        if (!blocked) {
          finish(value);
        }
      } else if (k === '<BS>') {
        value = [...value].slice(0, -1).join('');
        await validate();
      } else if (isCharacter(k)) {
        value += k;
        await validate();
      }
    });
    openPrompt(p);
    void validate();
  });
}

function emulateQuickPick(
  itemsArg: readonly (string | vscode.QuickPickItem)[] | Thenable<readonly (string | vscode.QuickPickItem)[]>,
  options: vscode.QuickPickOptions = {},
  token?: vscode.CancellationToken,
): Promise<unknown> {
  return new Promise((resolve) => {
    void Promise.resolve(itemsArg).then((items) => {
      const label = (it: string | vscode.QuickPickItem) => (typeof it === 'string' ? it : it.label);
      let value = '';
      let active = 0;
      // VS Code matches fuzzily; a substring match is close enough here.
      const shown = () => items.filter((it) => label(it).toLowerCase().includes(value.toLowerCase()));
      const p = makePrompt<unknown>('quick pick', token, resolve, async (k, finish) => {
        if (k === '<Esc>') {
          finish(undefined);
        } else if (k === '<CR>') {
          const it = shown()[active];
          finish(it === undefined ? undefined : options.canPickMany ? [it] : it);
        } else if (k === '<Down>' || k === '<C-N>') {
          active = Math.min(active + 1, Math.max(shown().length - 1, 0));
        } else if (k === '<Up>' || k === '<C-P>') {
          active = Math.max(active - 1, 0);
        } else if (k === '<BS>') {
          value = [...value].slice(0, -1).join('');
          active = 0;
        } else if (isCharacter(k)) {
          value += k;
          active = 0;
        }
      });
      openPrompt(p);
    });
  });
}

function installPromptEmulation(): void {
  Object.assign(vscode.window, {
    showInputBox: emulateInputBox,
    showQuickPick: emulateQuickPick,
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
  });
  if (vscode.window.showInputBox !== emulateInputBox) {
    throw new Error("couldn't replace vscode.window.showInputBox");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until VSCodeVim and VS Code have finished reacting to the keys. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await sleep(5);
    await drainTaskQueue();
  }
}

// ---------------------------------------------------------------------------
// The editor

let workspaceDir: string;
let editor: vscode.TextEditor;
let document: vscode.TextDocument;
let definitions: ExportTest['definitions'] = [];

async function openEditor(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === 'file') {
      await doc.save();
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const file = path.join(workspaceDir, 'vimunit.txt');
  fs.writeFileSync(file, '');
  document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  editor = await vscode.window.showTextDocument(document, { preview: false });
  await editor.edit((b) => b.setEndOfLine(vscode.EndOfLine.LF));
  ModeHandlerMap.clear();
}

async function ensureEditor(): Promise<void> {
  if (
    !editor ||
    document.isClosed ||
    vscode.window.activeTextEditor?.document !== document ||
    vscode.window.visibleTextEditors.length !== 1
  ) {
    await openEditor();
  }
  editor = vscode.window.activeTextEditor!;
}

function modeHandler(): ModeHandler | undefined {
  return ModeHandlerMap.get(document.uri);
}

function codepointToUtf16(text: string, column: number): number {
  return [...text].slice(0, column).join('').length;
}

function fullRange(): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    document.lineAt(document.lineCount - 1).range.end,
  );
}

async function setText(lines: string[]): Promise<void> {
  const text = lines.join('\n');
  if (document.getText() !== text) {
    const ok = await editor.edit((b) => b.replace(fullRange(), text));
    if (!ok) {
      throw new Error('editor.edit failed');
    }
  }
}

function resetGlobalState(): void {
  globalState.previousFullAction = undefined;
  globalState.lastInvokedMacro = undefined;
  globalState.substituteState = undefined;
  globalState.searchState = undefined;
  globalState.hl = true;
  globalState.jumpTracker.clearJumps();
  Register.clearAllRegisters();
  SearchCommandLine.previousSearchStates.length = 0;
  ExCommandLine.history?.clear();
  SearchCommandLine.history?.clear();
}

/**
 * Typing reaches the editor only while its window has keyboard focus: VS
 * Code's `type` command (which VSCodeVim calls to insert text) acts on the
 * focused editor. Another application can take the focus at any time, so the
 * adapter checks before each test, takes it back if needed, and reruns a test
 * if the window lost the focus while it ran.
 */
let focusLost = false;

async function waitForWindowFocus(ms: number): Promise<void> {
  if (vscode.window.state.focused) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);
    const sub = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  });
}

/** Gives the editor keyboard focus, checking that typing reaches it. Run with no ModeHandler. */
async function ensureFocus(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!vscode.window.state.focused) {
      if (attempt > 0) {
        await sleep(1000 * attempt);
      }
      await vscode.commands.executeCommand('workbench.action.focusWindow');
      await waitForWindowFocus(2000);
    }
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const version = document.version;
    await vscode.commands.executeCommand('default:type', { text: 'x' });
    if (document.version !== version) {
      focusLost = false;
      return;
    }
  }
  throw new Error("couldn't give the VS Code editor keyboard focus");
}

/** A fresh editor state for a test: options, buffer, cursor, and a new ModeHandler. */
async function prepare(t: ExportTest): Promise<void> {
  await drainTaskQueue();
  await ensureEditor();
  const o = { ...baseline, ...t.options };
  if (await applyVSCodeSettings(o, t)) {
    // The update resolves before open editors pick up the new settings (and
    // sometimes they don't), so open a new editor, which reads them.
    await sleep(100);
    await openEditor();
  }
  await reloadConfiguration(makeConfiguration(o));
  const ts = o.tabstop as number;
  const sw = o.shiftwidth as number;
  editor.options = {
    tabSize: ts,
    insertSpaces: o.expandtab as boolean,
    indentSize: sw === 0 ? ts : sw,
  } as vscode.TextEditorOptions;
  definitions = t.definitions;

  await runInQueue(async () => {
    ModeHandlerMap.clear();
    await vscode.commands.executeCommand('editor.unfoldAll');
    await ensureFocus();
    await setText(t.initial.lines);
    const c = t.initial.cursor;
    const pos = new vscode.Position(c.line, c.utf16Column);
    editor.selections = [new vscode.Selection(pos, pos)];
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  });
  // Let VS Code's selection and document events go by before VSCodeVim sees the editor.
  await settle();
  resetGlobalState();
  await runInQueue(async () => {
    const [mh] = await ModeHandlerMap.getOrCreate(editor);
    await getAndUpdateModeHandler(true);
    const marks = mh.vimState.historyTracker.getGlobalMarks().map((m) => m.name);
    mh.vimState.historyTracker.removeMarks(marks);
    // Normally a no-op: the ModeHandler takes the cursor from the editor.
    const c = t.initial.cursor;
    const pos = new vscode.Position(c.line, c.utf16Column);
    if (!mh.vimState.cursorStopPosition.isEqual(pos) || !editor.selection.active.isEqual(pos)) {
      console.log(
        `vimunit: note: cursor was at ${editor.selection.active.line}:${editor.selection.active.character} after loading ${t.id}`,
      );
      mh.vimState.cursors = [Cursor.atPosition(pos)];
      mh.vimState.desiredColumn = pos.character;
      mh.updateView();
    }
  });
  await settle();
  const sel = editor.selection.active;
  if (sel.line !== t.initial.cursor.line || sel.character !== t.initial.cursor.utf16Column) {
    throw new Error(`couldn't place the cursor at the initial position (got ${sel.line}:${sel.character})`);
  }
  taskErrors = [];
}

/** After a mismatch: back to Normal mode, with the expected buffer and cursor. */
async function forceState(expected: ExportState): Promise<void> {
  if (prompt !== undefined) {
    prompt.cancel();
    await drainTaskQueue();
  }
  for (let i = 0; i < 3 && modeHandler()?.vimState.currentMode !== Mode.Normal; i++) {
    await pressKey('<Esc>');
  }
  if (modeHandler() === undefined || modeHandler()!.vimState.currentMode !== Mode.Normal) {
    await runInQueue(async () => {
      ModeHandlerMap.clear();
    });
  }
  await runInQueue(async () => {
    await setText(expected.lines);
    const pos = new vscode.Position(expected.cursor.line, expected.cursor.utf16Column);
    const [mh] = await ModeHandlerMap.getOrCreate(editor);
    mh.vimState.cursors = [Cursor.atPosition(pos)];
    mh.vimState.desiredColumn = pos.character;
    mh.updateView();
  });
  await settle();
}

/**
 * After a timeout (typically a recursive macro that VSCodeVim never stops):
 * make the ModeHandler throw on every further action or key, so that the
 * command unwinds, and start over with a new ModeHandler. If the command still
 * doesn't stop, ask the launcher to restart VS Code.
 */
async function recoverFromHang(): Promise<void> {
  prompt?.cancel();
  const mh = modeHandler();
  if (mh) {
    const stop = async () => {
      throw new Error('vim-unit adapter: stopped a command that ran too long');
    };
    Object.assign(mh, { runAction: stop, handleKeyEventLangmapped: stop });
    mh.remapState.forceStopRecursiveRemapping = true;
  }
  try {
    await withTimeout(runInQueue(async () => undefined), 10_000, 'stopping a runaway command');
  } catch {
    fs.writeFileSync(resultsPath + '.restart', '');
    console.log("vimunit: couldn't stop a runaway command; asking for a restart");
    await new Promise(() => undefined);
  }
  await runInQueue(async () => {
    ModeHandlerMap.clear();
  });
  await ensureEditor();
}

// ---------------------------------------------------------------------------
// Results

let resultsFd: number;
const currentPath = resultsPath + '.current';
const donePath = resultsPath + '.done';

/**
 * When VS Code is restarted after a crash or hang (VIMUNIT_RESUME), keeps the
 * results so far, records the test that was running as an error, and returns
 * the tests that are finished.
 */
function resumeResults(): Set<string> {
  const finished = new Set<string>();
  if (!process.env.VIMUNIT_RESUME || !fs.existsSync(resultsPath)) {
    resultsFd = fs.openSync(resultsPath, 'w');
    return finished;
  }
  const lines: string[] = [];
  const steps = new Map<string, Set<number>>();
  for (const line of fs.readFileSync(resultsPath, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line) as { id: string; step: number };
      lines.push(line);
      if (!steps.has(r.id)) {
        steps.set(r.id, new Set());
      }
      steps.get(r.id)!.add(r.step);
    } catch {
      // a partial line, or the empty string after the last newline
    }
  }
  resultsFd = fs.openSync(resultsPath, 'w');
  fs.writeSync(resultsFd, lines.map((l) => l + '\n').join(''));
  const running = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : undefined;
  for (const t of suiteData.tests) {
    const done = steps.get(t.id) ?? new Set();
    if (t.id === running) {
      t.steps.forEach((_, i) => {
        if (!done.has(i + 1)) {
          emit({ id: t.id, step: i + 1, error: 'VS Code crashed or hung while running this test' });
        }
      });
      finished.add(t.id);
    } else if (done.size === t.steps.length) {
      finished.add(t.id);
    }
  }
  return finished;
}

function emit(record: object): void {
  fs.writeSync(resultsFd, JSON.stringify(record) + '\n');
}

function readState(): { lines: string[]; cursor: [number, number] } {
  const pos = editor.selection.active;
  return { lines: document.getText().split('\n'), cursor: [pos.line, pos.character] };
}

function matches(
  actual: { lines: string[]; cursor: [number, number] },
  expected: ExportState | null,
): boolean {
  return (
    expected !== null &&
    actual.lines.length === expected.lines.length &&
    actual.lines.every((l, i) => l === expected.lines[i]) &&
    actual.cursor[0] === expected.cursor.line &&
    actual.cursor[1] === expected.cursor.utf16Column
  );
}

const counts = { tests: 0, passed: 0, skipped: 0 };
let finished = new Set<string>();

/** Runs one test; returns undefined if it passed, else a short description. */
async function runTest(t: ExportTest): Promise<string | undefined | 'skipped'> {
  const reason = skipReason(t);
  if (reason) {
    t.steps.forEach((_, i) => emit({ id: t.id, step: i + 1, skipped: reason }));
    return 'skipped';
  }
  for (let attempt = 1; ; attempt++) {
    const records: object[] = [];
    const result = await runTestOnce(t, records);
    if (!focusLost || attempt === 3) {
      if (focusLost) {
        for (const r of records as Array<Record<string, unknown>>) {
          r.error = `${r.error ? `${r.error}; ` : ''}the VS Code window lost the keyboard focus during the test`;
        }
      }
      records.forEach(emit);
      return result;
    }
    console.log(`vimunit: the VS Code window lost the keyboard focus; rerunning ${t.id}`);
  }
}

async function runTestOnce(t: ExportTest, records: object[]): Promise<string | undefined> {
  const emit = (r: object) => records.push(r);
  try {
    await withTimeout(prepare(t), 4 * KEY_TIMEOUT_MS, 'setting up the test');
  } catch (e) {
    if (e instanceof TimeoutError) {
      await recoverFromHang();
    }
    const msg = `adapter: ${e instanceof Error ? e.message : String(e)}`;
    t.steps.forEach((_, i) => emit({ id: t.id, step: i + 1, error: msg }));
    return msg;
  }
  const failed: string[] = [];
  for (const [i, step] of t.steps.entries()) {
    const record: Record<string, unknown> = { id: t.id, step: i + 1 };
    const started = Date.now();
    const errors: string[] = [];
    let actual: { lines: string[]; cursor: [number, number] } | undefined;
    let abandoned = false;
    try {
      await withTimeout(
        (async () => {
          for (const token of step.keyTokens) {
            if (abandoned) {
              return;
            }
            await withTimeout(pressKey(token), KEY_TIMEOUT_MS, `key ${token}`);
          }
          await settle();
        })(),
        STEP_TIMEOUT_MS,
        'the step',
      ).finally(() => {
        abandoned = true;
      });
      if (prompt !== undefined) {
        errors.push(`ended with a VS Code ${prompt.kind} open`);
        prompt.cancel();
        await settle();
      }
      actual = readState();
      Object.assign(record, actual, { unit: 'utf16' });
      const mh = modeHandler();
      if (mh === undefined) {
        errors.push('VSCodeVim has no ModeHandler for the editor');
      } else {
        if (mh.vimState.currentMode !== Mode.Normal) {
          errors.push(`ended in ${Mode[mh.vimState.currentMode]} mode instead of Normal mode`);
        }
        if (mh.vimState.macro !== undefined) {
          errors.push('ended while recording a macro');
        }
      }
      if (editor.selections.length > 1) {
        errors.push(`ended with ${editor.selections.length} cursors`);
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        await recoverFromHang();
      }
      errors.push(`adapter: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (errors.length > 0) {
      record.error = errors.join('; ');
    }
    // Not part of the results format; for diagnosis.
    record.ms = Date.now() - started;
    if (taskErrors.length > 0) {
      record.vscodevimErrors = taskErrors;
      taskErrors = [];
    }
    emit(record);
    if (errors.length > 0 || actual === undefined || !matches(actual, step.expected)) {
      failed.push(`step ${i + 1}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`);
      if (step.expected !== null && i + 1 < t.steps.length) {
        try {
          await withTimeout(forceState(step.expected), 4 * KEY_TIMEOUT_MS, 'resetting state');
        } catch (e) {
          if (e instanceof TimeoutError) {
            await recoverFromHang();
          }
        }
      }
    }
  }
  return failed.length > 0 ? `failed: ${failed.join(', ')}` : undefined;
}

// ---------------------------------------------------------------------------
// Mocha

suite('vim-unit', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('vscodevim.vim');
    if (!ext) {
      throw new Error('VSCodeVim extension not found');
    }
    await ext.activate();
    loadKeybindings(ext.packageJSON);
    attachTaskErrorListener();
    installPromptEmulation();
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        focusLost = true;
      }
    });
    workspaceDir = process.env.VIMUNIT_WORKSPACE!;
    finished = resumeResults();
    await openEditor();
    const provider = {
      provideDefinition: lookupDefinition,
      provideDeclaration: lookupDefinition,
    };
    const selector = { scheme: 'file', language: 'plaintext' };
    vscode.languages.registerDefinitionProvider(selector, provider);
    vscode.languages.registerDeclarationProvider(selector, provider);
  });

  suiteTeardown(() => {
    fs.closeSync(resultsFd);
    fs.writeFileSync(donePath, '');
    console.log(
      `vimunit: ran ${counts.tests} tests: ${counts.passed} passed, ${counts.skipped} skipped, ` +
        `${counts.tests - counts.passed - counts.skipped} failed` +
        (finished.size > 0 ? ` (${finished.size} done before a restart)` : ''),
    );
  });

  const total = suiteData.tests.length;
  for (const [n, t] of suiteData.tests.entries()) {
    test(t.id, async function () {
      if (finished.has(t.id)) {
        return;
      }
      if (n % 50 === 0) {
        console.log(`vimunit: [${n}/${total}] ${t.id}`);
      }
      fs.writeFileSync(currentPath, t.id);
      counts.tests++;
      const result = await runTest(t);
      if (result === 'skipped') {
        counts.skipped++;
        this.skip();
      } else if (result !== undefined) {
        const err = new Error(result);
        err.stack = result;
        throw err;
      }
      counts.passed++;
    });
  }
});

/** Go-to-definition and go-to-declaration, answered from the test's :definition lines. */
function lookupDefinition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): vscode.Location | undefined {
  const range = doc.getWordRangeAtPosition(pos, /[\p{L}\p{N}_]+/u);
  if (!range) {
    return undefined;
  }
  const word = doc.getText(range);
  const d = definitions.find((x) => x.name === word);
  if (!d || d.line >= doc.lineCount) {
    return undefined;
  }
  const column = codepointToUtf16(doc.lineAt(d.line).text, d.column);
  return new vscode.Location(doc.uri, new vscode.Position(d.line, column));
}
