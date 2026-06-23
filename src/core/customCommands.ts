import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProfileName } from '../config.js';
import type { ProviderId } from './types.js';
import { logDebug } from '../utils/debugLogger.js';

const dataRoot = process.env['ANVILWING_DATA_DIR']?.trim() || join(homedir(), '.anvilwing');
const defaultCommandsDir =
  process.env['ANVILWING_COMMANDS_DIR']?.trim() || join(dataRoot, 'commands');

export interface LoadedCustomCommand {
  command: string;
  description: string;
  template: string;
  requireInput: boolean;
  source: string;
  category?: string;
}

export interface CustomCommandContext {
  workspace: string;
  profile: ProfileName;
  provider: ProviderId;
  model: string;
}

export function loadCustomSlashCommands(dir: string = defaultCommandsDir): LoadedCustomCommand[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.json'));
  const commands: LoadedCustomCommand[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const cmd = normalizeCommand(entry, filePath);
          if (cmd && !seen.has(cmd.command)) {
            seen.add(cmd.command);
            commands.push(cmd);
          }
        }
      } else {
        const cmd = normalizeCommand(parsed, filePath);
        if (cmd && !seen.has(cmd.command)) {
          seen.add(cmd.command);
          commands.push(cmd);
        }
      }
    } catch (error) {
      logDebug(`[custom commands] Failed to load ${filePath}:`, error);
    }
  }

  return commands;
}

export function buildCustomCommandPrompt(
  command: LoadedCustomCommand,
  input: string,
  context: CustomCommandContext
): string {
  const replacements: Record<string, string> = {
    input,
    workspace: context.workspace,
    profile: context.profile,
    provider: context.provider,
    model: context.model,
  };
  return command.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const normalized = key.toLowerCase();
    return replacements[normalized] ?? replacements[key] ?? '';
  });
}

function normalizeCommand(entry: unknown, source: string): LoadedCustomCommand | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rawCommandValue = record['command'];
  const rawCommand =
    typeof rawCommandValue === 'string' ? rawCommandValue.trim() : '';
  const command = rawCommand ? (rawCommand.startsWith('/') ? rawCommand : `/${rawCommand}`) : '';

  const descriptionValue = record['description'];
  const description =
    typeof descriptionValue === 'string' && descriptionValue.trim()
      ? descriptionValue.trim()
      : 'Custom command';

  const templateEntry = record['template'] ?? record['prompt'];
  const templateValue = typeof templateEntry === 'string' ? templateEntry : '';

  if (!command || !templateValue.trim()) {
    return null;
  }

  const requireInputEntry = record['requireInput'] ?? record['inputRequired'];
  const requireInput = typeof requireInputEntry === 'boolean' ? requireInputEntry : false;

  const categoryEntry = record['category'];
  const category = typeof categoryEntry === 'string' ? categoryEntry.trim() : undefined;

  return {
    command,
    description,
    template: templateValue,
    requireInput,
    source,
    category,
  };
}
