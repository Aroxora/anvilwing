/**
 * Skills — Claude-Code-parity skill registry.
 *
 * A skill is a markdown file that documents a reusable approach
 * (e.g., "simplify", "security-review", "init-project") with
 * frontmatter metadata. The agent invokes a skill via
 * `Skill({ name })`, which loads the skill body and returns it as
 * the tool result. The model then follows the instructions inline.
 *
 * Storage layout (priority order — both load, project takes precedence):
 *   <workingDir>/.anvilwing/skills/<skill-name>/SKILL.md
 *   ~/.anvilwing/skills/<skill-name>/SKILL.md
 *
 * Frontmatter:
 *   ---
 *   name: simplify
 *   description: Review changed code for reuse and quality.
 *   ---
 *
 *   Body — instructions, examples, anything markdown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

interface SkillRecord {
  name: string;
  description: string;
  body: string;
  source: string; // file path
}

interface SkillFrontmatter extends Record<string, unknown> {
  name?: string;
  description?: string;
}

function skillDirs(workingDir: string): string[] {
  return [
    join(workingDir, '.anvilwing', 'skills'),
    join(homedir(), '.anvilwing', 'skills'),
  ];
}

/**
 * Discover skills from disk. Project-local skills override
 * user-global ones with the same name. Each entry must be either
 * `<name>/SKILL.md` (folder form) or `<name>.md` (flat form).
 */
function loadSkills(workingDir: string): Map<string, SkillRecord> {
  const out = new Map<string, SkillRecord>();
  // Visit user-global FIRST so project-local can overwrite.
  for (const dir of [...skillDirs(workingDir)].reverse()) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      let mdPath: string | null = null;
      try {
        const st = statSync(entryPath);
        if (st.isDirectory()) {
          const candidate = join(entryPath, 'SKILL.md');
          if (existsSync(candidate)) mdPath = candidate;
        } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
          mdPath = entryPath;
        }
      } catch { continue; }
      if (!mdPath) continue;
      let raw: string;
      try { raw = readFileSync(mdPath, 'utf-8'); } catch { continue; }
      const { attributes, body } = parseFrontmatter<SkillFrontmatter>(raw);
      const name = (attributes.name ?? entry.replace(/\.md$/i, '').replace(/[\\/]/g, '_')).trim();
      if (!name) continue;
      const description = (attributes.description ?? '').trim() || '(no description)';
      out.set(name, { name, description, body: body.trim(), source: mdPath });
    }
  }
  return out;
}

export function createSkillTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'list_skills',
      description:
        'List available agent skills (reusable prompts/playbooks loaded from `.anvilwing/skills/`). Each skill has a name + one-line description; load one with the `Skill` tool to read its full body.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const skills = loadSkills(workingDir);
        if (skills.size === 0) {
          return 'No skills installed. Add one at .anvilwing/skills/<name>/SKILL.md (with a `name:` and `description:` in frontmatter).';
        }
        const lines: string[] = [`Skills (${skills.size}):`];
        for (const s of [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`  - ${s.name} — ${s.description}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'Skill',
      description:
        'Load a named skill\'s body (a markdown playbook). The returned text is instructions for the agent to follow for this turn. Use list_skills FIRST to discover what\'s installed. Skills express reusable approaches — "simplify", "security-review", etc. — so you don\'t have to re-prompt the same workflow each turn.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (matching the `name:` frontmatter or directory name).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const name = String(args['name'] ?? '').trim();
        if (!name) return 'Error: name is required.';
        const skills = loadSkills(workingDir);
        const skill = skills.get(name);
        if (!skill) {
          const available = [...skills.keys()].sort().join(', ') || '(none installed)';
          return `Skill not found: ${name}. Available: ${available}`;
        }
        if (!skill.body) {
          return `Skill ${name} has no body.`;
        }
        return [
          `# Skill: ${skill.name}`,
          skill.description,
          '',
          '---',
          '',
          skill.body,
        ].join('\n');
      },
    },
  ];
}
