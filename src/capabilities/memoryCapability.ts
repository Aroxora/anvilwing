import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createMemoryTools } from '../tools/memoryTools.js';

export class MemoryCapabilityModule implements CapabilityModule {
  readonly id = 'capability.memory';
  private readonly options: { workingDir?: string };

  constructor(options: { workingDir?: string } = {}) {
    this.options = options;
  }

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const workingDir = this.options.workingDir ?? context.workingDir;
    return {
      id: 'memory.tools',
      description: 'Persistent cross-session memory (save/list/load/delete).',
      toolSuite: {
        id: 'memory',
        description: 'Persistent memory operations',
        tools: createMemoryTools(workingDir),
      },
      metadata: { workingDir },
    };
  }
}
