//! vim-unit adapter for the Vim mode of Codex's chat composer.
//!
//! This module is copied into `codex-rs/tui/src/bottom_pane/chat_composer/` by vim-unit's
//! `integrations/codex/run.sh`, which also applies `adapter.patch` to declare it. It is an
//! ignored test, so it never runs as part of Codex's own test suite:
//!
//! ```sh
//! VIMUNIT_TESTS=tests.json VIMUNIT_RESULTS=results.jsonl \
//!     cargo test -p codex-tui --lib -- --ignored --exact \
//!     bottom_pane::chat_composer::vimunit_adapter::vimunit_adapter
//! ```
//!
//! `VIMUNIT_TESTS` is the output of `./vimunit export`; one JSON line per step is written to
//! `VIMUNIT_RESULTS` (see vim-unit's doc/integrating.md).
//!
//! How it drives the editor:
//!
//! * Each test gets a fresh `ChatComposer`, configured the way `BottomPane::new` configures it
//!   (default config, default keymap, paste-burst detection on), with Vim mode enabled. The
//!   initial buffer is loaded as a restored draft and the cursor placed on it.
//! * Every key goes through `ChatComposer::handle_key_event`, the entry point the TUI uses for
//!   terminal key presses when no modal view is open, as the `KeyEvent` crossterm produces for
//!   that key on a terminal without the kitty keyboard protocol.
//! * Keys are typed at human speed: each test runs on a current-thread tokio runtime whose clock
//!   is paused, and between keys the adapter advances the clock by
//!   `KEY_INTERVAL`, runs the paste-burst flush that the TUI runs before drawing each frame, and
//!   wraps the textarea at the window's width, as drawing it would. (Vertical motions use the
//!   wrapping computed by the last draw.)
//! * Keys that the app or chat widget would consume before they reach the composer (Ctrl+T,
//!   Ctrl+O, Ctrl+C, Ctrl+V, ...) are not sent; the step is reported as an error instead.
//! * Cursor columns are reported in bytes, the composer's native unit.

#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::print_stderr,
    clippy::too_many_lines
)]

use super::ChatComposer;
use super::InputResult;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::key_hint;
use crate::key_hint::KeyBinding;
use crate::key_hint::KeyBindingListExt;
use crate::keymap::RuntimeKeymap;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

/// Time between key presses: well above the paste-burst thresholds (8 ms between characters,
/// 120 ms Enter suppression), so typed keys are never mistaken for a paste.
const KEY_INTERVAL: Duration = Duration::from_millis(150);

/// Codex keeps this many undo steps (`MAX_VIM_UNDO_STEPS` in `vim_history.rs`).
const CODEX_UNDO_STEPS: i64 = 64;

struct Context {
    keymap: RuntimeKeymap,
    baseline: Map<String, Value>,
}

/// A buffer and a cursor, with the cursor as (line, byte column).
#[derive(Clone, Debug, PartialEq, Eq)]
struct BufferState {
    lines: Vec<String>,
    cursor: (usize, usize),
}

impl BufferState {
    /// Reads `{"lines": [...], "cursor": {"line": L, "byteColumn": C, ...}}` from the export.
    fn parse(value: &Value) -> Option<Self> {
        let lines = value
            .get("lines")?
            .as_array()?
            .iter()
            .map(|line| line.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        let cursor = value.get("cursor")?;
        let line = usize::try_from(cursor.get("line")?.as_u64()?).ok()?;
        let column = usize::try_from(cursor.get("byteColumn")?.as_u64()?).ok()?;
        Some(Self {
            lines,
            cursor: (line, column),
        })
    }

    fn text(&self) -> String {
        self.lines.join("\n")
    }

    /// The cursor as a byte offset into `text()`.
    fn offset(&self) -> usize {
        let before: usize = self
            .lines
            .iter()
            .take(self.cursor.0)
            .map(|line| line.len() + 1)
            .sum();
        before + self.cursor.1
    }

    fn from_text(text: &str, offset: usize) -> Self {
        let mut pos = offset.min(text.len());
        while !text.is_char_boundary(pos) {
            pos -= 1;
        }
        let before = &text[..pos];
        let line = before.matches('\n').count();
        let column = before.len() - before.rfind('\n').map_or(0, |i| i + 1);
        Self {
            lines: text.split('\n').map(str::to_owned).collect(),
            cursor: (line, column),
        }
    }
}

/// The composer's text and cursor, as the user sees them (including a leading `!` in shell mode).
fn observe(composer: &ChatComposer) -> BufferState {
    BufferState::from_text(&composer.current_text(), composer.current_cursor())
}

/// What, if anything, keeps the composer from being in plain Vim Normal mode.
fn mode_problem(composer: &ChatComposer) -> Option<&'static str> {
    let textarea = &composer.draft.textarea;
    if composer.history_search.is_some() {
        Some("history search was still open")
    } else if textarea.vim_query().is_some() {
        Some("a / or ? search was still being typed")
    } else if textarea.is_vim_replace_mode() {
        Some("the composer was left in Replace mode")
    } else if !textarea.is_vim_normal_mode() {
        Some("the composer was left in Insert mode")
    } else if textarea.is_vim_operator_pending() {
        Some("a command was left pending")
    } else {
        None
    }
}

