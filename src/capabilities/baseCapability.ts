/**
 * BASE CAPABILITY MODULE - SHARED INFRASTRUCTURE FOR ALL CAPABILITIES
 * 
 * Provides common utilities, patterns, and infrastructure for all capability modules
 * to promote code reuse and maintain consistency across the codebase.
 */

import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import type { ToolSuite, ToolDefinition } from '../core/toolRuntime.js';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// SHARED TYPES AND INTERFACES
// ============================================================================

export interface BaseCapabilityOptions {
  /** Working directory for operations */
  workingDir?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable evidence collection */
  enableEvidence?: boolean;
  /** Authorization level for operations */
  authorization?: 'basic' | 'elevated' | 'military' | 'full';
  /** Emergency override capability */
  emergencyOverride?: boolean;
}

export interface OperationResult {
  success: boolean;
  timestamp: string;
  operationId: string;
  metadata: Record<string, any>;
  evidence?: string[];
  errors?: string[];
}

export interface EvidenceCollector {
  collect(data: any, type: string): string;
  save(fileName: string, content: any): string;
  cleanup(olderThan?: number): void;
}

export interface SecurityContext {
  hostname: string;
  username: string;
  platform: string;
  architecture: string;
  os: string;
  userAgent?: string;
}

// ============================================================================
// SHARED UTILITIES
// ============================================================================

export class SharedUtilities {
  static generateOperationId(prefix: string = 'op'): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${prefix}_${timestamp}_${random}`;
  }

  static createEvidenceDir(baseDir: string, operationId: string): string {
    const evidenceDir = path.join(baseDir, 'evidence', operationId);
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }
    return evidenceDir;
  }

  static saveEvidence(evidenceDir: string, fileName: string, data: any): string {
    const filePath = path.join(evidenceDir, fileName);
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  static getSecurityContext(): SecurityContext {
    return {
      hostname: os.hostname(),
      username: os.userInfo().username,
      platform: os.platform(),
      architecture: os.arch(),
      os: os.type(),
      userAgent: process.env['USER_AGENT'] || 'AGI-Core/1.0'
    };
  }

  static calculateChecksum(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  static validateAuthorization(current: string, required: string): boolean {
    const levels = ['basic', 'elevated', 'military', 'full'];
    const currentIndex = levels.indexOf(current);
    const requiredIndex = levels.indexOf(required);
    return currentIndex >= requiredIndex;
  }

  static createToolDefinition<T extends Record<string, unknown>>(
    name: string,
    description: string,
    parameters: any,
    handler: (args: T) => Promise<string> | string
  ): ToolDefinition<T> {
    return {
      name,
      description,
      parameters,
      handler
    };
  }
}

// ============================================================================
// BASE CAPABILITY CLASS
// ============================================================================

export abstract class BaseCapabilityModule implements CapabilityModule {
  abstract readonly id: string;
  protected readonly options: BaseCapabilityOptions;
  protected readonly utilities: SharedUtilities;
  protected evidenceCollector: EvidenceCollector | null = null;

  constructor(options: BaseCapabilityOptions = {}) {
    this.options = {
      workingDir: process.cwd(),
      debug: false,
      enableEvidence: true,
      authorization: 'basic',
      emergencyOverride: false,
      ...options
    };
    this.utilities = SharedUtilities;
  }

  abstract create(context: CapabilityContext): Promise<CapabilityContribution>;

  protected initializeEvidenceCollector(): void {
    if (this.options.enableEvidence) {
      this.evidenceCollector = {
        collect: (data: any, type: string) => {
          const evidenceDir = SharedUtilities.createEvidenceDir(
            this.options.workingDir!,
            SharedUtilities.generateOperationId()
          );
          const fileName = `${type}_${Date.now()}.json`;
          return SharedUtilities.saveEvidence(evidenceDir, fileName, data);
        },
        save: (fileName: string, content: any) => {
          const evidenceDir = SharedUtilities.createEvidenceDir(
            this.options.workingDir!,
            'misc'
          );
          return SharedUtilities.saveEvidence(evidenceDir, fileName, content);
        },
        cleanup: (olderThan?: number) => {
          const evidenceDir = path.join(this.options.workingDir!, 'evidence');
          if (fs.existsSync(evidenceDir)) {
            const cutoff = olderThan || (Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: 7 days
            this.cleanupOldFiles(evidenceDir, cutoff);
          }
        }
      };
    }
  }

  private cleanupOldFiles(dir: string, cutoff: number): void {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          this.cleanupOldFiles(filePath, cutoff);
        } else if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      // Silent fail for cleanup operations
    }
  }

  protected log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    if (this.options.debug || level !== 'debug') {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.id}]`;
      console.log(`${prefix} ${message}`);
    }
  }

  protected validateOperation(authorizationRequired: string = 'basic'): boolean {
    if (this.options.emergencyOverride) {
      return true;
    }
    
    const isValid = SharedUtilities.validateAuthorization(
      this.options.authorization!,
      authorizationRequired
    );
    
    if (!isValid) {
      this.log(`Authorization required: ${authorizationRequired}, current: ${this.options.authorization}`, 'warn');
    }
    
    return isValid;
  }

  protected createOperationResult(
    success: boolean,
    operationId: string,
    metadata: Record<string, any> = {},
    errors: string[] = []
  ): OperationResult {
    const result: OperationResult = {
      success,
      timestamp: new Date().toISOString(),
      operationId,
      metadata: {
        ...metadata,
        securityContext: SharedUtilities.getSecurityContext(),
        capabilityId: this.id
      },
      errors: errors.length > 0 ? errors : undefined
    };

    if (this.evidenceCollector && success) {
      try {
        const evidencePath = this.evidenceCollector.collect(result, 'operation_result');
        result.evidence = [evidencePath];
      } catch (error) {
        // Evidence collection is optional
      }
    }

    return result;
  }
}

// ============================================================================
// TOOL SUITE BUILDER
// ============================================================================

export class ToolSuiteBuilder {
  private tools: ToolDefinition<any>[] = [];
  private id: string;
  private description: string;

  constructor(id: string, description: string) {
    this.id = id;
    this.description = description;
  }

  addTool<T extends Record<string, unknown>>(
    name: string,
    description: string,
    parameters: any,
    handler: (args: T) => Promise<string> | string
  ): this {
    this.tools.push(SharedUtilities.createToolDefinition(name, description, parameters, handler));
    return this;
  }

  build(): ToolSuite {
    return {
      id: this.id,
      description: this.description,
      tools: this.tools
    };
  }
}