#!/usr/bin/env node
/**
 * Anvilwing Coder CLI entrypoint.
 *
 * One surface: the Ink-rendered interactive shell. No argv flags, no
 * print mode, no initial-prompt argument. The bin takes nothing after
 * its name — typing `anvilwing` goes straight to the shell. Configuration
 * (API keys, model choice, self-test, debug) is exposed through in-shell
 * slash commands and the `ANVILWING_API_KEY` env var.
 */
import { reportStatusError } from '../utils/statusReporter.js';
import { track } from '../utils/analytics.js';

track('cli_invoked', { subcommand: 'shell', arg_count: process.argv.length - 2 });

if (process.stdout.isTTY && !process.env['NO_COLOR']) {
  process.env['FORCE_COLOR'] = process.env['FORCE_COLOR'] ?? '1';
}

const { runInteractiveShell } = await import('../headless/interactiveShell.js');
runInteractiveShell({ argv: [] }).catch((error) => {
  reportStatusError(error);
  process.exit(1);
});
