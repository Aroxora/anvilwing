import type { CapabilityModule, CapabilityContext, CapabilityContribution } from '../runtime/agentHost.js';
import { createEditTools } from '../tools/editTools.js';

/**
 * Edit Capability Module
 *
 * Provides surgical file editing via exact string replacement.
 * This capability is essential for making targeted code changes without full file rewrites.
 *
 * Tools:
 * - Edit: Exact string replacement with uniqueness checking
 *
 * Scope: filesystem:write
 */
export class EditCapabilityModule implements CapabilityModule {
  readonly id = 'capability.edit';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const tools = createEditTools(context.workingDir);

    return {
      id: 'edit.surgical_edits',
      description: 'Surgical file editing via exact string replacement',
      toolSuite: {
        id: 'edit',
        tools,
      },
    };
  }
}
