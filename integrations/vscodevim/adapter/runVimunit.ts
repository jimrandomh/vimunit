// Launches VS Code with VSCodeVim loaded from this checkout and runs the
// vim-unit adapter (./vimunit.adapter.ts) in its extension host.
//
// Usage: node out/test/vimunit/runVimunit.js <export.json> <results.jsonl> [<log>]
//
// If VS Code crashes or stops making progress (a runaway command can wedge
// the extension host), it is killed and restarted, and the adapter resumes
// after the test that was running, which is recorded as an error.
//
// Environment:
//   VIMUNIT_VSCODE_VERSION  VS Code version to download and run (default: pinned below)
//   VIMUNIT_GREP            only run tests whose id matches this regex
//   VIMUNIT_REPORTER        mocha reporter (default: dot)

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadAndUnzipVSCode } from '@vscode/test-electron';

// Pinned so that results are reproducible; override with VIMUNIT_VSCODE_VERSION.
const DEFAULT_VSCODE_VERSION = '1.144.1';

const MAX_RESTARTS = 20;
// Kill VS Code if the results file hasn't grown for this long.
const STALL_MS = 120_000;

// User settings for the test instance. These turn off VS Code features that
// have no counterpart in vim with no plugins (auto-closing brackets,
// completion popups, ...). Options that tests may change are applied per test
// by the adapter.
const SETTINGS = {
  'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
  'editor.suggestOnTriggerCharacters': false,
  'editor.wordBasedSuggestions': 'off',
  'editor.parameterHints.enabled': false,
  'editor.inlineSuggest.enabled': false,
  'editor.acceptSuggestionOnEnter': 'off',
  'editor.tabCompletion': 'off',
  'editor.snippetSuggestions': 'none',
  'editor.autoClosingBrackets': 'never',
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingComments': 'never',
  'editor.autoClosingDelete': 'never',
  'editor.autoClosingOvertype': 'never',
  'editor.autoSurround': 'never',
  'editor.autoIndent': 'keep',
  'editor.formatOnType': false,
  'editor.formatOnPaste': false,
  'editor.detectIndentation': false,
  'editor.tabSize': 8,
  'editor.insertSpaces': false,
  'editor.wordWrap': 'on',
  'editor.cursorSurroundingLines': 0,
  'editor.useTabStops': false,
  'editor.linkedEditing': false,
  'editor.stickyScroll.enabled': false,
  'editor.minimap.enabled': false,
  'editor.accessibilitySupport': 'off',
  'editor.lineNumbers': 'off',
  'editor.glyphMargin': false,
  'files.eol': '\n',
  'files.insertFinalNewline': false,
  'files.trimTrailingWhitespace': false,
  'files.autoSave': 'off',
  'workbench.startupEditor': 'none',
  'workbench.editor.enablePreview': false,
  'workbench.tips.enabled': false,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'git.enabled': false,
  'chat.disableAIFeatures': true,
  'vim.textwidth': 79,
};

function runOnce(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: fs.WriteStream,
  resultsPath: string,
): Promise<number | string> {
  return new Promise((resolve) => {
    const child = cp.spawn(exe, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d: Buffer) => {
      log.write(d);
      // Show the adapter's own progress lines; everything else goes to the log.
      for (const line of d.toString().split('\n')) {
        if (line.startsWith('vimunit:')) {
          console.log(line);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let lastSize = -1;
    let lastChange = Date.now();
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const watchdog = setInterval(() => {
      if (fs.existsSync(resultsPath + '.restart')) {
        fs.rmSync(resultsPath + '.restart', { force: true });
        kill();
        return;
      }
      const size = fs.existsSync(resultsPath) ? fs.statSync(resultsPath).size : 0;
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > STALL_MS) {
        console.log(`vimunit: no progress for ${STALL_MS / 1000} s; killing VS Code`);
        kill();
      }
    }, 2000);
    const onInterrupt = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      process.exit(130);
    };
    process.on('SIGINT', onInterrupt);
    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      process.removeListener('SIGINT', onInterrupt);
      resolve(code ?? signal ?? 'unknown');
    });
  });
}

async function main() {
  const [exportArg, resultsArg, logArg] = process.argv.slice(2);
  if (!exportArg || !resultsArg) {
    console.error('usage: runVimunit.js <export.json> <results.jsonl> [<log>]');
    process.exit(2);
  }
  // out/test/vimunit -> the checkout's root (the extension's package.json)
  const root = path.resolve(__dirname, '../../../');
  const cachePath = path.join(root, '.vscode-test');
  const resultsPath = path.resolve(resultsArg);
  const donePath = resultsPath + '.done';
  const currentPath = resultsPath + '.current';
  const logPath = path.resolve(logArg ?? path.join(cachePath, 'vimunit.log'));

  const userDataDir = path.join(cachePath, 'vimunit-user-data');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(SETTINGS, null, 2),
  );
  for (const f of [resultsPath, donePath, currentPath, resultsPath + '.restart']) {
    fs.rmSync(f, { force: true });
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vimunit-vscodevim-'));
  const log = fs.createWriteStream(logPath);

  const exe = await downloadAndUnzipVSCode({
    version: process.env.VIMUNIT_VSCODE_VERSION || DEFAULT_VSCODE_VERSION,
    cachePath,
  });
  const args = [
    workspace,
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${path.join(cachePath, 'vimunit-extensions')}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-workspace-trust',
    `--extensionTestsPath=${path.resolve(__dirname, './index')}`,
    `--extensionDevelopmentPath=${root}`,
  ];

  let ok = false;
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    const env = {
      ...process.env,
      VIMUNIT_EXPORT: path.resolve(exportArg),
      VIMUNIT_RESULTS: resultsPath,
      VIMUNIT_WORKSPACE: workspace,
      VIMUNIT_RESUME: attempt > 0 ? '1' : '',
    };
    const code = await runOnce(exe, args, env, log, resultsPath);
    if (fs.existsSync(donePath)) {
      ok = true;
      break;
    }
    console.log(
      `vimunit: VS Code exited (${code}) before the adapter finished; restarting after the test it was running`,
    );
  }
  log.end();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(donePath, { force: true });
  fs.rmSync(currentPath, { force: true });
  if (!ok) {
    console.error(`vimunit: giving up after ${MAX_RESTARTS} restarts; see ${logPath}`);
    process.exit(1);
  }
  console.log(`vimunit: VS Code log in ${logPath}`);
}

void main();
