// Extension-host entry point for the vim-unit adapter: like test/index.ts,
// but runs only ./vimunit.adapter.js.

import Mocha from 'mocha';
import * as path from 'path';

import { Globals } from '../../src/globals';
import { Configuration } from '../testConfiguration';

Globals.isTesting = true;
Globals.mockConfiguration = new Configuration();

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: false,
    // The adapter enforces its own per-key timeouts and records them as errors.
    timeout: 0,
    reporter: process.env.VIMUNIT_REPORTER || 'dot',
    grep: process.env.VIMUNIT_GREP ? new RegExp(process.env.VIMUNIT_GREP) : undefined,
  });
  mocha.addFile(path.resolve(__dirname, './vimunit.adapter.js'));
  return new Promise((resolve, reject) => {
    try {
      // Failing vim-unit tests are results, not errors: the run succeeds as
      // long as the adapter itself completes.
      mocha.run(() => resolve());
    } catch (error) {
      console.error(error);
      reject(error as Error);
    }
  });
}
