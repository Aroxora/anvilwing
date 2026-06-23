/**
 * HITL Capability Module
 * Provides the ONLY human-in-the-loop decision system in the repository
 */

import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createHITLTools } from '../tools/hitlTools.js';

export interface HITLCapabilityOptions {
  id?: string;
  description?: string;
  autoPause?: boolean;
  timeoutMs?: number;
}

export class HITLCapabilityModule implements CapabilityModule {
  readonly id = 'capability.hitl';
  private readonly options: HITLCapabilityOptions;

  constructor(options: HITLCapabilityOptions = {}) {
    this.options = options;
  }

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: this.options.id ?? 'hitl.decision.system',
      description: this.options.description ?? 'Human-in-the-loop decision system. This is the ONLY HITL system in the repository.',
      toolSuite: {
        id: 'hitl',
        description: 'Pause execution for human decisions on critical paths',
        tools: createHITLTools(),
      },
      metadata: {
        autoPause: this.options.autoPause ?? true,
        timeoutMs: this.options.timeoutMs ?? 0,
        note: 'Primary human decision interface - no other HITL systems exist'
      },
    };
  }
}