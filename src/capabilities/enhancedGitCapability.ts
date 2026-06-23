import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export class EnhancedGitCapabilityModule implements CapabilityModule {
  readonly id = 'capability.enhanced-git';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'enhanced-git.tools',
      description: 'Enhanced git workflow with smart commits and PR creation',
      toolSuite: {
        id: 'enhanced-git',
        description: 'Advanced git operations including smart commits and PR management',
        tools: [
          {
            name: 'git_smart_commit',
            description: `Create intelligent git commits following best practices.

IMPORTANT: Only create commits when requested by the user. If unclear, ask first.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- Avoid git commit --amend. ONLY use --amend when either (1) user explicitly requested amend OR (2) adding edits from pre-commit hook
- Before amending: ALWAYS check authorship (git log -1 --format='%an %ae')
- NEVER commit changes unless the user explicitly asks you to

When creating commits:
1. Run git status and git diff to see all changes
2. Run git log to see recent commit message style
3. Analyze changes and draft commit message
4. Add relevant untracked files to staging area
5. Create commit with proper message format

Commit message format:
<subject line>

<body explaining the changes>

🤖 Generated with [AGI-CLI](https://github.com/agi-cli)

Co-Authored-By: Claude <noreply@anthropic.com>

Important notes:
- DO NOT push to remote unless explicitly requested
- NEVER use -i flag (interactive mode not supported)
- If no changes, do not create empty commit
- Always use HEREDOC for commit messages`,
            parameters: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'The commit message subject line',
                },
                body: {
                  type: 'string',
                  description: 'Optional commit message body',
                },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional specific files to commit. If not provided, commits all staged changes.',
                },
              },
              required: ['message'],
            },
            handler: async (args: Record<string, unknown>) => {
              const { message, body, files } = args as {
                message: string;
                body?: string;
                files?: string[];
              };

              try {
                // Check for changes
                const { stdout: statusOutput } = await execAsync('git status --porcelain', {
                  cwd: context.workingDir,
                });

                if (!statusOutput.trim()) {
                  return 'No changes to commit';
                }

                // Add files
                if (files && files.length > 0) {
                  for (const file of files) {
                    await execAsync(`git add "${file}"`, { cwd: context.workingDir });
                  }
                } else {
                  await execAsync('git add -A', { cwd: context.workingDir });
                }

                // Build commit message
                const fullMessage = this.buildCommitMessage(message, body);

                // Create commit
                const commitCommand = `git commit -m "$(cat <<'EOF'
${fullMessage}
EOF
)"`;

                const { stdout, stderr } = await execAsync(commitCommand, {
                  cwd: context.workingDir,
                });

                return `Commit created successfully:\n\n${stdout}\n${stderr}`;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error creating commit: ${message}`;
              }
            },
          },
          {
            name: 'git_create_pr',
            description: `Create a pull request using gh CLI.

IMPORTANT: Only create PR when requested by the user.

Steps for creating PR:
1. Run git status, git diff, and git log to understand current branch state
2. Check if branch tracks remote and is up to date
3. Analyze all commits that will be included in PR
4. Draft PR summary (not just latest commit, but ALL commits)
5. Create branch if needed, push with -u flag if needed
6. Create PR using gh pr create with proper format

PR body format:
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]

🤖 Generated with [AGI-CLI](https://github.com/agi-cli)

Important:
- Return the PR URL when done
- Do not use TodoWrite or Task tools
- Analyze ALL commits, not just the latest one`,
            parameters: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'The PR title',
                },
                body: {
                  type: 'string',
                  description: 'The PR body/description',
                },
                base: {
                  type: 'string',
                  description: 'Base branch (defaults to main)',
                },
                draft: {
                  type: 'boolean',
                  description: 'Create as draft PR',
                },
              },
              required: ['title', 'body'],
            },
            handler: async (args: Record<string, unknown>) => {
              const { title, body, base = 'main', draft = false } = args as {
                title: string;
                body: string;
                base?: string;
                draft?: boolean;
              };

              try {
                // Check if gh CLI is available
                try {
                  await execAsync('gh --version', { cwd: context.workingDir });
                } catch {
                  return 'Error: gh CLI is not installed. Install it from https://cli.github.com/';
                }

                // Check current branch
                const { stdout: branchName } = await execAsync('git rev-parse --abbrev-ref HEAD', {
                  cwd: context.workingDir,
                });

                const currentBranch = branchName.trim();

                if (currentBranch === base) {
                  return `Error: Currently on ${base} branch. Create a feature branch first.`;
                }

                // Push if needed
                try {
                  const { stdout: trackingOutput } = await execAsync(
                    'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
                    { cwd: context.workingDir }
                  );

                  if (!trackingOutput.trim()) {
                    await execAsync(`git push -u origin ${currentBranch}`, {
                      cwd: context.workingDir,
                    });
                  }
                } catch {
                  // No tracking branch, push with -u
                  await execAsync(`git push -u origin ${currentBranch}`, {
                    cwd: context.workingDir,
                  });
                }

                // Create PR using heredoc
                const draftFlag = draft ? '--draft' : '';
                const prCommand = `gh pr create ${draftFlag} --base "${base}" --title "${title}" --body "$(cat <<'EOF'
${body}
EOF
)"`;

                const { stdout } = await execAsync(prCommand, { cwd: context.workingDir });

                return `Pull request created successfully:\n\n${stdout}`;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error creating pull request: ${message}`;
              }
            },
          },
        ],
      },
    };
  }

  private buildCommitMessage(subject: string, body?: string): string {
    const parts = [subject];

    if (body) {
      parts.push('');
      parts.push(body);
    }

    parts.push('');
    parts.push('🤖 Generated with [AGI-CLI](https://github.com/agi-cli)');
    parts.push('');
    parts.push('Co-Authored-By: Claude <noreply@anthropic.com>');

    return parts.join('\n');
  }
}
