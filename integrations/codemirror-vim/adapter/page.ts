// vim-unit adapter, browser side.
//
// This file is copied into packages/codemirror-vim/vimunit/ in the
// codemirror-vim checkout and bundled (with the plugin's own sources and the
// repository's pinned CodeMirror packages) into one script, which driver.mjs
// loads into headless Chromium. It only builds editors and reads/writes their
// state; all keystrokes are real key events that driver.mjs sends through the
// Chrome DevTools Protocol, so they take the same path as typing.

import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { EditorState, EditorSelection, Extension, Text } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap, insertTab, indentLess, isolateHistory } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { vim, Vim, getCM } from "../src/index";

const FONT_SIZE = 16;
const LINE_HEIGHT = 20;

// A plain, predictable layout: monospace text with no padding, so that the
// editor's text area can be sized to a whole number of columns and lines.
const layoutTheme = EditorView.theme({
  "&": { fontSize: FONT_SIZE + "px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "monospace",
    lineHeight: LINE_HEIGHT + "px",
    scrollbarWidth: "none",
  },
  ".cm-content": { padding: "0" },
  ".cm-line": { padding: "0" },
});

// CodeMirror's lineWrapping breaks lines at word boundaries, like Vim's
// 'linebreak'. With 'nolinebreak' Vim fills every screen line to the last
// column, which CSS can do too.
const charWrapTheme = EditorView.theme({
  ".cm-lineWrapping": { lineBreak: "anywhere", wordBreak: "break-all" },
});

interface SetupArgs {
  text: string;
  anchor: number; // UTF-16 offset of the cursor
  tabSize: number;
  indentUnit: string;
  wrap: boolean;
  linebreak: boolean;
  width: number; // text area, in columns
  height: number; // and lines
  undoDepth: number;
  vimOptions: [string, unknown][];
}

interface EditorStateSummary {
  lines: string[];
  line: number;
  ch: number;
  insert: boolean;
  visual: boolean;
  replace: boolean;
  dialog: boolean; // a : or / prompt is open
  message: string; // a notification is showing
  pending: string;
  recording: boolean;
  ranges: number;
  focused: boolean;
}

const root = document.getElementById("root") as HTMLElement;
let view: EditorView | null = null;
let docAtStepStart: Text | null = null;
const pageErrors: string[] = [];
window.addEventListener("error", (e) => pageErrors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => pageErrors.push(String(e.reason)));

(Vim as any).suppressErrorLogging = true;

function cmOf(v: EditorView): any {
  const cm = getCM(v);
  if (!cm) throw new Error("vim plugin not attached");
  return cm;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function setup(a: SetupArgs): Promise<void> {
  if (view) {
    view.destroy();
    view = null;
  }
  root.textContent = "";
  pageErrors.length = 0;

  // Fresh global Vim state: registers, last search, last f/t, macros, jump
  // list, and option values; and no user mappings.
  Vim.resetVimGlobalState_();
  Vim.mapclear();
  Vim.langmap("");

  const extensions: Extension[] = [
    vim(),
    history({ minDepth: a.undoDepth }),
    drawSelection(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: insertTab, shift: indentLess },
    ]),
    EditorState.tabSize.of(a.tabSize),
    indentUnit.of(a.indentUnit),
    layoutTheme,
  ];
  if (a.wrap) {
    extensions.push(EditorView.lineWrapping);
    if (!a.linebreak) extensions.push(charWrapTheme);
  }

  view = new EditorView({
    state: EditorState.create({
      doc: a.text,
      selection: EditorSelection.cursor(a.anchor),
      extensions,
    }),
    parent: root,
  });
  const cm = cmOf(view);
  for (const [name, value] of a.vimOptions) {
    const err = Vim.setOption(name, value, cm);
    if (err instanceof Error) throw err;
  }

  // Size the text area to the test's window, in character cells.
  (view as any).measure();
  const charWidth = view.defaultCharacterWidth;
  view.dom.style.width = Math.ceil(a.width * charWidth * 1000) / 1000 + 0.01 + "px";
  view.dom.style.height = a.height * LINE_HEIGHT + "px";
  view.requestMeasure();
  view.focus();
  await nextFrame();
  view.scrollDOM.scrollTop = 0;
  view.scrollDOM.scrollLeft = 0;
  await nextFrame();
}

function state(): EditorStateSummary {
  if (!view) throw new Error("no editor");
  const cm = cmOf(view);
  const vimState = cm.state.vim || {};
  const doc = view.state.doc;
  const lines: string[] = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  const globalState = (Vim as any).getVimGlobalState_();
  return {
    lines,
    line: line.number - 1,
    ch: head - line.from,
    insert: !!vimState.insertMode,
    visual: !!vimState.visualMode,
    replace: !!cm.state.overwrite,
    dialog: !!cm.state.dialog?.querySelector("input"),
    message: cm.state.dialog && !cm.state.dialog.querySelector("input") ? cm.state.dialog.textContent || "" : "",
    pending: (vimState.inputState?.keyBuffer || []).join(""),
    recording: !!globalState?.macroModeState?.isRecording,
    ranges: view.state.selection.ranges.length,
    focused: view.hasFocus,
  };
}

// Put the editor back into Normal mode with the given buffer and cursor,
// after a step that didn't produce the expected state.
//
// The correction is recorded in the undo history so that a later u goes back
// to the state before the step, as it would have if the step had been right:
// it is merged into the step's own last change if the step changed the buffer,
// and is a change of its own if it didn't.
function reset(text: string, anchor: number): void {
  if (!view) throw new Error("no editor");
  const cm = cmOf(view);
  for (let i = 0; i < 3; i++) {
    const v = cm.state.vim;
    if (!v || !(v.insertMode || v.visualMode || (v.inputState?.keyBuffer || []).length)) break;
    Vim.handleKey(cm, "<Esc>", "user");
  }
  if (cm.state.overwrite) cm.toggleOverwrite(false);
  const globalState = (Vim as any).getVimGlobalState_();
  if (globalState?.macroModeState?.isRecording) globalState.macroModeState.exitMacroRecordMode();
  const changedByStep = docAtStepStart ? !view.state.doc.eq(docAtStepStart) : true;
  const spec: any = {
    selection: EditorSelection.cursor(anchor),
    annotations: changedByStep ? isolateHistory.of("after") : isolateHistory.of("full"),
    userEvent: changedByStep ? "input.type.compose" : "vimunit.reset",
  };
  // Replace only the part that differs, so that the undo history and marks
  // map through the change sensibly.
  const old = view.state.doc.toString();
  if (old !== text) {
    let start = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) start++;
    let end = 0;
    while (end < old.length - start && end < text.length - start &&
           old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
    spec.changes = { from: start, to: old.length - end, insert: text.slice(start, text.length - end) };
  }
  view.dispatch(spec);
  view.focus();
}

// Before each step: dismiss a notification left by the previous step (as
// typing does in Vim), so that `message` shows only this step's.
function beginStep(): void {
  if (!view) throw new Error("no editor");
  const cm = cmOf(view);
  const dialog = cm.state.dialog;
  if (dialog && !dialog.querySelector("input") && cm.state.currentNotificationClose) {
    cm.state.currentNotificationClose();
  }
  pageErrors.length = 0;
  docAtStepStart = view.state.doc;
}

function takeErrors(): string[] {
  return pageErrors.splice(0);
}

(window as any).vimunit = {
  setup,
  state,
  reset,
  beginStep,
  settle: nextFrame,
  takeErrors,
  get ready() {
    return true;
  },
};
