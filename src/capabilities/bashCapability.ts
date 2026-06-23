import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createBashTools } from '../tools/bashTools.js';

export interface BashCapabilityOptions {
  workingDir?: string;
  id?: string;
  description?: string;
}

export class BashCapabilityModule implements CapabilityModule {
  readonly id = 'capability.bash';
  private readonly options: BashCapabilityOptions;

  constructor(options: BashCapabilityOptions = {}) {
    this.options = options;
  }

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const workingDir = this.options.workingDir ?? context.workingDir;
    return {
      id: this.options.id ?? 'bash.tools.shell',
      description: this.options.description ?? 'Shell execution with stdout/stderr summaries for reproducibility.',
      toolSuite: {
        id: 'bash',
        description: 'Shell access',
        tools: createBashTools(workingDir),
      },
      metadata: {
        workingDir,
      },
    };
  }
}
