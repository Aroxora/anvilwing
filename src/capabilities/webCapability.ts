/**
 * Web Capability Module
 *
 * Provides web search and content extraction tools using:
 * - Tavily (recommended): Search + Extract APIs
 * - Brave Search: Web search fallback
 * - SerpAPI: Google search fallback
 */

import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createWebTools } from '../tools/webTools.js';

export interface WebCapabilityOptions {
  // Future options for configuring providers, rate limits, etc.
}

/**
 * Web Capability Module
 *
 * Provides WebSearch and WebExtract tools for accessing web content.
 */
export class WebCapabilityModule implements CapabilityModule {
  readonly id = 'capability.web';
  private readonly options: WebCapabilityOptions;

  constructor(options: WebCapabilityOptions = {}) {
    this.options = options;
  }

  async create(_context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'web.tools',
      description: 'Web search and content extraction',
      toolSuite: {
        id: 'web',
        tools: createWebTools(),
      },
      metadata: {},
    };
  }
}
