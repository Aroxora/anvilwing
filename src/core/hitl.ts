/**
 * Human-in-the-Loop (HITL) System
 * Pauses AI execution and prompts users for important decision paths
 * This is the ONLY HITL system in the repository
 */

import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import { authorizedShutdown, isShutdownInProgress, onShutdown, installSignalHandlers } from './shutdown.js';

/**
 * Module-level event bus that fires when a HITL prompt opens or closes. Other
 * subsystems subscribe to:
 *   - pause their own run-timeouts so user think-time doesn't abort the agent
 *     (see AgentController),
 *   - hand the terminal off cleanly so the prompt and post-prompt I/O don't
 *     fight (see UnifiedUIRenderer / interactiveShell).
 *
 * Always paired: every `prompt-open` is followed by exactly one `prompt-close`,
 * including on timeout, Ctrl+C, custom-input, and shutdown paths.
 */
export const hitlEvents = new EventEmitter();
hitlEvents.setMaxListeners(50);

let activePromptCount = 0;

export function isHITLPromptActive(): boolean {
  return activePromptCount > 0;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
}

export interface DecisionRequest {
  id: string;
  title: string;
  description: string;
  context: string;
  options: DecisionOption[];
  defaultOptionId?: string;
  requiresExplicitChoice: boolean;
  metadata?: Record<string, any>;
}

export interface DecisionResponse {
  requestId: string;
  selectedOptionId: string;
  userInput?: string;
  timestamp: Date;
}

/** The user's pick from a presented decision. `customInput` is set only when
 *  they chose the write-in ("Enter your own"). */
export interface DecisionChoice {
  optionId: string;
  customInput?: string;
}

/**
 * A UI presenter for HITL decisions. When one is registered (the Ink shell
 * does this on startup), decisions render through the in-app menu BELOW the
 * prompt — same arrow+Enter UX as the slash palette — instead of the
 * full-screen-clearing raw-mode fallback. Headless/non-Ink runs leave it null
 * and get the raw-mode menu.
 */
export type DecisionPresenter = (request: DecisionRequest) => Promise<DecisionChoice>;
let decisionPresenter: DecisionPresenter | null = null;
export function setDecisionPresenter(presenter: DecisionPresenter | null): void {
  decisionPresenter = presenter;
}

export interface HITLConfig {
  /**
   * Whether to automatically pause execution for decisions
   * If false, decisions will be logged but execution continues
   */
  autoPause: boolean;
  
  /**
   * Timeout in milliseconds before auto-proceeding with default
   * 0 means no timeout (wait indefinitely)
   */
  timeoutMs: number;
  
  /**
   * Default option to choose if timeout occurs
   */
  timeoutDefaultOptionId?: string;
  
  /**
   * Log level: 'none' | 'minimal' | 'detailed'
   */
  logLevel: 'none' | 'minimal' | 'detailed';
}

/**
 * Cap the in-memory decision log so a long-lived HITL singleton can't grow it
 * without bound over a multi-hour agent run. FIFO: oldest decisions drop first.
 */
const MAX_DECISION_HISTORY = 100;

export class HITLSystem {
  private config: HITLConfig;
  private pendingDecisions: Map<string, DecisionRequest> = new Map();
  private decisionHistory: DecisionResponse[] = [];
  // Don't-ask-again: byte-identical decisions answered this session → their
  // answer, so the human isn't re-interrupted by a repeat prompt (#17).
  private answeredFingerprints = new Map<string, { selectedOptionId: string; userInput?: string }>();
  private rl?: readline.Interface;

  constructor(config?: Partial<HITLConfig>) {
    this.config = {
      autoPause: true,
      timeoutMs: 0,
      logLevel: 'detailed',
      ...config
    };
  }

