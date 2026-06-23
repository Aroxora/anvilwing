import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRulesetManifest, AgentStepRule, AgentRuleDefinition } from '../contracts/v1/agentRules.js';
import type { ProfileName } from './agentProfiles.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULEBOOK_ROOT = resolve(MODULE_DIR, '..', '..');

const manifestCache = new Map<string, AgentRulesetManifest>();
const promptCache = new Map<string, string>();

export interface LoadRulebookOptions {
  root?: string;
  file?: string;
  inline?: AgentRulesetManifest;
}

export function loadAgentRulebook(profile: ProfileName, options: LoadRulebookOptions = {}): AgentRulesetManifest {
  // If inline manifest is provided, use it directly
  if (options.inline) {
    const manifest = options.inline;
    if (manifest.profile !== profile) {
      throw new Error(
        `Rulebook profile mismatch for ${profile}. Expected "${profile}" but inline manifest declares "${manifest.profile}".`
      );
    }
    return manifest;
  }

  // Otherwise load from file
  const root = options.root ?? DEFAULT_RULEBOOK_ROOT;
  const filePath = resolveRulebookPath(profile, root, options.file);
  const cacheKey = filePath;

  const cached = manifestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const raw = readFileSync(filePath, 'utf8');
  const manifest = JSON.parse(raw) as AgentRulesetManifest;

  if (manifest.profile !== profile) {
    throw new Error(
      `Rulebook profile mismatch for ${profile}. Expected "${profile}" but file declares "${manifest.profile}".`
    );
  }

  manifestCache.set(cacheKey, manifest);
  return manifest;
}

export function buildAgentRulebookPrompt(profile: ProfileName, options: LoadRulebookOptions = {}): string {
  // If inline, don't cache (since it might change)
  if (options.inline) {
    const manifest = loadAgentRulebook(profile, { inline: options.inline });
    return formatAgentRulebook(manifest);
  }

  const root = options.root ?? DEFAULT_RULEBOOK_ROOT;
  const filePath = resolveRulebookPath(profile, root, options.file);
  const cacheKey = filePath;

  const cached = promptCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const manifest = loadAgentRulebook(profile, { root, file: options.file });
  const prompt = formatAgentRulebook(manifest);
  promptCache.set(cacheKey, prompt);
  return prompt;
}

export function formatAgentRulebook(manifest: AgentRulesetManifest): string {
  const lines: string[] = [];
  const headerLabel = manifest.label || manifest.profile;

  lines.push(
    `${headerLabel} — rulebook version ${manifest.version} (contract ${manifest.contractVersion}).`
  );

  if (manifest.description) {
    lines.push(manifest.description.trim());
  }

  if (manifest.globalPrinciples?.length) {
    lines.push('\nGLOBAL PRINCIPLES:');
    for (const rule of manifest.globalPrinciples) {
      lines.push(formatRuleLine(rule));
    }
  }

  for (const phase of manifest.phases) {
    const phaseSummary = [phase.label || phase.id];
    if (phase.description) {
      phaseSummary.push(`– ${phase.description}`);
    }
    lines.push(`\nPHASE ${phase.id}: ${phaseSummary.join(' ')}`);
    if (phase.trigger) {
      lines.push(`  Trigger: ${phase.trigger}`);
    }
    for (const step of phase.steps) {
      lines.push(formatStepLine(step));
    }
  }

  return lines.filter(Boolean).join('\n');
}

function resolveRulebookPath(profile: ProfileName, root: string, fileOverride?: string): string {
  const trimmedOverride = fileOverride?.trim();
  if (trimmedOverride) {
    return resolve(root, trimmedOverride);
  }
  return resolve(root, 'agents', `${profile}.rules.json`);
}

function formatRuleLine(rule: AgentRuleDefinition, indent = '  '): string {
  const severity = rule.severity?.toUpperCase() ?? 'INFO';
  const parts = [`[${severity}] (${rule.id}) ${rule.summary}`];
  if (rule.detail) {
    parts.push(`— ${rule.detail}`);
  }
  if (rule.evidenceRequired) {
    parts.push(`Evidence: ${rule.evidenceRequired}`);
  }
  return `${indent}${parts.join(' ')}`;
}

function formatStepLine(step: AgentStepRule): string {
  const details: string[] = [];
  if (step.intent) {
    details.push(step.intent);
  }
  if (step.description && step.description !== step.intent) {
    details.push(step.description);
  }

  const header = [`  STEP ${step.id}: ${step.title}`];
  if (details.length) {
    header.push(`(${details.join(' — ')})`);
  }
  const lines = [header.join(' ')];

  if (step.entryCriteria?.length) {
    lines.push(`    Entry: ${step.entryCriteria.join('; ')}`);
  }
  if (step.exitCriteria?.length) {
    lines.push(`    Exit: ${step.exitCriteria.join('; ')}`);
  }
  if (step.allowedTools?.length) {
    lines.push(`    Allowed tools: ${step.allowedTools.join(', ')}`);
  }
  if (step.blockedTools?.length) {
    lines.push(`    Blocked tools: ${step.blockedTools.join(', ')}`);
  }
  if (step.notes?.length) {
    lines.push(`    Notes: ${step.notes.join(' ')}`);
  }

  for (const rule of step.rules) {
    lines.push(formatRuleLine(rule, '    - '));
  }

  if (step.subSteps?.length) {
    lines.push('    Sub-steps:');
    for (const subStep of step.subSteps) {
      lines.push(formatStepLine(subStep).replace(/^ {2}/gm, '      '));
    }
  }

  return lines.join('\n');
}
