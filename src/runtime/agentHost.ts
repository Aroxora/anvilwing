import type { ProfileName } from '../config.js';
import { AgentSession, type AgentSessionOptions } from './agentSession.js';
import { type ToolRuntimeObserver, type ToolSuite } from '../core/toolRuntime.js';

export interface CapabilityContext {
  profile: ProfileName;
  workspaceContext: string | null;
  workingDir: string;
  env: NodeJS.ProcessEnv;
}

export interface CapabilityContribution {
  id: string;
  description?: string;
  toolSuite?: ToolSuite;
  toolSuites?: ToolSuite[];
  metadata?: Record<string, unknown>;
  dispose?(): void | Promise<void>;
}

export interface CapabilityModule {
  id: string;
  description?: string;
  create(
    context: CapabilityContext
  ): CapabilityContribution | CapabilityContribution[] | null | undefined | Promise<CapabilityContribution | CapabilityContribution[] | null | undefined>;
}

export interface CapabilityManifestEntry {
  id: string;
  moduleId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentHostOptions {
  profile: ProfileName;
  workspaceContext: string | null;
  workingDir: string;
  modules?: CapabilityModule[];
  toolObserver?: ToolRuntimeObserver;
  env?: NodeJS.ProcessEnv;
}

export class AgentHost {
  private readonly context: CapabilityContext;
  private readonly toolObserver?: ToolRuntimeObserver;
  private readonly modules = new Map<string, CapabilityModule>();
  private readonly contributions: CapabilityContribution[] = [];
  private readonly contributionOwners = new Map<string, string>();
  private readonly moduleContributions = new Map<string, Set<string>>();
  private session: AgentSession | null = null;
  private disposed = false;

  constructor(options: AgentHostOptions) {
    this.context = {
      profile: options.profile,
      workspaceContext: options.workspaceContext,
      workingDir: options.workingDir,
      env: options.env ? { ...options.env } : { ...process.env },
    };
    this.toolObserver = options.toolObserver;
  }

  get profile(): ProfileName {
    return this.context.profile;
  }

  get workspaceContext(): string | null {
    return this.context.workspaceContext ?? null;
  }

  get workingDir(): string {
    return this.context.workingDir;
  }

  refreshWorkspaceContext(workspaceContext: string | null): void {
    this.context.workspaceContext = workspaceContext;
    this.session?.refreshWorkspaceContext(workspaceContext);
  }

  async loadModules(modules: CapabilityModule[]): Promise<void> {
    for (const module of modules) {
      await this.registerModule(module);
    }
  }

  async registerModule(module: CapabilityModule): Promise<void> {
    this.assertMutable();
    this.removeModuleContributions(module.id);
    this.modules.set(module.id, module);
    const result = await module.create(this.context);
    const normalized = normalizeContributions(result);
    for (const contribution of normalized) {
      this.validateContribution(contribution, module.id);
      this.contributions.push(contribution);
      this.contributionOwners.set(contribution.id, module.id);
      const contributionSet = this.moduleContributions.get(module.id) ?? new Set<string>();
      contributionSet.add(contribution.id);
      this.moduleContributions.set(module.id, contributionSet);
    }
  }

  async getSession(): Promise<AgentSession> {
    if (this.session) {
      return this.session;
    }

    const toolSuites = this.collectToolSuites();
    this.session = new AgentSession({
      profile: this.context.profile,
      workspaceContext: this.context.workspaceContext,
      workingDir: this.context.workingDir,
      toolSuites,
      toolObserver: this.toolObserver,
    } satisfies AgentSessionOptions);

    return this.session;
  }

  describeCapabilities(): CapabilityManifestEntry[] {
    return this.contributions.map((contribution) => ({
      id: contribution.id,
      moduleId: this.contributionOwners.get(contribution.id) ?? 'unknown',
      description: contribution.description,
      metadata: contribution.metadata ?? undefined,
    }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const tasks = this.contributions
      .map((contribution) => contribution.dispose)
      .filter((fn): fn is NonNullable<CapabilityContribution['dispose']> => typeof fn === 'function')
      .map(async (dispose) => {
        try {
          await dispose();
        } catch {
          // Ignore disposal errors to avoid masking upstream teardown.
        }
      });
    await Promise.all(tasks);
  }

  private collectToolSuites(): ToolSuite[] {
    const suites: ToolSuite[] = [];
    const seen = new Set<string>();
    for (const contribution of this.contributions) {
      const records = normalizeSuites(contribution);
      for (const suite of records) {
        if (seen.has(suite.id)) {
          throw new Error(
            `Duplicate tool suite id "${suite.id}" detected while composing capabilities. ` +
              'Ensure every capability module emits unique suite identifiers.'
          );
        }
        suites.push(suite);
        seen.add(suite.id);
      }
    }
    return suites;
  }

  private validateContribution(contribution: CapabilityContribution, moduleId: string): void {
    if (!contribution?.id?.trim()) {
      throw new Error(`Capability module "${moduleId}" emitted a contribution without an id.`);
    }
    const suites = normalizeSuites(contribution);
    for (const suite of suites) {
      if (!suite?.id?.trim()) {
        throw new Error(
          `Capability contribution "${contribution.id}" from module "${moduleId}" ` +
            'emitted a tool suite without an id.'
        );
      }
    }
  }

  private assertMutable(): void {
    if (this.session) {
      throw new Error(
        'Cannot register an additional capability module after the runtime session has been created. ' +
          'Instantiate AgentHost earlier in the boot sequence or create a new host instance.'
      );
    }
  }

  private removeModuleContributions(moduleId: string): void {
    const ids = this.moduleContributions.get(moduleId);
    if (!ids?.size) {
      return;
    }
    this.moduleContributions.delete(moduleId);
    for (const id of ids) {
      const index = this.contributions.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        this.contributions.splice(index, 1);
      }
      this.contributionOwners.delete(id);
    }
  }
}

function normalizeContributions(
  value: CapabilityContribution | CapabilityContribution[] | null | undefined
): CapabilityContribution[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeSuites(contribution: CapabilityContribution): ToolSuite[] {
  const suites: ToolSuite[] = [];
  if (contribution.toolSuite) {
    suites.push(contribution.toolSuite);
  }
  if (contribution.toolSuites?.length) {
    suites.push(...contribution.toolSuites);
  }
  return suites;
}
