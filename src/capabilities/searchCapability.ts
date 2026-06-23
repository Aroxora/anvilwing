import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createSearchTools } from '../tools/searchTools.js';

export interface SearchCapabilityOptions {
  workingDir?: string;
}

/**
 * Unified Search Capability Module
 *
 * Provides the Search tool which combines:
 * - File pattern matching (glob)
 * - Content search (regex/grep)
 * - Definition finding (functions, classes, interfaces)
 */
export class SearchCapabilityModule implements CapabilityModule {
  readonly id = 'capability.search';
  private readonly options: SearchCapabilityOptions;

  constructor(options: SearchCapabilityOptions = {}) {
    this.options = options;
  }

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const workingDir = this.options.workingDir ?? context.workingDir;
    return {
      id: 'search.unified',
      description: 'Unified search for files and content',
      toolSuite: {
        id: 'search',
        tools: createSearchTools(workingDir),
      },
      metadata: { workingDir },
    };
  }
}
