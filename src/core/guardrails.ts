/**
 * Runtime Guardrails for Revenue Suite
 * Enforces citations, approvals, and audit logging as per manifest requirements
 */
import { reportStatusError } from '../utils/statusReporter.js';

export interface Citation {
  sourceDoc: string;
  section?: string;
  version?: string;
  lineNumber?: number;
  quote?: string;
}

export interface ApprovalRequest {
  id: string;
  actionType: string;
  actionDescription: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiredApprover: string;
  context: Record<string, any>;
  requestedAt: Date;
}

export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  approver: string;
  approvedAt: Date;
  notes?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  correlationId: string;
  userId: string;
  actionType: string;
  actionDescription: string;
  inputs: Record<string, any>;
  outputs?: Record<string, any>;
  citations?: Citation[];
  approvalId?: string;
  status: 'success' | 'failed' | 'pending_approval';
  errorMessage?: string;
  metadata?: Record<string, any>;
}

/**
 * Citation Validator
 * Ensures every claim has proper source attribution
 */
export class CitationValidator {
  /**
   * Validates that a response includes proper citations
   */
  validateCitations(response: string, citations: Citation[]): {
    valid: boolean;
    coverage: number;
    missing: string[];
  } {
    if (citations.length === 0) {
      return {
        valid: false,
        coverage: 0,
        missing: ['No citations provided']
      };
    }

    // Check for citation markers in response (e.g., [1], [Source: ...])
    const citationMarkers = response.match(/\[(\d+|Source:.*?)\]/g) || [];

    // Check for factual claims without citations
    const claimPatterns = [
      /\b(according to|as stated in|referenced in|cited in)\b/gi,
      /\b(our policy|our documentation|our guide)\b/gi
    ];

    const hasClaimMarkers = claimPatterns.some(pattern => pattern.test(response));
    const hasCitations = citations.length > 0;

    if (hasClaimMarkers && !hasCitations) {
      return {
        valid: false,
        coverage: 0,
        missing: ['Claims detected but no citations provided']
      };
    }

    // Basic validation: ensure citations have required fields
    const invalidCitations = citations.filter(c => !c.sourceDoc);
    if (invalidCitations.length > 0) {
      return {
        valid: false,
        coverage: (citations.length - invalidCitations.length) / citations.length * 100,
        missing: invalidCitations.map((_, i) => `Citation ${i + 1} missing sourceDoc`)
      };
    }

    // All validations passed
    return {
      valid: true,
      coverage: 100,
      missing: []
    };
  }

  /**
   * Extracts citations from structured response
   */
  extractCitations(response: any): Citation[] {
    if (typeof response === 'string') {
      // Parse citations from markdown-style references
      const citations: Citation[] = [];
      const citationRegex = /\[Source:\s*([^\]]+)\]/g;
      let match;

      while ((match = citationRegex.exec(response)) !== null) {
        const parts = match[1].split(',').map(p => p.trim());
        citations.push({
          sourceDoc: parts[0],
          section: parts[1],
          version: parts[2]
        });
      }

      return citations;
    }

    // Handle structured response with citations array
    if (response && Array.isArray(response.citations)) {
      return response.citations;
    }

    return [];
  }
}

/**
 * Approval Manager
 * Handles human-in-the-loop approval workflows
 */
export class ApprovalManager {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalHistory: Map<string, ApprovalResponse> = new Map();

