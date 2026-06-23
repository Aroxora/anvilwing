/**
 * HITL Tools - The ONLY human-in-the-loop tools in the repository
 * Provides decision points for critical operations
 */

import type { ToolDefinition } from '../core/toolRuntime.js';
import { getHITL, hitl, type DecisionOption, type DecisionRequest } from '../core/hitl.js';

interface HITLRequestArgs {
  title: string;
  description: string;
  context?: string;
  options?: Array<{
    id: string;
    label: string;
    description: string;
    shortcut?: string;
  }>;
  defaultOptionId?: string;
  requiresExplicitChoice?: boolean;
  autoPause?: boolean;
  timeoutMs?: number;
}

interface YesNoArgs {
  title: string;
  description: string;
  context?: string;
  defaultYes?: boolean;
}

interface SelectOptionArgs {
  title: string;
  description: string;
  options: string; // JSON string of options
  context?: string;
  defaultOptionId?: string;
}

interface ApprovalArgs {
  title: string;
  riskDescription: string;
  operationDetails?: string;
}

export function createHITLTools(): ToolDefinition<any>[] {
  return [
    {
      name: 'HITL_Decision',
      description: 'Pause execution and ask the human to choose between 2-4 distinct alternatives YOU generate. Provide as many substantively different options as the decision genuinely has (2, 3, or 4) — never pad with filler to reach a count. Put your recommended option FIRST. The options should span the realistic decision space (e.g. conservative vs. aggressive, narrow vs. broad scope). The UI also offers an "Enter your own" write-in, so the user can always reject them and propose their own plan. Use HITL_YesNo for a genuine yes/no.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Decision title/question' },
          description: { type: 'string', description: 'Detailed description of the decision' },
          context: { type: 'string', description: 'Additional context information' },
          options: {
            type: 'array',
            description: '2-4 distinct candidate options, RECOMMENDED ONE FIRST. The UI automatically appends an "Enter your own" write-in so the user can also propose an alternative. Do not pad to a fixed count.',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
                shortcut: { type: 'string' }
              },
              required: ['id', 'label', 'description']
            }
          },
          defaultOptionId: { type: 'string', description: 'Default option ID (defaults to the first/recommended option)' },
          requiresExplicitChoice: { type: 'boolean', description: 'Require explicit user choice' },
          autoPause: { type: 'boolean', description: 'Auto-pause execution for decision' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (0 = no timeout)' }
        },
        required: ['title', 'description', 'options']
      },
      handler: async (args: Record<string, unknown>) => {
        const typedArgs = args as unknown as HITLRequestArgs;
        const hitlSystem = getHITL({
          autoPause: typedArgs.autoPause ?? true,
          timeoutMs: typedArgs.timeoutMs ?? 0,
          logLevel: 'detailed'
        });

        const options: DecisionOption[] = ((typedArgs.options || []) as any[]).map(opt => ({
          id: opt.id,
          label: opt.label,
          description: opt.description,
          shortcut: opt.shortcut
        }));

        // Allow 2-4 options (audit #18). The old "exactly 4" rule forced the
        // model to pad fake alternatives for a 2- or 3-way decision, and a
        // legitimate 2-option send threw + burned a turn. The "Enter your own"
        // write-in is appended by the UI, so the human always has an escape.
        if (options.length < 2 || options.length > 4) {
          throw new Error(
            `HITL_Decision needs 2-4 distinct options, got ${options.length}. ` +
            `Provide as many real alternatives as the decision has (recommended one first); ` +
            `don't pad to a fixed count. Use HITL_YesNo for a genuine yes/no.`
          );
        }
        // Default to the first (recommended) option when the model didn't name
        // one — so dismissal/timeout lands on the recommendation, not option N.
        if (!typedArgs.defaultOptionId && options[0]) {
          typedArgs.defaultOptionId = options[0].id;
        }

        const selectedOptionId = await hitlSystem.requestDecision({
          id: `hitl-tool-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          title: typedArgs.title,
          description: typedArgs.description,
          context: typedArgs.context || '',
          options,
          defaultOptionId: typedArgs.defaultOptionId,
          requiresExplicitChoice: typedArgs.requiresExplicitChoice ?? true
        });

        const selectedOption = options.find(opt => opt.id === selectedOptionId);

        // The user chose "Enter your own" — surface their actual instruction so
        // the model acts on it. Without this it only saw a synthetic id and the
        // user's typed plan was silently dropped (audit #13).
        const customInput = hitlSystem.getDecisionInput(selectedOptionId);
        if (customInput) {
          return `HITL decision: the user rejected all listed options and wrote their own instruction:
"${customInput}"

Follow this instruction directly. Do not re-ask.`;
        }

        return `HITL decision: ${selectedOption?.label || selectedOptionId}
Selected option ID: ${selectedOptionId}
Timestamp: ${new Date().toISOString()}
Note: HITL decision recorded.`;
      }
    },
    {
      name: 'HITL_YesNo',
      description: 'Simple yes/no decision point',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Decision title/question' },
          description: { type: 'string', description: 'Detailed description' },
          context: { type: 'string', description: 'Additional context' },
          defaultYes: { type: 'boolean', description: 'Default to yes (true) or no (false)' }
        },
        required: ['title', 'description']
      },
      handler: async (args: Record<string, unknown>) => {
        const typedArgs = args as unknown as YesNoArgs;
        const result = await hitl.askYesNo(
          typedArgs.title,
          typedArgs.description,
          typedArgs.context || '',
          typedArgs.defaultYes ?? true
        );

        return `HITL yes/no decision: ${result ? 'yes' : 'no'}
Approved: ${result}
Timestamp: ${new Date().toISOString()}
Note: HITL yes/no decision recorded`;
      }
    },
    {
      name: 'HITL_Select',
      description: 'Select from multiple options',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Selection title' },
          description: { type: 'string', description: 'Detailed description' },
          options: { type: 'string', description: 'JSON array of options: [{id, label, description}]' },
          context: { type: 'string', description: 'Additional context' },
          defaultOptionId: { type: 'string', description: 'Default option ID' }
        },
        required: ['title', 'description', 'options']
      },
      handler: async (args: Record<string, unknown>) => {
        const typedArgs = args as unknown as SelectOptionArgs;
        let options: Array<{id: string, label: string, description: string}>;
        try {
          options = JSON.parse(typedArgs.options);
        } catch (error) {
          throw new Error(`Invalid options JSON: ${error}`);
        }

        const result = await hitl.selectOption(
          typedArgs.title,
          typedArgs.description,
          options,
          typedArgs.context || '',
          typedArgs.defaultOptionId
        );

        const selectedOption = options.find(opt => opt.id === result);
        
        return `HITL selection: ${selectedOption?.label || result}
Selected option ID: ${result}
Timestamp: ${new Date().toISOString()}
Note: HITL selection recorded`;
      }
    },
    {
      name: 'HITL_Approval',
      description: 'Request approval for risky operation',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Approval title' },
          riskDescription: { type: 'string', description: 'Description of risks' },
          operationDetails: { type: 'string', description: 'Detailed operation description' }
        },
        required: ['title', 'riskDescription']
      },
      handler: async (args: Record<string, unknown>) => {
        const typedArgs = args as unknown as ApprovalArgs;
        const result = await hitl.requestApproval(
          typedArgs.title,
          typedArgs.riskDescription,
          typedArgs.operationDetails || ''
        );

        return `HITL approval: ${result ? 'approved' : 'rejected'}
Approved: ${result}
Timestamp: ${new Date().toISOString()}
Note: ${result ? 'Operation approved via HITL' : 'Operation rejected via HITL'}`;
      }
    },
    {
      name: 'HITL_Status',
      description: 'Get HITL system status and history',
      parameters: {
        type: 'object',
        properties: {
          clearHistory: { type: 'boolean', description: 'Clear decision history' }
        }
      },
      handler: async (args: { clearHistory?: boolean }) => {
        const hitlSystem = getHITL();
        
        if (args.clearHistory) {
          hitlSystem.clearHistory();
          return `HITL history cleared
Timestamp: ${new Date().toISOString()}`;
        }

        const history = hitlSystem.getHistory();
        
        const recentDecisions = history.slice(-5).map(decision => ({
          requestId: decision.requestId,
          selectedOptionId: decision.selectedOptionId,
          timestamp: decision.timestamp.toISOString(),
          hasCustomInput: !!decision.userInput
        }));

        return `HITL System Status
Status: active
Total decisions: ${history.length}
Recent decisions:
${recentDecisions.map(d => `  • ${d.selectedOptionId} at ${d.timestamp}${d.hasCustomInput ? ' (custom input)' : ''}`).join('\n')}
Note: This is the ONLY human-in-the-loop system in the repository`;
      }
    }
  ];
}