import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createSkillTools } from '../tools/skillTools.js';

export class SkillCapabilityModule implements CapabilityModule {
  readonly id = 'capability.skills';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'skills.tools',
      description: 'Skill registry — Claude-Code-style reusable playbooks loaded from .anvilwing/skills/.',
      toolSuite: {
        id: 'skills',
        description: 'Skill discovery + loading',
        tools: createSkillTools(context.workingDir),
      },
      metadata: {},
    };
  }
}