/// Lays the textarea out at the window width, as drawing a frame does. Vertical motions move
/// through the wrapped rows computed by the most recent layout.
fn render(composer: &ChatComposer, width: u16) {
    let _ = composer.draft.textarea.desired_height(width);
}

/// What happens between two key presses: time passes, the frame tick flushes any typed
/// character that the paste-burst detector was holding, and the composer is drawn.
async fn tick(composer: &mut ChatComposer, width: u16) {
    tokio::time::advance(KEY_INTERVAL).await;
    let _ = composer.flush_paste_burst_if_due();
    render(composer, width);
}

/// Replaces the composer's text and cursor with `state` (after a step didn't produce it).
fn reset_to(composer: &mut ChatComposer, state: &BufferState) {
    let text = state.text();
    let in_place =
        mode_problem(composer).is_none() && !composer.draft.is_bash_mode && !text.starts_with('!');
    if in_place {
        // Keeps the undo history, the register and the last change and search.
        if composer.draft.textarea.text() != text {
            let len = composer.draft.textarea.text().len();
            composer.draft.textarea.replace_range(0..len, &text);
        }
    } else {
        // Reload the draft, which also leaves Insert mode, searches and pending commands, at the
        // cost of the undo history and the last change and search.
        composer.set_text_content(text, Vec::new(), Vec::new());
        composer.draft.textarea.enter_vim_normal_mode();
    }
    composer.set_current_cursor(state.offset());
    composer.sync_popups();
}

/// The key event crossterm reports for a vim-unit key token, on a terminal without the kitty
/// keyboard protocol (so, for example, CTRL-] arrives as Ctrl+5 and CTRL-J as Ctrl+J).
fn key_event_for_token(token: &str) -> Option<KeyEvent> {
    let none = KeyModifiers::NONE;
    let shift = KeyModifiers::SHIFT;
    let ctrl = KeyModifiers::CONTROL;
    let key = |code: KeyCode, modifiers: KeyModifiers| Some(KeyEvent::new(code, modifiers));

    let mut chars = token.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        return match first {
            '\u{1b}' => key(KeyCode::Esc, none),
            '\r' => key(KeyCode::Enter, none),
            '\t' => key(KeyCode::Tab, none),
            '\u{7f}' => key(KeyCode::Backspace, none),
            '\0' => key(KeyCode::Char(' '), ctrl),
            c @ '\u{1}'..='\u{1a}' => {
                key(KeyCode::Char(char::from(b'a' + (c as u8 - 1))), ctrl)
            }
            c @ '\u{1c}'..='\u{1f}' => {
                key(KeyCode::Char(char::from(b'4' + (c as u8 - 0x1c))), ctrl)
            }
            // crossterm marks upper-case letters as shifted.
            c if c.is_uppercase() => key(KeyCode::Char(c), shift),
            c => key(KeyCode::Char(c), none),
        };
    }

    let name = token.strip_prefix('<')?.strip_suffix('>')?;
    match name {
        "Esc" => key(KeyCode::Esc, none),
        "CR" => key(KeyCode::Enter, none),
        "NL" => key(KeyCode::Char('j'), ctrl),
        "Tab" => key(KeyCode::Tab, none),
        "S-Tab" => key(KeyCode::BackTab, shift),
        "BS" => key(KeyCode::Backspace, none),
        "Del" => key(KeyCode::Delete, none),
        "Insert" => key(KeyCode::Insert, none),
        "Up" => key(KeyCode::Up, none),
        "Down" => key(KeyCode::Down, none),
        "Left" => key(KeyCode::Left, none),
        "Right" => key(KeyCode::Right, none),
        "Home" => key(KeyCode::Home, none),
        "End" => key(KeyCode::End, none),
        "PageUp" => key(KeyCode::PageUp, none),
        "PageDown" => key(KeyCode::PageDown, none),
        "S-Up" => key(KeyCode::Up, shift),
        "S-Down" => key(KeyCode::Down, shift),
        "S-Left" => key(KeyCode::Left, shift),
        "S-Right" => key(KeyCode::Right, shift),
        "C-Left" => key(KeyCode::Left, ctrl),
        "C-Right" => key(KeyCode::Right, ctrl),
        "C-Home" => key(KeyCode::Home, ctrl),
        "C-End" => key(KeyCode::End, ctrl),
        "Nul" | "C-@" => key(KeyCode::Char(' '), ctrl),
        "C-\\" => key(KeyCode::Char('4'), ctrl),
        "C-]" => key(KeyCode::Char('5'), ctrl),
        "C-^" => key(KeyCode::Char('6'), ctrl),
        "C-_" => key(KeyCode::Char('7'), ctrl),
        _ => {
            if let Some(letter) = name.strip_prefix("C-")
                && letter.len() == 1
                && letter.as_bytes()[0].is_ascii_alphabetic()
            {
                let letter = char::from(letter.as_bytes()[0].to_ascii_lowercase());
                return key(KeyCode::Char(letter), ctrl);
            }
            if let Some(number) = name.strip_prefix('F')
                && let Ok(number) = number.parse::<u8>()
                && (1..=12).contains(&number)
            {
                return key(KeyCode::F(number), none);
            }
            None
        }
    }
}