  /**
   * Request approval for a high-risk action
   */
  async requestApproval(
    actionType: string,
    actionDescription: string,
    riskLevel: ApprovalRequest['riskLevel'],
    requiredApprover: string,
    context: Record<string, any>
  ): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `APPROVAL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      actionType,
      actionDescription,
      riskLevel,
      requiredApprover,
      context,
      requestedAt: new Date()
    };

    this.pendingApprovals.set(request.id, request);

    // Send notification to approver (email, Slack, webhook, etc.)
    console.log(`⚠️  Approval required: ${actionDescription}`);
    console.log(`   Approver: ${requiredApprover}`);
    console.log(`   Risk Level: ${riskLevel}`);
    console.log(`   Approval ID: ${request.id}`);
    // TODO: Implement actual notification system (email, Slack, webhook)

    return request;
  }

  /**
   * Record an approval response
   */
  async recordApproval(response: ApprovalResponse): Promise<void> {
    this.approvalHistory.set(response.requestId, response);
    this.pendingApprovals.delete(response.requestId);
  }

  /**
   * Check if an action requires approval based on policy
   */
  requiresApproval(
    actionType: string,
    actionContext: Record<string, any>
  ): { required: boolean; approver?: string; riskLevel?: ApprovalRequest['riskLevel'] } {
    // Define approval policies
    const policies = [
      {
        condition: (type: string, ctx: any) =>
          type === 'refund' && ctx.amount > 50000,
        approver: 'finance_director',
        riskLevel: 'high' as const
      },
      {
        condition: (type: string, ctx: any) =>
          type === 'contract_edit',
        approver: 'legal_counsel',
        riskLevel: 'critical' as const
      },
      {
        condition: (type: string, ctx: any) =>
          type === 'crm_update' && ctx.dealValue > 100000,
        approver: 'sales_director',
        riskLevel: 'medium' as const
      },
      {
        condition: (type: string, ctx: any) =>
          type === 'data_export' && ctx.pii === true,
        approver: 'compliance_officer',
        riskLevel: 'high' as const
      }
    ];

    const matchedPolicy = policies.find(p => p.condition(actionType, actionContext));

    if (matchedPolicy) {
      return {
        required: true,
        approver: matchedPolicy.approver,
        riskLevel: matchedPolicy.riskLevel
      };
    }

    return { required: false };
  }

  /**
   * Get pending approval by ID
   */
  getPendingApproval(id: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(id);
  }

  /**
   * Get approval status
   */
  getApprovalStatus(id: string): ApprovalResponse | undefined {
    return this.approvalHistory.get(id);
  }
}

/**
 * Audit Logger
 * Logs all actions with inputs, outputs, and correlation IDs
 */
export class AuditLogger {
  private logs: AuditLogEntry[] = [];
  private observabilityEndpoint?: string;

  constructor(observabilityEndpoint?: string) {
    this.observabilityEndpoint = observabilityEndpoint || process.env.OBSERVABILITY_ENDPOINT;
  }

  /**
   * Log an action with full context
   */
  async logAction(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<string> {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: `AUDIT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    };

    // Redact PII from logs
    const redactedEntry = this.redactPII(fullEntry);

    // Store locally
    this.logs.push(redactedEntry);

    // Send to observability endpoint if configured
    if (this.observabilityEndpoint) {
      try {
        await this.sendToObservability(redactedEntry);
      } catch (error) {
        reportStatusError(error, 'Failed to send audit log to observability endpoint');
        // Continue - don't fail the action if logging fails
      }
    }

    // Also log to console for development
    console.log(`[AUDIT] ${redactedEntry.actionType}: ${redactedEntry.status}`);

    return fullEntry.id;
  }

  /**
   * Redact PII from audit logs
   */
  private redactPII(entry: AuditLogEntry): AuditLogEntry {
    const piiPatterns = [
      { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: 'SSN-REDACTED' }, // SSN
      { regex: /\b\d{16}\b/g, replacement: 'CC-REDACTED' }, // Credit card
      { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: 'EMAIL-REDACTED' } // Email (optional)
    ];

    const redactedEntry = { ...entry };

    // Redact inputs
    if (entry.inputs) {
      const inputsStr = JSON.stringify(entry.inputs);
      let redactedStr = inputsStr;
      for (const pattern of piiPatterns) {
        redactedStr = redactedStr.replace(pattern.regex, pattern.replacement);
      }
      redactedEntry.inputs = JSON.parse(redactedStr);
    }

    // Redact outputs
    if (entry.outputs) {
      const outputsStr = JSON.stringify(entry.outputs);
      let redactedStr = outputsStr;
      for (const pattern of piiPatterns) {
        redactedStr = redactedStr.replace(pattern.regex, pattern.replacement);
      }
      redactedEntry.outputs = JSON.parse(redactedStr);
    }

    return redactedEntry;
  }

  /**
   * Send audit log to external observability system
   */
  private async sendToObservability(entry: AuditLogEntry): Promise<void> {
    if (!this.observabilityEndpoint) {
      return;
    }

    // TODO: Implement actual HTTP POST to observability endpoint
    // Use fetch or axios
    console.log(`Sending audit log to ${this.observabilityEndpoint}:`, entry.id);

    // Example implementation:
    // await fetch(this.observabilityEndpoint, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(entry)
    // });
  }

  /**
   * Query audit logs by correlation ID
   */
  getLogsByCorrelationId(correlationId: string): AuditLogEntry[] {
    return this.logs.filter(log => log.correlationId === correlationId);
  }

  /**
   * Query audit logs by user ID
   */
  getLogsByUserId(userId: string): AuditLogEntry[] {
    return this.logs.filter(log => log.userId === userId);
  }

  /**
   * Get all logs (for testing/debugging)
   */
  getAllLogs(): AuditLogEntry[] {
    return [...this.logs];
  }
}

