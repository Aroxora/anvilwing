/**
 * UNIFIED CODING CAPABILITY
 *
 * A lean, consolidated capability module that provides all essential
 * tools for an AI coding assistant in a single, coherent interface.
 *
 * Consolidates: Filesystem, Edit, Bash, Search, Git, Web
 */

import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import type { ToolSuite, ToolDefinition } from '../core/toolRuntime.js';
import type { JSONSchemaObject, JSONSchemaString } from '../core/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { expandHome } from '../utils/pathUtils.js';
import { execSync } from 'child_process';
import { buildDiffWithContext, formatDiffClaudeStyle } from '../tools/diffUtils.js';
import { recordFileChange } from '../tools/fileChangeTracker.js';
import type { LLMProvider } from '../core/types.js';
import { AgentRegistry, filterToolsForType } from '../core/agentRegistry.js';
import { LeanAgent } from '../leanAgent.js';

// ============================================================================
// TYPES
// ============================================================================

export interface UnifiedCodingOptions {
  workingDir?: string;
  enableGit?: boolean;
  enableWeb?: boolean;
  enableBash?: boolean;
  maxFileSize?: number;
  timeout?: number;
  /** LLM provider for parallel agent spawning */
  provider?: LLMProvider;
  providerId?: string;
  modelId?: string;
  /** When set, this capability is being built FOR a sub-agent: the
   *  unified suite is filtered down to the tools that subagent_type is
   *  allowed to use. The parent's capability is built with this unset
   *  (or 'general'). */
  subagentType?: import('../core/agentRegistry.js').AgentType;
  /** Optional explicit allow-list. Overrides `subagentType` filtering
   *  if both are set. Used internally when callers want a custom
   *  toolset for a one-off sub-agent. */
  allowedToolNames?: ReadonlySet<string>;
  /** Shared registry for the parent agent — child agents access this
   *  via the `Agent` and lifecycle tools. Created lazily on first use
   *  if not passed in. */
  agentRegistry?: import('../core/agentRegistry.js').AgentRegistry;
}

// ============================================================================
// SCHEMA HELPERS
// ============================================================================

function stringProp(description: string, enumValues?: readonly string[]): JSONSchemaString {
  const prop: JSONSchemaString = {
    type: 'string' as const,
    description,
  };
  if (enumValues) {
    return { ...prop, enum: enumValues };
  }
  return prop;
}

function objectSchema(
  properties: Record<string, JSONSchemaString>,
  required: string[]
): JSONSchemaObject {
  return {
    type: 'object' as const,
    properties,
    required,
  };
}

// ============================================================================
// UNIFIED CODING CAPABILITY MODULE
// ============================================================================

/** Internal options type with required base fields and optional provider fields */
type ResolvedCodingOptions = {
  workingDir: string;
  enableGit: boolean;
  enableWeb: boolean;
  enableBash: boolean;
  maxFileSize: number;
  timeout: number;
  provider?: LLMProvider;
  providerId?: string;
  modelId?: string;
  subagentType?: import('../core/agentRegistry.js').AgentType;
  allowedToolNames?: ReadonlySet<string>;
  agentRegistry?: import('../core/agentRegistry.js').AgentRegistry;
};

export class UnifiedCodingCapabilityModule implements CapabilityModule {
  readonly id = 'unified-coding';
  private readonly options: ResolvedCodingOptions;

  constructor(options: UnifiedCodingOptions = {}) {
    this.options = {
      workingDir: options.workingDir ?? process.cwd(),
      enableGit: options.enableGit ?? true,
      enableWeb: options.enableWeb ?? true,
      enableBash: options.enableBash ?? true,
      maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024, // 10MB
      timeout: options.timeout ?? 30000, // 30s
      provider: options.provider,
      providerId: options.providerId,
      modelId: options.modelId,
      subagentType: options.subagentType,
      allowedToolNames: options.allowedToolNames,
      agentRegistry: options.agentRegistry,
    };
  }