/// If the TUI would act on `event` before the composer sees it (an app or chat-widget shortcut,
/// in the default keymap, while no task is running and no popup is open), what it would do.
fn upstream_shortcut(
    keymap: &RuntimeKeymap,
    composer: &ChatComposer,
    event: KeyEvent,
) -> Option<&'static str> {
    let control = event.modifiers.contains(KeyModifiers::CONTROL);
    let is_char = |c: char| matches!(event.code, KeyCode::Char(k) if k.eq_ignore_ascii_case(&c));

    // ChatWidget: Ctrl+C always, and the image-paste keys.
    if control && is_char('c') {
        return Some("clears the draft (Ctrl+C is handled by the chat widget)");
    }
    if is_char('v') && event.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) {
        return Some("pastes an image from the clipboard (chat-widget shortcut)");
    }
    if composer.popup_active() {
        return None;
    }
    if control && is_char('d') && composer.is_empty() {
        return Some("quits Codex (Ctrl+D on an empty draft)");
    }
    if event.code == KeyCode::BackTab {
        return Some("switches the collaboration mode (chat-widget shortcut)");
    }

    // App-level shortcuts, and the chat-widget shortcuts that the default keymap configures.
    let app = &keymap.app;
    let chat = &keymap.chat;
    let shortcuts: [(&[KeyBinding], &'static str); 14] = [
        (app.open_transcript.as_slice(), "opens the transcript overlay"),
        (app.find_transcript.as_slice(), "opens transcript search"),
        (app.select_transcript.as_slice(), "starts transcript selection"),
        (app.focus_activity.as_slice(), "focuses the activity list"),
        (app.open_warnings.as_slice(), "opens the warnings view"),
        (app.open_external_editor.as_slice(), "opens the external editor"),
        (app.copy.as_slice(), "copies the last response"),
        (app.clear_terminal.as_slice(), "clears the terminal"),
        (app.toggle_vim_mode.as_slice(), "toggles Vim mode"),
        (app.toggle_fast_mode.as_slice(), "toggles fast mode"),
        (app.toggle_raw_output.as_slice(), "toggles raw output"),
        (app.toggle_side_conversation.as_slice(), "switches to a side conversation"),
        (chat.decrease_reasoning_effort.as_slice(), "lowers the reasoning effort"),
        (chat.increase_reasoning_effort.as_slice(), "raises the reasoning effort"),
    ];
    for (bindings, action) in shortcuts {
        if bindings.is_pressed(event) {
            return Some(action);
        }
    }
    // Legacy terminals report Ctrl+/ as Ctrl+7; the app accepts that too.
    if app
        .toggle_side_conversation
        .contains(&key_hint::ctrl(KeyCode::Char('/')))
        && key_hint::ctrl(KeyCode::Char('7')).is_press(event)
    {
        return Some("switches to a side conversation");
    }
    None
}

fn describe_result(result: &InputResult) -> Option<&'static str> {
    match result {
        InputResult::None => None,
        InputResult::Submitted { .. } => Some("submitted the prompt"),
        InputResult::Queued { .. } => Some("queued the prompt"),
        InputResult::ParentOwnedInputBlocked => Some("was blocked"),
        _ => Some("dispatched a slash command"),
    }
}

