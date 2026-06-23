import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createFileTools } from '../tools/fileTools.js';

export interface FilesystemCapabilityOptions {
  workingDir?: string;
  id?: string;
  description?: string;
}

export class FilesystemCapabilityModule implements CapabilityModule {
  readonly id = 'capability.filesystem';
  private readonly options: FilesystemCapabilityOptions;

  constructor(options: FilesystemCapabilityOptions = {}) {
    this.options = options;
  }

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const workingDir = this.options.workingDir ?? context.workingDir;
    return {
      id: this.options.id ?? 'filesystem.tools.local',
      description: this.options.description ?? 'Local file system access with deterministic diff summaries.',
      toolSuite: {
        id: 'fs',
        description: 'File operations',
        tools: createFileTools(workingDir),
      },
      metadata: {
        workingDir,
      },
    };
  }
}
