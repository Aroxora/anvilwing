import { createUniversalRuntime, type UniversalRuntime, type UniversalRuntimeOptions } from './universal.js';
import type { CapabilityModule } from './agentHost.js';
import {
  FilesystemCapabilityModule,
  EditCapabilityModule,
  BashCapabilityModule,
  SearchCapabilityModule,
  WebCapabilityModule,
  HITLCapabilityModule,
} from '../capabilities/index.js';
import { TodoCapabilityModule } from '../capabilities/todoCapability.js';
import { MemoryCapabilityModule } from '../capabilities/memoryCapability.js';
import { SkillCapabilityModule } from '../capabilities/skillCapability.js';
import { NotebookCapabilityModule } from '../capabilities/notebookCapability.js';

export interface NodeRuntimeOptions
  extends Omit<UniversalRuntimeOptions, 'additionalModules'> {
  additionalModules?: CapabilityModule[];
}

/**
 * Build the default capability set for the coding/terminal CLI.
 *
 * Single-responsibility cut: this binary owns code + filesystem +
 * terminal. The previous cowork capability (scheduling, standing
 * instructions, persistent due-task ledger) was extracted in 2026-05
 * to its own placeholder repo at ~/GitHub/anvilwing-cowork — same
 * engineering split Anthropic uses for Claude Code vs Claude Cowork.
 * See CLAUDE.md "Capability separation" for the rationale.
 */
function createNodeCapabilityModules(): CapabilityModule[] {
  return [
    new FilesystemCapabilityModule(),
    new EditCapabilityModule(),
    new BashCapabilityModule(),
    new SearchCapabilityModule(),
    new WebCapabilityModule(),
    new HITLCapabilityModule({ autoPause: true, timeoutMs: 0 }),
    // TodoWrite — Claude-Code-style in-session task list. The agent
    // updates a structured plan that surfaces in the UI as tasks tick
    // off. This is the in-session task surface; persistent multi-
    // session task ledgers belong to the separate cowork product.
    new TodoCapabilityModule(),
    // Persistent memory — save/recall facts across CLI sessions.
    // Equivalent to Claude Code's CLAUDE.md + memory pattern.
    // Stored under <workingDir>/.anvilwing/memory/.
    new MemoryCapabilityModule(),
    // Skill registry — Claude-Code-style reusable playbooks loaded
    // from .anvilwing/skills/<name>/SKILL.md.
    new SkillCapabilityModule(),
    // Notebook (.ipynb) cell-level editing — preserves nbformat
    // metadata and the source string|string[] convention.
    new NotebookCapabilityModule(),
  ];
}

export async function createNodeRuntime(options: NodeRuntimeOptions): Promise<UniversalRuntime> {
  const coreModules = createNodeCapabilityModules();
  const additionalModules = options.additionalModules ?? [];

  return createUniversalRuntime({
    ...options,
    additionalModules: [...coreModules, ...additionalModules],
  });
}
