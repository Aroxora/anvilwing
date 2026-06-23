import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createNotebookTools } from '../tools/notebookTools.js';

export class NotebookCapabilityModule implements CapabilityModule {
  readonly id = 'capability.notebook';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'notebook.tools',
      description: 'Jupyter notebook (.ipynb) cell-level editing.',
      toolSuite: {
        id: 'notebook',
        description: 'NotebookEdit',
        tools: createNotebookTools(context.workingDir),
      },
      metadata: {},
    };
  }
}
