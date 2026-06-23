/**
 * Tool Contract v1.0
 * 
 * Stable interface for tool registration and execution.
 */

export const TOOL_CONTRACT_VERSION = '1.0.0';

/**
 * JSON Schema type definitions
 */
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

export interface JSONSchemaObject {
  type: 'object';
  description?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Tool definition
 */
export interface IToolDefinition {
  name: string;
  description: string;
  parameters?: JSONSchemaObject;
  category?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Tool execution request
 */
export interface ToolExecutionRequest {
  toolName: string;
  executionId: string;
  parameters: Record<string, unknown>;
  context?: ToolExecutionContext;
}

/**
 * Tool execution response
 */
export interface ToolExecutionResponse {
  executionId: string;
  success: boolean;
  result?: string;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
  metadata?: {
    elapsedMs?: number;
    cached?: boolean;
  };
}

/**
 * Tool execution context
 */
export interface ToolExecutionContext {
  workingDirectory?: string;
  environment?: Record<string, string>;
  user?: {
    id: string;
    permissions?: string[];
  };
}

/**
 * Tool suite definition
 */
export interface IToolSuite {
  id: string;
  name: string;
  description?: string;
  version?: string;
  tools: IToolDefinition[];
  metadata?: Record<string, unknown>;
}

/**
 * Tool handler function
 */
export type ToolHandler = (
  parameters: Record<string, unknown>,
  context?: ToolExecutionContext
) => Promise<string> | string;

/**
 * Tool executor interface
 */
export interface IToolExecutor {
  /**
   * Execute a tool
   */
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse>;

  /**
   * Check if a tool is available
   */
  hasToolAvailable(toolName: string): boolean;

  /**
   * List all available tools
   */
  listTools(): IToolDefinition[];

  /**
   * Get tool definition
   */
  getToolDefinition(toolName: string): IToolDefinition | null;
}

/**
 * Tool registry interface
 */
export interface IToolRegistry {
  /**
   * Register a tool suite
   */
  registerSuite(suite: IToolSuite): void;

  /**
   * Unregister a tool suite
   */
  unregisterSuite(suiteId: string): void;

  /**
   * Register a single tool
   */
  registerTool(suiteId: string, definition: IToolDefinition, handler: ToolHandler): void;

  /**
   * Unregister a single tool
   */
  unregisterTool(toolName: string): void;

  /**
   * Get all registered suites
   */
  getSuites(): IToolSuite[];

  /**
   * Get a specific suite
   */
  getSuite(suiteId: string): IToolSuite | null;
}