  async create(_context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: this.id,
      description: 'Unified coding assistant tools',
      toolSuite: this.buildToolSuite(),
    };
  }

  private buildToolSuite(): ToolSuite {
    const tools: ToolDefinition<Record<string, unknown>>[] = [];

    // === FILESYSTEM TOOLS ===
    tools.push(this.createReadFileTool());
    tools.push(this.createWriteFileTool());
    tools.push(this.createListFilesTool());
    tools.push(this.createFileExistsTool());

    // === EDIT TOOLS ===
    tools.push(this.createEditFileTool());
    tools.push(this.createSearchReplaceTool());

    // === SEARCH TOOLS ===
    tools.push(this.createGrepTool());
    tools.push(this.createGlobTool());

    // === BASH TOOLS ===
    if (this.options.enableBash) {
      tools.push(this.createBashTool());
    }

    // === GIT TOOLS ===
    if (this.options.enableGit) {
      tools.push(this.createGitTool());
    }

    // === WEB TOOLS ===
    if (this.options.enableWeb) {
      tools.push(this.createWebFetchTool());
    }

    // === AGENT-SPAWN TOOLS ===
    // Only the parent (no subagentType) gets these — sub-agents are
    // explicitly forbidden from spawning further sub-agents.
    if (this.options.provider && !this.options.subagentType) {
      const agentTools = this.createAgentSpawnTools();
      for (const t of agentTools) tools.push(t);
    }

    // Apply tool filter for sub-agents.
    let finalTools = tools;
    if (this.options.allowedToolNames) {
      finalTools = tools.filter((t) => this.options.allowedToolNames!.has(t.name));
    } else if (this.options.subagentType) {
      // Lazy-import the filter to avoid module init cycles.
      // Pulling synchronously via require() is fine — this module is
      // CommonJS-compatible at runtime.
      // (import hoisted to top — ESM has no require())
      const allowed = new Set(filterToolsForType(tools.map((t) => t.name), this.options.subagentType));
      finalTools = tools.filter((t) => allowed.has(t.name));
    }

    return {
      id: 'unified-coding-tools',
      description: 'Unified coding assistant tools for file operations, editing, search, and execution',
      tools: finalTools,
    };
  }

  // ============================================================================
  // FILESYSTEM TOOLS
  // ============================================================================

  private createReadFileTool(): ToolDefinition<{ path: string; encoding?: string }> {
    return {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content as a string.',
      parameters: objectSchema(
        {
          path: stringProp('Absolute or relative path to the file'),
          encoding: stringProp('File encoding (default: utf-8)'),
        },
        ['path']
      ),
      handler: async (args) => {
        try {
          const filePath = this.resolvePath(args.path);
          const stat = fs.statSync(filePath);

          if (stat.size > this.options.maxFileSize) {
            return `Error: File too large (${stat.size} bytes). Max: ${this.options.maxFileSize} bytes`;
          }

          const content = fs.readFileSync(filePath, { encoding: (args.encoding as BufferEncoding) ?? 'utf-8' });
          return content;
        } catch (error) {
          return `Error reading file: ${(error as Error).message}`;
        }
      },
    };
  }

  private createWriteFileTool(): ToolDefinition<{ path: string; content: string; createDirs?: string }> {
    return {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist.',
      parameters: objectSchema(
        {
          path: stringProp('Absolute or relative path to the file'),
          content: stringProp('Content to write to the file'),
          createDirs: stringProp('Create parent directories if they do not exist (default: true)'),
        },
        ['path', 'content']
      ),
      handler: async (args) => {
        try {
          const filePath = this.resolvePath(args.path);

          // Read old content if file exists (for diff)
          let oldContent = '';
          const fileExists = fs.existsSync(filePath);
          if (fileExists) {
            oldContent = fs.readFileSync(filePath, 'utf-8');
          }

          if (args.createDirs !== 'false') {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
          }

          // Record for revert before writing
          recordFileChange(filePath);

          fs.writeFileSync(filePath, args.content, 'utf-8');

          // Generate diff output
          const relativePath = path.relative(this.options.workingDir, filePath);
          const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;
          const diffResult = buildDiffWithContext(oldContent, args.content, 2);
          const { additions, removals } = diffResult;

          // Format diff with colors (limit to 10 lines)
          const MAX_DIFF_LINES = 10;
          const truncatedSegments = diffResult.segments.slice(0, MAX_DIFF_LINES);
          const diffLines = formatDiffClaudeStyle(truncatedSegments, true);
          const remainingChanges = diffResult.segments.length - MAX_DIFF_LINES;
          if (remainingChanges > 0) {
            diffLines.push(`      ... +${remainingChanges} more changes`);
          }
          const diffBlock = diffLines.length > 0 ? diffLines.join('\n') : '      (No visual diff)';

          // Build summary
          const action = fileExists ? 'Update' : 'Create';
          const additionText = additions === 1 ? '1 addition' : `${additions} additions`;
          const removalText = removals === 1 ? '1 removal' : `${removals} removals`;
          const summaryParts = [];
          if (additions > 0) summaryParts.push(additionText);
          if (removals > 0) summaryParts.push(removalText);
          const summaryText = summaryParts.length > 0 ? summaryParts.join(' and ') : 'no changes';

          return [
            `⏺ ${action}(${displayPath})`,
            `  ⎿  ${action}d ${displayPath} with ${summaryText}`,
            diffBlock,
          ].join('\n');
        } catch (error) {
          return `Error writing file: ${(error as Error).message}`;
        }
      },
    };
  }

  private createListFilesTool(): ToolDefinition<{ path: string; recursive?: string; pattern?: string }> {
    return {
      name: 'list_files',
      description: 'List files in a directory. Optionally filter by pattern and recurse into subdirectories.',
      parameters: objectSchema(
        {
          path: stringProp('Directory path to list'),
          recursive: stringProp('Recurse into subdirectories (default: false)'),
          pattern: stringProp('Glob pattern to filter files (e.g., "*.ts")'),
        },
        ['path']
      ),
      handler: async (args) => {
        try {
          const dirPath = this.resolvePath(args.path);
          const files = this.listDirectory(dirPath, args.recursive === 'true', args.pattern);
          return files.join('\n');
        } catch (error) {
          return `Error listing files: ${(error as Error).message}`;
        }
      },
    };
  }

  private createFileExistsTool(): ToolDefinition<{ path: string }> {
    return {
      name: 'file_exists',
      description: 'Check if a file or directory exists.',
      parameters: objectSchema(
        {
          path: stringProp('Path to check'),
        },
        ['path']
      ),
      handler: async (args) => {
        const filePath = this.resolvePath(args.path);
        const exists = fs.existsSync(filePath);
        if (exists) {
          const stat = fs.statSync(filePath);
          return `Exists: ${stat.isDirectory() ? 'directory' : 'file'}`;
        }
        return 'Does not exist';
      },
    };
  }

  // ============================================================================
  // EDIT TOOLS
  // ============================================================================

  private createEditFileTool(): ToolDefinition<{ path: string; oldText: string; newText: string }> {
    return {
      name: 'edit_file',
      description: 'Edit a file by replacing specific text. The oldText must match exactly.',
      parameters: objectSchema(
        {
          path: stringProp('Path to the file to edit'),
          oldText: stringProp('Exact text to find and replace'),
          newText: stringProp('Text to replace with'),
        },
        ['path', 'oldText', 'newText']
      ),
      handler: async (args) => {
        try {
          const filePath = this.resolvePath(args.path);
          const content = fs.readFileSync(filePath, 'utf-8');

          if (!content.includes(args.oldText)) {
            return `Error: Could not find the specified text in ${filePath}`;
          }

          const newContent = content.replace(args.oldText, args.newText);
          fs.writeFileSync(filePath, newContent, 'utf-8');

          return `Successfully edited ${filePath}`;
        } catch (error) {
          return `Error editing file: ${(error as Error).message}`;
        }
      },
    };
  }

  private createSearchReplaceTool(): ToolDefinition<{ path: string; search: string; replace: string; regex?: string; global?: string }> {
    return {
      name: 'search_replace',
      description: 'Search and replace text in a file. Supports regex patterns.',
      parameters: objectSchema(
        {
          path: stringProp('Path to the file'),
          search: stringProp('Text or regex pattern to search for'),
          replace: stringProp('Replacement text'),
          regex: stringProp('Treat search as regex (default: false)'),
          global: stringProp('Replace all occurrences (default: true)'),
        },
        ['path', 'search', 'replace']
      ),
      handler: async (args) => {
        try {
          const filePath = this.resolvePath(args.path);
          const content = fs.readFileSync(filePath, 'utf-8');

          let pattern: string | RegExp;
          if (args.regex === 'true') {
            const flags = args.global !== 'false' ? 'g' : '';
            pattern = new RegExp(args.search, flags);
          } else {
            pattern = args.global !== 'false'
              ? new RegExp(this.escapeRegex(args.search), 'g')
              : args.search;
          }

          const newContent = content.replace(pattern, args.replace);
          const matchCount = (content.match(pattern instanceof RegExp ? pattern : new RegExp(this.escapeRegex(args.search), 'g')) || []).length;

          fs.writeFileSync(filePath, newContent, 'utf-8');
          return `Replaced ${matchCount} occurrence(s) in ${filePath}`;
        } catch (error) {
          return `Error in search/replace: ${(error as Error).message}`;
        }
      },
    };
  }

  // ============================================================================
  // SEARCH TOOLS
  // ============================================================================

  private createGrepTool(): ToolDefinition<{ pattern: string; path?: string; filePattern?: string; contextLines?: string }> {
    return {
      name: 'grep',
      description: 'Search for a pattern in files. Returns matching lines with file names and line numbers.',
      parameters: objectSchema(
        {
          pattern: stringProp('Regex pattern to search for'),
          path: stringProp('Directory or file to search in (default: working directory)'),
          filePattern: stringProp('Filter files by glob pattern (e.g., "*.ts")'),
          contextLines: stringProp('Number of context lines around matches (default: 0)'),
        },
        ['pattern']
      ),
      handler: async (args) => {
        try {
          const searchPath = this.resolvePath(args.path ?? '.');
          const results: string[] = [];

          const files = fs.statSync(searchPath).isDirectory()
            ? this.listDirectory(searchPath, true, args.filePattern)
            : [searchPath];

          // Use regex without 'g' flag for test() to avoid lastIndex issues
          const regex = new RegExp(args.pattern, 'i');
          const contextLines = parseInt(args.contextLines ?? '0', 10) || 0;
          const matchedLineSet = new Set<string>(); // Prevent duplicate context lines

          for (const file of files.slice(0, 100)) { // Limit to 100 files
            try {
              // Skip binary files by checking for null bytes
              const buffer = fs.readFileSync(file);
              if (buffer.includes(0)) continue; // Binary file

              const content = buffer.toString('utf-8');
              // Skip very large files
              if (content.length > 1024 * 1024) continue; // > 1MB

              const lines = content.split('\n');
              const fileMatches: number[] = [];

              // First pass: find all matching line numbers
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  fileMatches.push(i);
                }
              }

              // Second pass: output with context, avoiding duplicates
              for (const matchIdx of fileMatches) {
                const start = Math.max(0, matchIdx - contextLines);
                const end = Math.min(lines.length - 1, matchIdx + contextLines);

                for (let j = start; j <= end; j++) {
                  const lineKey = `${file}:${j}`;
                  if (!matchedLineSet.has(lineKey)) {
                    matchedLineSet.add(lineKey);
                    const prefix = j === matchIdx ? '>' : ' ';
                    results.push(`${file}:${j + 1}:${prefix} ${lines[j]}`);
                  }
                }
                if (contextLines > 0 && matchIdx < fileMatches[fileMatches.length - 1]) {
                  results.push('--');
                }
              }
            } catch {
              // Skip unreadable files
            }

            // Stop if we have enough results
            if (results.length > 500) break;
          }

          return results.length > 0
            ? results.slice(0, 500).join('\n')
            : 'No matches found';
        } catch (error) {
          return `Error in grep: ${(error as Error).message}`;
        }
      },
    };
  }

  private createGlobTool(): ToolDefinition<{ pattern: string; path?: string }> {
    return {
      name: 'glob',
      description: 'Find files matching a glob pattern.',
      parameters: objectSchema(
        {
          pattern: stringProp('Glob pattern (e.g., "**/*.ts", "src/**/*.js")'),
          path: stringProp('Base directory (default: working directory)'),
        },
        ['pattern']
      ),
      handler: async (args) => {
        try {
          const basePath = this.resolvePath(args.path ?? '.');
          const files = this.listDirectory(basePath, true, args.pattern);
          return files.length > 0
            ? files.slice(0, 200).join('\n')
            : 'No files found matching pattern';
        } catch (error) {
          return `Error in glob: ${(error as Error).message}`;
        }
      },
    };
  }

  // ============================================================================
  // BASH TOOL
  // ============================================================================

  private createBashTool(): ToolDefinition<{ command: string; timeout?: string; cwd?: string }> {
    return {
      name: 'bash',
      description: 'Execute a bash command and return the output. Use for running builds, tests, git commands, etc.',
      parameters: objectSchema(
        {
          command: stringProp('The command to execute'),
          timeout: stringProp('Timeout in milliseconds (default: 30000)'),
          cwd: stringProp('Working directory for the command'),
        },
        ['command']
      ),
      handler: async (args) => {
        return new Promise((resolve) => {
          try {
            const timeout = parseInt(args.timeout ?? String(this.options.timeout), 10);
            const cwd = args.cwd ? this.resolvePath(args.cwd) : this.options.workingDir;

            const result = execSync(args.command, {
              cwd,
              timeout,
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            resolve(result.trim() || '(no output)');
          } catch (error: unknown) {
            const execError = error as { stdout?: string; stderr?: string; message: string };
            const stdout = execError.stdout ?? '';
            const stderr = execError.stderr ?? '';
            resolve(`Error: ${execError.message}\nStdout: ${stdout}\nStderr: ${stderr}`);
          }
        });
      },
    };
  }

  // ============================================================================
  // GIT TOOL
  // ============================================================================

  private createGitTool(): ToolDefinition<{ operation: string; args?: string }> {
    return {
      name: 'git',
      description: 'Execute git operations. Supports: status, diff, log, add, commit, push, pull, branch, checkout, merge, stash',
      parameters: objectSchema(
        {
          operation: stringProp(
            'Git operation',
            ['status', 'diff', 'log', 'add', 'commit', 'push', 'pull', 'branch', 'checkout', 'merge', 'stash', 'reset', 'fetch']
          ),
          args: stringProp('Additional arguments for the git command'),
        },
        ['operation']
      ),
      handler: async (args) => {
        try {
          const command = `git ${args.operation}${args.args ? ' ' + args.args : ''}`;
          const result = execSync(command, {
            cwd: this.options.workingDir,
            encoding: 'utf-8',
            timeout: this.options.timeout,
          });
          return result.trim() || '(no output)';
        } catch (error: unknown) {
          const execError = error as { stderr?: string; message: string };
          return `Git error: ${execError.stderr || execError.message}`;
        }
      },
    };
  }

  // ============================================================================
  // WEB TOOL
  // ============================================================================

  private createWebFetchTool(): ToolDefinition<{ url: string; method?: string; headers?: string }> {
    return {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Useful for downloading documentation or API responses.',
      parameters: objectSchema(
        {
          url: stringProp('URL to fetch'),
          method: stringProp('HTTP method (default: GET)'),
          headers: stringProp('JSON string of headers'),
        },
        ['url']
      ),
      handler: async (args) => {
        try {
          const headers: Record<string, string> = args.headers ? JSON.parse(args.headers) : {};
          const response = await fetch(args.url, {
            method: args.method ?? 'GET',
            headers,
          });

          if (!response.ok) {
            return `HTTP ${response.status}: ${response.statusText}`;
          }

          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('application/json')) {
            const json = await response.json();
            return JSON.stringify(json, null, 2);
          }

          const text = await response.text();
          return text.slice(0, 50000); // Limit response size
        } catch (error) {
          return `Fetch error: ${(error as Error).message}`;
        }
      },
    };
  }

  // ============================================================================
  // AGENT-SPAWN TOOLS — Claude-Code-style Agent + lifecycle tools
  // ============================================================================

  private createAgentSpawnTools(): ToolDefinition<Record<string, unknown>>[] {
    const provider = this.options.provider!;
    const parentDir = this.options.workingDir;
    const providerId = this.options.providerId;
    const modelId = this.options.modelId;

    // Defer registry creation so circular imports settle.
    // (import hoisted to top — ESM has no require())

    // Spawner closes over the LeanAgent class via lazy require.
    const spawner: import('../core/agentRegistry.js').AgentSpawnerFn = async (req, handle, deps) => {
      // (import hoisted to top — ESM has no require())
      const subAgent = new LeanAgent({
        provider: provider,
        workingDir: deps.workingDir,
        providerId: providerId,
        modelId: req.model ?? modelId,
        systemPrompt: this.subagentSystemPrompt(handle.type, deps.workingDir),
        capabilities: {
          ...this.options,
          subagentType: handle.type,
          // Don't pass parent's registry to a sub-agent.
          agentRegistry: undefined,
        },
      });
      const response = await subAgent.chat(req.prompt, false);
      handle.output = response.content;
      handle.continuation = {
        agentObject: subAgent,
        spawnOptions: req,
      };
    };

    const registry = this.options.agentRegistry ?? new AgentRegistry(
      { provider, workingDir: parentDir, providerId, modelId },
      spawner
    );
    // Cache for re-use within this capability instance.
    this.options.agentRegistry = registry;

    const tools: ToolDefinition<Record<string, unknown>>[] = [];

    // ---- Agent ---------------------------------------------------------------
    tools.push({
      name: 'Agent',
      description:
        'Spawn a sub-agent to handle a focused task. Pick subagent_type to ' +
        'control the toolset:\n' +
        '  - explore: read-only investigation (grep, glob, read_file, web_fetch). ' +
        'Use for "where is X defined", "find files matching Y" — much cheaper than general.\n' +
        '  - plan:    read-only design/planning. Returns a plan, no edits.\n' +
        '  - general: full toolset (default). Use only when the task needs writes.\n\n' +
        'Set run_in_background:true for long-running work; the tool returns immediately ' +
        'with an agent id you can poll via agent_status / agent_output.\n\n' +
        'Set isolation:"worktree" to run the sub-agent in a fresh git worktree so its ' +
        'edits don\'t collide with yours; the worktree path + branch come back in the result ' +
        'when changes were left behind.\n\n' +
        'Run multiple Agent calls in one tool message to fan out in parallel.',
      parameters: objectSchema(
        {
          description:    stringProp('3-5 word task label'),
          prompt:         stringProp('Full instructions for the sub-agent'),
          subagent_type:  stringProp('"explore" | "plan" | "general" (default general)', ['general', 'explore', 'plan']),
          model:          stringProp('Optional model override, e.g. "anvilwing-chat"'),
          isolation:      stringProp('"worktree" or "none" (default none)', ['worktree', 'none']),
          run_in_background: stringProp('"true" to return immediately with an id'),
        },
        ['description', 'prompt']
      ),
      handler: async (args) => {
        const description = String(args.description || '').slice(0, 80);
        const prompt = String(args.prompt || '');
        if (!prompt) return 'Error: prompt is required.';
        const subagent_type = (args.subagent_type as string) || 'general';
        if (!['general', 'explore', 'plan'].includes(subagent_type)) {
          return `Error: subagent_type must be general | explore | plan, got ${subagent_type}`;
        }
        const isolation = (args.isolation as string) === 'worktree' ? 'worktree' : 'none';
        const runInBg = String(args.run_in_background ?? '').toLowerCase() === 'true';
        const model = args.model ? String(args.model) : undefined;

        const handle = registry.spawn({
          subagent_type: subagent_type as 'general' | 'explore' | 'plan',
          description: description || subagent_type,
          prompt,
          model,
          isolation,
          run_in_background: runInBg,
        });

        if (runInBg) {
          return formatHandle(handle, /* compact */ true) +
            '\n(Background. Use agent_status / agent_output / agent_send_message / agent_stop to interact.)';
        }
        await registry.wait(handle.id);
        const finished = registry.get(handle.id) ?? handle;
        return formatHandle(finished, false);
      },
    });

    // ---- agent_list ----------------------------------------------------------
    tools.push({
      name: 'agent_list',
      description: 'List all sub-agents launched in this session (running and finished).',
      parameters: objectSchema({}, []),
      handler: async () => {
        const list = registry.list();
        if (list.length === 0) return 'No sub-agents have been spawned in this session.';
        return list.map((h) => formatHandle(h, true)).join('\n---\n');
      },
    });

    // ---- agent_status --------------------------------------------------------
    tools.push({
      name: 'agent_status',
      description: 'Get the status of a single sub-agent by id (without its full output).',
      parameters: objectSchema(
        { id: stringProp('Agent id returned by Agent') },
        ['id']
      ),
      handler: async (args) => {
        const id = String(args.id || '');
        const h = registry.get(id);
        if (!h) return `No agent with id ${id}.`;
        return formatHandle(h, true);
      },
    });

    // ---- agent_output --------------------------------------------------------
    tools.push({
      name: 'agent_output',
      description: 'Get the latest output from a sub-agent. If still running, returns whatever it has produced so far.',
      parameters: objectSchema(
        { id: stringProp('Agent id') },
        ['id']
      ),
      handler: async (args) => {
        const id = String(args.id || '');
        const h = registry.get(id);
        if (!h) return `No agent with id ${id}.`;
        return formatHandle(h, false);
      },
    });

    // ---- agent_stop ----------------------------------------------------------
    tools.push({
      name: 'agent_stop',
      description: 'Mark a running sub-agent as stopped. Best-effort: in-flight LLM calls will still complete.',
      parameters: objectSchema(
        { id: stringProp('Agent id') },
        ['id']
      ),
      handler: async (args) => {
        const id = String(args.id || '');
        const ok = registry.stop(id);
        return ok ? `Agent ${id} marked stopped.` : `Could not stop ${id} (not found or already finished).`;
      },
    });

    // ---- agent_send_message --------------------------------------------------
    tools.push({
      name: 'agent_send_message',
      description: 'Send a follow-up message to a sub-agent that has finished its initial task. Continues the conversation in the same context.',
      parameters: objectSchema(
        {
          id: stringProp('Agent id'),
          message: stringProp('Follow-up message'),
        },
        ['id', 'message']
      ),
      handler: async (args) => {
        const id = String(args.id || '');
        const message = String(args.message || '');
        if (!message) return 'Error: message is required.';
        try {
          const reply = await registry.sendMessage(id, message);
          return reply;
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      },
    });

    // ---- parallel_agents (back-compat) ---------------------------------------
    tools.push({
      name: 'parallel_agents',
      description:
        'Backwards-compatible: spawn N sub-agents in parallel from a JSON array. ' +
        'Prefer calling the `Agent` tool multiple times in one message instead — ' +
        'that gives per-agent type / isolation / model control.',
      parameters: objectSchema(
        { tasks: stringProp('JSON array of {id, description, prompt}') },
        ['tasks']
      ),
      handler: async (args) => {
        let specs: Array<{ id?: string; description?: string; prompt?: string }>;
        try { specs = JSON.parse(String(args.tasks ?? '')); }
        catch { return 'Error: invalid JSON in tasks.'; }
        if (!Array.isArray(specs) || specs.length === 0) return 'Error: tasks must be a non-empty array.';
        if (specs.length > 5) return 'Error: max 5 parallel tasks.';
        const handles = specs.map((s) =>
          registry.spawn({
            subagent_type: 'general',
            description: s.description || s.id || 'task',
            prompt: s.prompt || '',
          })
        );
        await Promise.all(handles.map((h) => registry.wait(h.id)));
        return handles
          .map((h) => formatHandle(registry.get(h.id) ?? h, false))
          .join('\n---\n');
      },
    });

    return tools;
  }

  private subagentSystemPrompt(type: import('../core/agentRegistry.js').AgentType, cwd: string): string {
    const role = {
      general: 'You are a focused sub-agent. Complete the task fully, report concisely. Make edits where needed.',
      explore: 'You are a read-only investigation sub-agent. Use grep/glob/read_file to answer the question. Do NOT attempt to edit files; you have no write tools.',
      plan: 'You are a planning sub-agent. Read what you need, then return a step-by-step plan. Do NOT edit files; the parent will execute.',
    }[type];
    return `${role}\n\nWorking directory: ${cwd}`;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private resolvePath(inputPath: string): string {
    const expanded = expandHome(inputPath);
    if (path.isAbsolute(expanded)) {
      return expanded;
    }
    return path.resolve(this.options.workingDir, expanded);
  }

  private listDirectory(dir: string, recursive: boolean, pattern?: string): string[] {
    const results: string[] = [];
    const regex = pattern ? this.globToRegex(pattern) : null;

    const walk = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          // Skip hidden files and common ignore patterns
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
          }

          if (entry.isDirectory()) {
            if (recursive) {
              walk(fullPath);
            }
          } else {
            // Match the anchored pattern against the basename (so `*.ts` finds
            // every .ts at any depth via the recursive walk) OR the path
            // RELATIVE to the search root (so `src/*.ts` / `**/*.ts` work) —
            // never the absolute path, which the leading dirs would defeat.
            const rel = path.relative(dir, fullPath);
            if (!regex || regex.test(entry.name) || regex.test(rel)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    walk(dir);
    return results;
  }

  // Mirrors the hardened converter in tools/searchTools.ts. The old body
  // (`*`→`.*`, unanchored, applied to the absolute path) OVER-MATCHED: `*.ts`
  // also caught `app.tsx`, `*.js` caught `package.json`, `src/*.ts` caught
  // nested grandchildren. `*` is bounded to a path segment, `**` spans depth,
  // and BOTH ends are anchored so the caller must match a relative path, not a
  // substring of the absolute one. (TODO: consolidate both copies onto
  // picomatch — kept hand-rolled here to avoid a semantic shift in this fix.)
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '<!GLOBSTAR_SLASH!>')
      .replace(/\*\*/g, '<!GLOBSTAR!>')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/<!GLOBSTAR_SLASH!>/g, '(?:.*/)?')
      .replace(/<!GLOBSTAR!>/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ============================================================================
// AGENT HANDLE FORMATTING
// ============================================================================

function formatHandle(
  h: import('../core/agentRegistry.js').AgentHandle,
  compact: boolean
): string {
  const elapsedMs = (h.endedAt ?? Date.now()) - h.startedAt;
  const lines: string[] = [
    `[${h.status.toUpperCase()}] ${h.id} · ${h.type} · ${h.description} · ${(elapsedMs / 1000).toFixed(1)}s`,
  ];
  if (h.worktreePath) {
    lines.push(`  worktree: ${h.worktreePath} (branch ${h.worktreeBranch})`);
  }
  if (compact) {
    return lines.join('\n');
  }
  if (h.error) {
    lines.push(`  error: ${h.error}`);
  }
  if (h.output) {
    lines.push('--- output ---');
    lines.push(h.output);
  } else if (h.status === 'running') {
    lines.push('  (no output yet — agent still running)');
  }
  return lines.join('\n');
}

// ============================================================================
// FACTORY & CONVENIENCE EXPORTS
// ============================================================================

export function createUnifiedCodingCapability(options?: UnifiedCodingOptions): UnifiedCodingCapabilityModule {
  return new UnifiedCodingCapabilityModule(options);
}

export default UnifiedCodingCapabilityModule;