  /**
   * Request a human decision
   * @returns Promise that resolves with the selected option ID
   */
  async requestDecision(request: DecisionRequest): Promise<string> {
    // If request already has an ID, use it, otherwise generate one
    const requestId = request.id || `DECISION-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const fullRequest: DecisionRequest = {
      ...request,
      id: requestId
    };

    this.pendingDecisions.set(requestId, fullRequest);

    // Don't-ask-again (audit #17): a BYTE-IDENTICAL decision already answered
    // this session returns the prior answer instead of re-interrupting the
    // human. Keyed on title+description+option ids/labels, so two genuinely
    // different decisions that happen to share a title still both prompt.
    const fingerprint = this.decisionFingerprint(request);
    const prior = this.answeredFingerprints.get(fingerprint);
    if (prior) {
      this.recordDecision({ requestId, selectedOptionId: prior.selectedOptionId, userInput: prior.userInput, timestamp: new Date() });
      return prior.selectedOptionId;
    }

    if (this.config.logLevel !== 'none') {
      this.logDecisionRequest(fullRequest);
    }

    // If auto-pause is disabled, return default or first option
    if (!this.config.autoPause) {
      const selectedOptionId = request.defaultOptionId || request.options[0]?.id;
      if (selectedOptionId) {
        const response: DecisionResponse = {
          requestId,
          selectedOptionId,
          timestamp: new Date()
        };
        this.recordDecision(response);
        
        if (this.config.logLevel === 'detailed') {
          console.log(chalk.yellow(`Auto-proceeding with option: ${this.getOptionLabel(request, selectedOptionId)}`));
        }
        return selectedOptionId;
      }
    }

    // Show decision prompt to user
    return this.promptUserForDecision(fullRequest);
  }

  /**
   * Present decision to user and wait for input using interactive arrow-key selection
   */
  private async promptUserForDecision(request: DecisionRequest): Promise<string> {
    // Preferred path: an in-app presenter (the Ink shell) renders the choices
    // as a menu below the prompt — obvious, consistent, no screen clear, no
    // terminal handoff. Falls through to the raw-mode menu only when none is
    // registered (headless / non-Ink).
    if (decisionPresenter) {
      const choice = await decisionPresenter(request);
      const custom = choice.customInput?.trim();
      const fingerprint = this.decisionFingerprint(request);
      if (custom) {
        const customOptionId = `custom-${Date.now()}`;
        this.recordDecision({ requestId: request.id, selectedOptionId: customOptionId, userInput: custom, timestamp: new Date() });
        this.answeredFingerprints.set(fingerprint, { selectedOptionId: customOptionId, userInput: custom });
        return customOptionId;
      }
      const optionId = choice.optionId || request.defaultOptionId || request.options[0]?.id || '__custom__';
      this.recordDecision({ requestId: request.id, selectedOptionId: optionId, timestamp: new Date() });
      // Remember the human's genuine pick so an identical re-ask doesn't
      // interrupt them again (#17).
      this.answeredFingerprints.set(fingerprint, { selectedOptionId: optionId });
      return optionId;
    }

    // Ensure signal handlers are installed for Ctrl+C fallback
    installSignalHandlers();

    // Check if shutdown is already in progress
    if (isShutdownInProgress()) {
      const defaultOption = request.defaultOptionId || request.options[0]?.id;
      if (defaultOption) return defaultOption;
      throw new Error('Shutdown in progress');
    }

    // Build menu items: all options + "Enter your own" at the end
    const menuItems: Array<{ id: string; label: string; description: string; isCustom?: boolean }> = [
      ...request.options.map(opt => ({ id: opt.id, label: opt.label, description: opt.description })),
      { id: '__custom__', label: 'Enter your own', description: 'Type a custom plan, instruction, or alternative approach', isCustom: true }
    ];

    // Start selection on "Enter your own" (last item)
    let selectedIndex = menuItems.length - 1;

    return new Promise((resolve, _reject) => {
      // Snapshot the terminal state *before* we touch it so we can restore
      // exactly what the parent renderer had set up — UnifiedUIRenderer keeps
      // raw mode ON and stdin flowing; clearing those breaks the next prompt.
      const priorRawMode = stdin.isTTY ? Boolean((stdin as NodeJS.ReadStream).isRaw) : false;
      const priorPaused = stdin.isPaused();
      let cleanedUp = false;
      const promptId = request.id;

      activePromptCount += 1;
      hitlEvents.emit('prompt-open', { id: promptId });

      // Single funnel for every exit path so listeners and event counts stay
      // consistent regardless of how the prompt resolves.
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (timeoutId) clearTimeout(timeoutId);
        unregisterCleanup();
        try { stdin.removeListener('data', handleKeypress); } catch { /* ignore */ }
        if (stdin.isTTY) {
          try { stdin.setRawMode(priorRawMode); } catch { /* ignore */ }
        }
        if (priorPaused) {
          try { stdin.pause(); } catch { /* ignore */ }
        }
        this.cleanupReadline();
        activePromptCount = Math.max(0, activePromptCount - 1);
        hitlEvents.emit('prompt-close', { id: promptId });
      };

      // Register cleanup callback for graceful shutdown
      const unregisterCleanup = onShutdown(() => { cleanup(); });

      const timeoutId = this.config.timeoutMs > 0
        ? setTimeout(() => {
            // Only honor the timeout if a default option was provided; without
            // one, the prompt is required to wait indefinitely.
            if (!this.config.timeoutDefaultOptionId) return;
            console.log(chalk.yellow(`\n⏰ Timeout - auto-selecting default option`));
            cleanup();
            resolve(this.config.timeoutDefaultOptionId);
          }, this.config.timeoutMs)
        : undefined;

      // Render the menu
      const renderMenu = () => {
        // Clear screen and move cursor to top
        stdout.write('\x1b[2J\x1b[H');

        const ember = chalk.hex('#ff9f43');
        console.log(ember('╭───────────────────────────────────────────────────────────╮'));
        console.log(ember('│                  Human decision required                  │'));
        console.log(ember('╰───────────────────────────────────────────────────────────╯\n'));

        console.log(chalk.bold.white(request.title));
        console.log(chalk.dim(request.description));
        console.log('');

        if (request.context) {
          console.log(chalk.bold.white('Context:'));
          console.log(chalk.dim(request.context));
          console.log('');
        }

        console.log(chalk.dim('Use ↑↓ to select, Enter to confirm:\n'));

        menuItems.forEach((item, index) => {
          const isSelected = index === selectedIndex;
          const marker = isSelected ? chalk.bold.cyan('▸ ') : '  ';
          const labelStyle = isSelected ? chalk.bold.cyan : chalk.white;
          const descStyle = isSelected ? chalk.cyan : chalk.dim;

          console.log(`${marker}${labelStyle(item.label)}`);
          console.log(`  ${descStyle(item.description)}`);
          console.log('');
        });

        console.log(chalk.dim('Press Ctrl+C to cancel'));
      };

      // Handle custom input after selection. We tear down the raw-mode menu
      // listener first, then hand stdin to a one-shot readline. The shared
      // `cleanup()` is deferred until *after* the user submits, so the
      // prompt-open/close pairing stays balanced.
      const handleCustomInput = () => {
        try { stdin.removeListener('data', handleKeypress); } catch { /* ignore */ }
        if (stdin.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } }
        console.log(chalk.cyan('\nEnter your custom plan or instruction:'));

        const customRl = readline.createInterface({
          input: stdin,
          output: stdout,
          terminal: stdin.isTTY
        });

        customRl.question(chalk.bold.magenta('Your input: '), (customInput: string) => {
          customRl.close();
          cleanup();

          if (customInput.trim()) {
            console.log(chalk.green(`\nUsing custom input: "${customInput.trim()}"`));
            const customOptionId = `custom-${Date.now()}`;
            const response: DecisionResponse = {
              requestId: request.id,
              selectedOptionId: customOptionId,
              userInput: customInput.trim(),
              timestamp: new Date()
            };
            this.recordDecision(response);
            resolve(customOptionId);
          } else {
            console.log(chalk.yellow('Empty input, using first option'));
            resolve(request.options[0]?.id || '__custom__');
          }
        });
      };

      // Take stdin into raw mode for arrow-key navigation. `cleanup()` will
      // restore whatever state the parent renderer had.
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();

      const handleKeypress = (chunk: Buffer) => {
        const key = chunk.toString();

        // Ctrl+C
        if (key === '\x03') {
          cleanup();
          console.log(chalk.red('\nOperation cancelled'));
          void authorizedShutdown(130);
          return;
        }

        // Enter key
        if (key === '\r' || key === '\n') {
          const selectedItem = menuItems[selectedIndex];
          if (selectedItem?.isCustom) {
            // handleCustomInput defers cleanup() until after readline returns.
            handleCustomInput();
          } else if (selectedItem) {
            cleanup();
            console.log(chalk.green(`\nSelected: ${selectedItem.label}`));
            resolve(selectedItem.id);
          }
          return;
        }

        // Arrow keys (escape sequences)
        if (key === '\x1b[A' || key === 'k') {
          // Up arrow or k
          selectedIndex = Math.max(0, selectedIndex - 1);
          renderMenu();
        } else if (key === '\x1b[B' || key === 'j') {
          // Down arrow or j
          selectedIndex = Math.min(menuItems.length - 1, selectedIndex + 1);
          renderMenu();
        }
      };

      stdin.on('data', handleKeypress);

      // Initial render
      renderMenu();
    });
  }

  private cleanupReadline(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
  }

  private getOptionLabel(request: DecisionRequest, optionId: string): string {
    const option = request.options.find(opt => opt.id === optionId);
    return option ? option.label : optionId;
  }

  private logDecisionRequest(request: DecisionRequest): void {
    if (this.config.logLevel === 'minimal') {
      console.log(chalk.yellow(`Decision required: ${request.title}`));
      return;
    }
    
    console.log(chalk.yellow(`\nDecision Point: ${request.title}`));
    console.log(chalk.dim(`   ${request.description}`));
    console.log(chalk.dim(`   Options: ${request.options.map(o => o.label).join(', ')}`));
  }

  private recordDecision(response: DecisionResponse): void {
    this.decisionHistory.push(response);
    if (this.decisionHistory.length > MAX_DECISION_HISTORY) {
      this.decisionHistory.shift();
    }
    this.pendingDecisions.delete(response.requestId);
    
    // Log the decision
    if (this.config.logLevel === 'detailed') {
      const request = this.pendingDecisions.get(response.requestId);
      const optionLabel = request ? this.getOptionLabel(request, response.selectedOptionId) : response.selectedOptionId;
      
      console.log(chalk.green(`Decision recorded: ${optionLabel}`));
      if (response.userInput) {
        console.log(chalk.dim(`   Custom input: ${response.userInput}`));
      }
    }
  }

  /**
   * Get decision history
   */
  getHistory(): DecisionResponse[] {
    return [...this.decisionHistory];
  }

  /**
   * The custom text the user typed for a given decision result, if they chose
   * the "Enter your own" write-in. requestDecision returns only the option id;
   * for a write-in that id is a synthetic `custom-…` with no matching option,
   * so the actual instruction lived only in history — invisible to the model.
   * The tool handler uses this to surface the write-in text.
   */
  /** Stable identity for a decision: same title/description/options → same key,
   *  so only a genuinely identical re-ask is treated as a repeat. */
  private decisionFingerprint(request: DecisionRequest): string {
    return JSON.stringify({
      t: request.title,
      d: request.description,
      o: request.options.map((o) => `${o.id}:${o.label}`),
    });
  }

  getDecisionInput(selectedOptionId: string): string | undefined {
    for (let i = this.decisionHistory.length - 1; i >= 0; i--) {
      if (this.decisionHistory[i]!.selectedOptionId === selectedOptionId) {
        return this.decisionHistory[i]!.userInput;
      }
    }
    return undefined;
  }

  /**
   * Clear decision history
   */
  clearHistory(): void {
    this.decisionHistory = [];
    this.answeredFingerprints.clear();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HITLConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Singleton instance
let hitlInstance: HITLSystem | null = null;

/**
 * Get the global HITL instance
 */
export function getHITL(config?: Partial<HITLConfig>): HITLSystem {
  if (!hitlInstance) {
    hitlInstance = new HITLSystem(config);
  }
  
  if (config) {
    hitlInstance.updateConfig(config);
  }
  
  return hitlInstance;
}

/**
 * Helper function for common decision patterns
 */
export const hitl = {
  /**
   * Request a yes/no decision
   */
  async askYesNo(title: string, description: string, context: string = '', defaultYes: boolean = true): Promise<boolean> {
    const hitl = getHITL();
    
    const decision = await hitl.requestDecision({
      id: `yesno-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      title,
      description,
      context,
      options: [
        {
          id: 'yes',
          label: 'Yes',
          description: 'Proceed with the suggested plan',
          shortcut: 'y'
        },
        {
          id: 'no',
          label: 'No',
          description: 'Do not proceed',
          shortcut: 'n'
        }
      ],
      defaultOptionId: defaultYes ? 'yes' : 'no',
      requiresExplicitChoice: true
    });
    
    return decision === 'yes';
  },

  /**
   * Request selection from multiple options
   */
  async selectOption(title: string, description: string, options: Array<{id: string, label: string, description: string}>, context: string = '', defaultOptionId?: string): Promise<string> {
    const hitl = getHITL();
    
    const decision = await hitl.requestDecision({
      id: `select-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      title,
      description,
      context,
      options: options.map((opt, index) => ({
        ...opt,
        shortcut: String(index + 1)
      })),
      defaultOptionId,
      requiresExplicitChoice: true
    });
    
    return decision;
  },

  /**
   * Request approval for a risky operation
   */
  async requestApproval(title: string, riskDescription: string, operationDetails: string): Promise<boolean> {
    return hitl.askYesNo(
      `APPROVAL REQUIRED: ${title}`,
      riskDescription,
      operationDetails,
      false // Default to "no" for safety
    );
  }
};