/**
 * Guardrails Orchestrator
 * Coordinates citation validation, approval flows, and audit logging
 */
export class GuardrailsOrchestrator {
  private citationValidator: CitationValidator;
  private approvalManager: ApprovalManager;
  private auditLogger: AuditLogger;

  constructor(observabilityEndpoint?: string) {
    this.citationValidator = new CitationValidator();
    this.approvalManager = new ApprovalManager();
    this.auditLogger = new AuditLogger(observabilityEndpoint);
  }

  getCitationValidator(): CitationValidator {
    return this.citationValidator;
  }

  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  /**
   * Execute an action with full guardrail enforcement
   */
  async executeWithGuardrails<T>(
    userId: string,
    correlationId: string,
    actionType: string,
    actionDescription: string,
    actionFn: () => Promise<T>,
    inputs: Record<string, any>,
    options: {
      requireCitations?: boolean;
      citations?: Citation[];
    } = {}
  ): Promise<T> {
    // 1. Check if approval is required
    const approvalCheck = this.approvalManager.requiresApproval(actionType, inputs);

    if (approvalCheck.required) {
      const approvalRequest = await this.approvalManager.requestApproval(
        actionType,
        actionDescription,
        approvalCheck.riskLevel!,
        approvalCheck.approver!,
        inputs
      );

      // TODO: Wait for approval (implement polling or webhook callback)
      throw new Error(
        `Action requires approval from ${approvalCheck.approver}. ` +
        `Approval ID: ${approvalRequest.id}`
      );
    }

    // 2. Validate citations if required
    if (options.requireCitations) {
      const citationValidation = this.citationValidator.validateCitations(
        actionDescription,
        options.citations || []
      );

      if (!citationValidation.valid) {
        await this.auditLogger.logAction({
          correlationId,
          userId,
          actionType,
          actionDescription,
          inputs,
          status: 'failed',
          errorMessage: `Citation validation failed: ${citationValidation.missing.join(', ')}`,
          citations: options.citations
        });

        throw new Error(
          `Citation requirement not met: ${citationValidation.missing.join(', ')}`
        );
      }
    }

    // 3. Execute action with audit logging
    try {
      const result = await actionFn();

      await this.auditLogger.logAction({
        correlationId,
        userId,
        actionType,
        actionDescription,
        inputs,
        outputs: result as any,
        citations: options.citations,
        status: 'success'
      });

      return result;
    } catch (error) {
      await this.auditLogger.logAction({
        correlationId,
        userId,
        actionType,
        actionDescription,
        inputs,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        citations: options.citations
      });

      throw error;
    }
  }
}

// Singleton instance
let guardrailsInstance: GuardrailsOrchestrator | null = null;

/**
 * Get or create the guardrails orchestrator instance
 */
export function getGuardrails(observabilityEndpoint?: string): GuardrailsOrchestrator {
  if (!guardrailsInstance) {
    guardrailsInstance = new GuardrailsOrchestrator(observabilityEndpoint);
  }
  return guardrailsInstance;
}
