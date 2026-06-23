import { AgentHost, type CapabilityModule } from './agentHost.js';
import { AgentSession } from './agentSession.js';
import type { ProfileName } from '../config.js';
import type { ToolRuntimeObserver } from '../core/toolRuntime.js';

export interface UniversalRuntimeOptions {
  profile: ProfileName;
  workspaceContext: string | null;
  workingDir: string;
  toolObserver?: ToolRuntimeObserver;
  env?: NodeJS.ProcessEnv;
  additionalModules?: CapabilityModule[];
}

export interface UniversalRuntime {
  host: AgentHost;
  session: AgentSession;
}

export async function createUniversalRuntime(
  options: UniversalRuntimeOptions
): Promise<UniversalRuntime> {
  const env = options.env ? { ...options.env } : { ...process.env };
  const host = new AgentHost({
    profile: options.profile,
    workspaceContext: options.workspaceContext,
    workingDir: options.workingDir,
    toolObserver: options.toolObserver,
    env,
  });

  const additionalModules = options.additionalModules ?? [];

  if (additionalModules.length) {
    await host.loadModules(additionalModules);
  }

  const session = await host.getSession();

  return {
    host,
    session,
  };
}