/// What Codex's composer does for an option a test may set: the value its fixed behavior
/// corresponds to, and why. Options for features the composer lacks altogether count as fixed
/// at the baseline, so a test that changes them is skipped rather than run.
enum Fixed {
    Value(Value, &'static str),
    AtLeast(i64, &'static str),
}

fn codex_option(name: &str, baseline: Option<&Value>) -> Option<Fixed> {
    let fixed = |value: Value, why: &'static str| Some(Fixed::Value(value, why));
    match name {
        "wrap" => fixed(json!(true), "the composer always wraps long lines"),
        "linebreak" => fixed(
            json!(true),
            "the composer wraps long lines at word boundaries",
        ),
        "smoothscroll" => fixed(
            json!(true),
            "the composer scrolls by screen rows, not buffer lines",
        ),
        "tabstop" => fixed(json!(1), "the composer displays a tab one column wide"),
        "autoindent" => fixed(json!(false), "new lines never copy the indent"),
        "undolevels" => Some(Fixed::AtLeast(
            CODEX_UNDO_STEPS,
            "the composer keeps 64 undo steps",
        )),
        // Everything else, including options whose baseline Codex only approximates (its h and
        // l cross line breaks, unlike 'whichwrap=b,s', and its Normal-mode cursor can rest past
        // the end of a line, unlike 'virtualedit='): those differences are inaccuracies in the
        // Vim emulation, which tests should report as failures, not settings to skip.
        _ => baseline.map(|value| {
            Fixed::Value(
                value.clone(),
                "it has no such setting, so it is taken to have the baseline value",
            )
        }),
    }
}

/// Option values compare as sets where order doesn't matter (comma lists and flag strings).
fn same_option_value(name: &str, a: &Value, b: &Value) -> bool {
    match (a.as_str(), b.as_str()) {
        (Some(a), Some(b)) => {
            let normalize = |s: &str| -> Vec<String> {
                let mut parts: Vec<String> = if matches!(name, "formatoptions" | "cpoptions") {
                    s.chars().map(String::from).collect()
                } else {
                    s.split(',')
                        .filter(|part| !part.is_empty())
                        .map(str::to_owned)
                        .collect()
                };
                parts.sort();
                parts.dedup();
                parts
            };
            normalize(a) == normalize(b)
        }
        _ => a == b,
    }
}

/// An option setting as `:set` would write it.
fn setting(name: &str, value: &Value) -> String {
    match value {
        Value::Bool(true) => name.to_string(),
        Value::Bool(false) => format!("no{name}"),
        Value::String(s) => format!("{name}={s}"),
        other => format!("{name}={other}"),
    }
}

fn option_skip_reason(name: &str, value: &Value, baseline: Option<&Value>) -> Option<String> {
    let set = format!("the test sets {}", setting(name, value));
    match codex_option(name, baseline)? {
        Fixed::Value(fixed, why) => (!same_option_value(name, value, &fixed)).then(|| {
            format!(
                "Codex behaves like {} ({why}); {set}",
                setting(name, &fixed)
            )
        }),
        Fixed::AtLeast(minimum, why) => (value.as_i64().is_none_or(|v| v < minimum))
            .then(|| format!("'{name}' can't be set in Codex ({why}); {set}")),
    }
}

fn skip_reason(test: &Value, context: &Context) -> Option<String> {
    if test
        .get("definitions")
        .and_then(Value::as_array)
        .is_some_and(|definitions| !definitions.is_empty())
    {
        return Some("the Codex composer has no go-to-definition".to_string());
    }
    let options = test.get("options").and_then(Value::as_object)?;
    options
        .iter()
        .find_map(|(name, value)| option_skip_reason(name, value, context.baseline.get(name)))
}

async fn run_test(test: &Value, context: &Context, records: &mut Vec<Value>) {
    let id = test["id"].as_str().unwrap_or_default().to_string();
    let steps = test["steps"].as_array().cloned().unwrap_or_default();
    let step_record = |index: usize| json!({"id": id, "step": index + 1});

    if let Some(reason) = skip_reason(test, context) {
        for index in 0..steps.len() {
            let mut record = step_record(index);
            record["skipped"] = json!(reason);
            records.push(record);
        }
        return;
    }
    let Some(initial) = BufferState::parse(&test["initial"]) else {
        for index in 0..steps.len() {
            let mut record = step_record(index);
            record["error"] = json!("adapter: the test has no initial state");
            records.push(record);
        }
        return;
    };
    // The window's text area is the textarea's wrapping width. Its height isn't observable:
    // the composer has no commands that depend on the scroll position.
    let width = test["window"]["width"]
        .as_u64()
        .and_then(|width| u16::try_from(width).ok())
        .unwrap_or(80)
        .max(1);

    let (app_event_tx, mut app_events) = unbounded_channel::<AppEvent>();
    let mut composer = ChatComposer::new(
        /*has_input_focus*/ true,
        AppEventSender::new(app_event_tx),
        /*enhanced_keys_supported*/ false,
        "Ask Codex to do anything".to_string(),
        /*disable_paste_burst*/ false,
    );
    composer.set_keymap_bindings(&context.keymap);
    composer.set_vim_enabled(/*enabled*/ true);
    composer.set_text_content(initial.text(), Vec::new(), Vec::new());
    composer.set_current_cursor(initial.offset());
    composer.sync_popups();
    render(&composer, width);

    for (index, step) in steps.iter().enumerate() {
        let expected = BufferState::parse(&step["expected"]);
        let mut error: Option<String> = None;
        let mut notes: Vec<String> = Vec::new();
        let tokens = step["keyTokens"].as_array().cloned().unwrap_or_default();
        for token in &tokens {
            let token = token.as_str().unwrap_or_default();
            let Some(event) = key_event_for_token(token) else {
                error = Some(format!("adapter: no key event for the token {token:?}"));
                break;
            };
            if let Some(action) = upstream_shortcut(&context.keymap, &composer, event) {
                error = Some(format!(
                    "{token} {action} in Codex instead of reaching the composer"
                ));
                break;
            }
            let (result, _needs_redraw) = composer.handle_key_event(event);
            if let Some(what) = describe_result(&result) {
                notes.push(format!("{token} {what}"));
            }
            tick(&mut composer, width).await;
        }
        while app_events.try_recv().is_ok() {}

        let actual = observe(&composer);
        let problem = mode_problem(&composer);
        let matched = expected.as_ref() == Some(&actual);
        if let Some(problem) = problem {
            if matched && error.is_none() {
                error = Some(format!("the buffer and cursor matched, but {problem}"));
            } else {
                notes.push(problem.to_string());
            }
        }

        let mut record = step_record(index);
        record["lines"] = json!(actual.lines);
        record["cursor"] = json!([actual.cursor.0, actual.cursor.1]);
        record["unit"] = json!("byte");
        if let Some(error) = &error {
            record["error"] = json!(error);
        }
        if !notes.is_empty() {
            record["note"] = json!(notes.join("; "));
        }
        records.push(record);

        if (!matched || error.is_some() || problem.is_some())
            && let Some(expected) = &expected
        {
            reset_to(&mut composer, expected);
            render(&composer, width);
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else {
        "unknown panic".to_string()
    }
}

#[test]
#[ignore = "vim-unit adapter: run explicitly with VIMUNIT_TESTS and VIMUNIT_RESULTS set"]
fn vimunit_adapter() {
    let tests_path =
        std::env::var("VIMUNIT_TESTS").expect("VIMUNIT_TESTS must name a `./vimunit export` file");
    let results_path = std::env::var("VIMUNIT_RESULTS")
        .expect("VIMUNIT_RESULTS must name the results file to write");
    let export: Value = serde_json::from_str(
        &std::fs::read_to_string(&tests_path).expect("failed to read VIMUNIT_TESTS"),
    )
    .expect("VIMUNIT_TESTS is not valid JSON");
    let context = Context {
        keymap: RuntimeKeymap::defaults(),
        baseline: export["baselineOptions"]
            .as_object()
            .cloned()
            .unwrap_or_default(),
    };
    let tests = export["tests"].as_array().cloned().unwrap_or_default();
    let mut out = std::io::BufWriter::new(
        std::fs::File::create(&results_path).expect("failed to create VIMUNIT_RESULTS"),
    );

    for (n, test) in tests.iter().enumerate() {
        let mut records = Vec::new();
        // Each test runs on its own runtime, with tokio's clock paused, so that a panic in one
        // test can't affect the next.
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .start_paused(true)
                .build()
                .expect("failed to start a tokio runtime");
            runtime.block_on(run_test(test, &context, &mut records));
        }));
        if let Err(panic) = outcome {
            let message = panic_message(&*panic);
            let id = test["id"].as_str().unwrap_or_default();
            let steps = test["steps"].as_array().map_or(0, Vec::len);
            for index in records.len()..steps {
                records.push(json!({
                    "id": id,
                    "step": index + 1,
                    "error": format!("Codex panicked: {message}"),
                }));
            }
        }
        for record in &records {
            writeln!(out, "{record}").expect("failed to write VIMUNIT_RESULTS");
        }
        out.flush().expect("failed to write VIMUNIT_RESULTS");
        if (n + 1) % 100 == 0 || n + 1 == tests.len() {
            eprintln!("vimunit: ran {}/{} tests", n + 1, tests.len());
        }
    }
}
