import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading `~` / `~/` to the user's home directory, the way a shell
 * does. Without this the file tools join `~/foo` onto the cwd, so a read of
 * `~/.zshrc` looks under `<cwd>/~/.zshrc` (not found) and a create of
 * `~/notes.md` writes a literal `~` directory inside the project — silently the
 * wrong place. Only the home-tilde forms are expanded; `~user` (another user's
 * home) is left untouched since it can't be resolved portably.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
