import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runCli } from './cli/run';

export { runCli, USAGE, UsageError } from './cli/run';
export type { CliDeps, CliIO } from './cli/run';

const entry = process.argv[1];
const isEntry = entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);

if (isEntry) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
