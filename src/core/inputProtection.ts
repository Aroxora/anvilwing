/**
 * Input Protection System - Guards against remote anomalys on chat input
 *
 * Protects against:
 * 1. Remote stdin injection anomalys
 * 2. Automated paste anomalys (superhuman typing speed)
 * 3. Escape sequence injection via clipboard
 * 4. Buffer overflow attempts (massive pastes)
 * 5. Control character injection
 * 6. Unicode-based anomalys (homoglyphs, RTL override)
 * 7. Timing-based anomalys (burst injection)
 *
 * @module inputProtection
 */

import { EventEmitter } from 'events';
import { reportStatus } from '../utils/statusReporter.js';

/** Input validation result */
export interface InputValidation {
  allowed: boolean;
  sanitized: string;
  blocked: boolean;
  reason?: string;
  anomalyType?: InputAnomalyType;
  riskScore: number; // 0-100
}

/** Types of input anomalys */
export type InputAnomalyType =
  | 'automated_injection'   // Input faster than human typing
  | 'escape_injection'      // Terminal escape sequences
  | 'control_injection'     // Control characters (Ctrl+C, etc.)
  | 'overflow_attempt'      // Extremely large input
  | 'unicode_anomaly'        // RTL override, homoglyphs
  | 'timing_burst'          // Rapid burst of inputs
  | 'remote_paste'          // Detected remote paste anomaly
  | 'stdin_hijack';         // Stdin manipulation

/** Input protection configuration */
export interface InputProtectionConfig {
  /** Maximum characters per second (human ~12 CPS, paste unlimited) */
  maxCharactersPerSecond?: number;
  /** Maximum paste size in characters */
  maxPasteSize?: number;
  /** Maximum total buffer size */
  maxBufferSize?: number;
  /** Enable timing-based anomaly detection */
  detectTimingAnomalys?: boolean;
  /** Minimum interval between keystrokes in ms (human ~50ms+) */
  minKeystrokeInterval?: number;
  /** Maximum burst size before suspicion */
  maxBurstSize?: number;
  /** Enable strict mode (blocks suspicious input instead of sanitizing) */
  strictMode?: boolean;
  /** Verbose logging */
  verbose?: boolean;
  /** Callback on anomaly detection */
  onAnomalyDetected?: (type: InputAnomalyType, details: string) => void;
}

/** Input timing tracking */
interface InputTiming {
  timestamp: number;
  charCount: number;
}

/** Singleton instance */
let inputProtectionInstance: InputProtection | null = null;

/**
 * Input Protection System
 */
export class InputProtection extends EventEmitter {
  private config: Required<InputProtectionConfig>;
  private inputTimings: InputTiming[] = [];
  private lastKeystroke = 0;
  private burstCounter = 0;
  private suspicionScore = 0;
  private blockedAnomalys = 0;
  private sanitizedInputs = 0;
  private isInPasteMode = false;
  private pasteStartTime = 0;

  // Dangerous escape sequences to block
  private readonly dangerousEscapes: RegExp[] = [
    /\x1b\][0-9]+;/,           // OSC sequences (can change terminal title, etc.)
    /\x1b[PX^_]/,              // DCS, SOS, PM, APC sequences
    /\x1b\[[\d;]*[pls]/i,      // Soft reset, various terminal modes
    /\x1b\[\?[\d;]*[hl]/,      // Private mode sets (can enable dangerous modes)
    /\x1b\[[\d;]*n/,           // Device status queries (info leak)
    /\x1b\[[\d;]*q/,           // Keyboard LED control
    /\x1bP[^\\]*\x1b\\/,       // Complete DCS sequence
    /\x1b\]0;[^\x07]*\x07/,    // Title set sequence
    /\x1b\]52;/,               // Clipboard manipulation sequence
  ];

  // Dangerous control characters
  private readonly dangerousControls: number[] = [
    0x00, // NUL - can cause issues
    0x01, // SOH
    0x02, // STX
    0x03, // ETX (Ctrl+C) - allow but track
    0x04, // EOT (Ctrl+D) - allow but track
    0x05, // ENQ
    0x06, // ACK
    0x07, // BEL - annoying beep
    0x0E, // SO - shift out
    0x0F, // SI - shift in
    0x10, // DLE
    0x11, // DC1 (XON)
    0x12, // DC2
    0x13, // DC3 (XOFF)
    0x14, // DC4
    0x15, // NAK
    0x16, // SYN
    0x17, // ETB
    0x18, // CAN
    0x19, // EM
    0x1A, // SUB (Ctrl+Z)
    0x1C, // FS
    0x1D, // GS
    0x1E, // RS
    0x1F, // US
    0x7F, // DEL
  ];

  // Unicode anomaly patterns
  private readonly unicodeAnomalys: Array<{ pattern: RegExp | string; name: string }> = [
    { pattern: /\u202E/, name: 'RTL override' },      // Right-to-left override
    { pattern: /\u202D/, name: 'LTR override' },      // Left-to-right override
    { pattern: /\u202A/, name: 'LTR embedding' },     // Left-to-right embedding
    { pattern: /\u202B/, name: 'RTL embedding' },     // Right-to-left embedding
    { pattern: /\u202C/, name: 'Pop direction' },     // Pop directional formatting
    { pattern: /\u2066/, name: 'LTR isolate' },       // Left-to-right isolate
    { pattern: /\u2067/, name: 'RTL isolate' },       // Right-to-left isolate
    { pattern: /\u2068/, name: 'First strong isolate' },
    { pattern: /\u2069/, name: 'Pop isolate' },       // Pop directional isolate
    { pattern: /\u200E/, name: 'LTR mark' },          // Left-to-right mark
    { pattern: /\u200F/, name: 'RTL mark' },          // Right-to-left mark
    { pattern: /\uFEFF/, name: 'BOM' },               // Byte order mark
    { pattern: /[\u200B-\u200D]/, name: 'Zero-width chars' }, // Zero-width spaces/joiners
  ];

  constructor(config: InputProtectionConfig = {}) {
    super();
    this.config = {
      maxCharactersPerSecond: config.maxCharactersPerSecond ?? 500,  // Allow fast paste
      maxPasteSize: config.maxPasteSize ?? 100000,                   // 100KB max paste
      maxBufferSize: config.maxBufferSize ?? 500000,                 // 500KB max buffer
      detectTimingAnomalys: config.detectTimingAnomalys ?? true,
      minKeystrokeInterval: config.minKeystrokeInterval ?? 5,        // 5ms minimum (200 CPS)
      maxBurstSize: config.maxBurstSize ?? 1000,                     // Chars before suspicion
      strictMode: config.strictMode ?? false,
      verbose: config.verbose ?? false,
      onAnomalyDetected: config.onAnomalyDetected ?? (() => {}),
    };
  }

  /**
   * Validate and sanitize input before it enters the chat buffer
   */
  validateInput(input: string, isPaste = false): InputValidation {
    const now = Date.now();
    let sanitized = input;
    let blocked = false;
    let reason: string | undefined;
    let anomalyType: InputAnomalyType | undefined;
    let riskScore = 0;

    // Track timing
    this.inputTimings.push({ timestamp: now, charCount: input.length });
    this.cleanOldTimings();

    // === Size validation ===
    if (isPaste && input.length > this.config.maxPasteSize) {
      riskScore += 30;
      if (this.config.strictMode) {
        blocked = true;
        reason = `Paste size ${input.length} exceeds limit ${this.config.maxPasteSize}`;
        anomalyType = 'overflow_attempt';
      } else {
        sanitized = input.slice(0, this.config.maxPasteSize);
        reason = `Truncated paste from ${input.length} to ${this.config.maxPasteSize}`;
      }
      this.sanitizedInputs++;
    }

    // === Timing analysis ===
    if (this.config.detectTimingAnomalys && !isPaste) {
      const interval = now - this.lastKeystroke;
      if (interval > 0 && interval < this.config.minKeystrokeInterval) {
        // Suspiciously fast keystrokes
        this.suspicionScore += 5;
        riskScore += 10;

        if (this.suspicionScore > 50) {
          anomalyType = 'automated_injection';
          reason = `Automated input detected (${Math.round(1000 / interval)} CPS)`;
          this.log(`Suspicion score: ${this.suspicionScore}, interval: ${interval}ms`);
        }
      } else {
        // Normal typing - decrease suspicion
        this.suspicionScore = Math.max(0, this.suspicionScore - 1);
      }
    }
    this.lastKeystroke = now;

    // === Burst detection ===
    const recentChars = this.getRecentCharCount(100); // Last 100ms
    if (recentChars > this.config.maxBurstSize) {
      this.burstCounter++;
      riskScore += 20;

      if (this.burstCounter > 3) {
        anomalyType = 'timing_burst';
        reason = `Burst injection detected (${recentChars} chars in 100ms)`;
        if (this.config.strictMode) {
          blocked = true;
        }
      }
    } else {
      this.burstCounter = Math.max(0, this.burstCounter - 1);
    }

    // === Escape sequence validation ===
    const escapeResult = this.checkEscapeSequences(sanitized);
    if (escapeResult.found) {
      riskScore += 40;
      anomalyType = 'escape_injection';
      reason = `Dangerous escape sequence: ${escapeResult.type}`;
      sanitized = escapeResult.sanitized;
      this.sanitizedInputs++;

      if (this.config.strictMode) {
        blocked = true;
      }
    }

    // === Control character validation ===
    const controlResult = this.checkControlCharacters(sanitized);
    if (controlResult.found) {
      riskScore += 15;
      if (!anomalyType) {
        anomalyType = 'control_injection';
        reason = `Control characters detected: ${controlResult.chars.join(', ')}`;
      }
      sanitized = controlResult.sanitized;
      this.sanitizedInputs++;
    }

    // === Unicode anomaly detection ===
    const unicodeResult = this.checkUnicodeAnomalys(sanitized);
    if (unicodeResult.found) {
      riskScore += 30;
      if (!anomalyType) {
        anomalyType = 'unicode_anomaly';
        reason = `Unicode anomaly: ${unicodeResult.type}`;
      }
      sanitized = unicodeResult.sanitized;
      this.sanitizedInputs++;
    }

    // === Rate limiting check ===
    const cps = this.calculateCPS();
    if (cps > this.config.maxCharactersPerSecond && !isPaste) {
      riskScore += 25;
      if (!anomalyType) {
        anomalyType = 'automated_injection';
        reason = `Rate limit exceeded: ${Math.round(cps)} CPS`;
      }

      if (this.config.strictMode && cps > this.config.maxCharactersPerSecond * 2) {
        blocked = true;
      }
    }

    // Log anomaly detection
    if (anomalyType && riskScore > 30) {
      this.blockedAnomalys++;
      this.config.onAnomalyDetected?.(anomalyType, reason || 'Unknown');
      this.emit('anomaly_detected', { type: anomalyType, reason, riskScore });
      this.log(`Anomaly detected: ${anomalyType} - ${reason} (risk: ${riskScore})`);
    }

    return {
      allowed: !blocked,
      sanitized: blocked ? '' : sanitized,
      blocked,
      reason,
      anomalyType,
      riskScore,
    };
  }

  /**
   * Enter paste mode (more lenient validation)
   */
  enterPasteMode(): void {
    this.isInPasteMode = true;
    this.pasteStartTime = Date.now();
    this.log('Entered paste mode');
  }

  /**
   * Exit paste mode
   */
  exitPasteMode(): void {
    const duration = Date.now() - this.pasteStartTime;
    this.isInPasteMode = false;
    this.log(`Exited paste mode (duration: ${duration}ms)`);
  }

  /**
   * Check if currently in paste mode
   */
  isPasting(): boolean {
    return this.isInPasteMode;
  }

  /**
   * Validate a complete prompt before submission
   */
  validatePromptSubmission(prompt: string): InputValidation {
    // Final validation before sending to AI
    let sanitized = prompt;
    let riskScore = 0;
    let anomalyType: InputAnomalyType | undefined;
    let reason: string | undefined;

    // Check total size
    if (prompt.length > this.config.maxBufferSize) {
      riskScore += 50;
      anomalyType = 'overflow_attempt';
      reason = `Prompt exceeds buffer limit`;
      sanitized = prompt.slice(0, this.config.maxBufferSize);
    }

    // Final escape sequence check
    const escapeResult = this.checkEscapeSequences(sanitized);
    if (escapeResult.found) {
      riskScore += 30;
      sanitized = escapeResult.sanitized;
    }

    // Final unicode check
    const unicodeResult = this.checkUnicodeAnomalys(sanitized);
    if (unicodeResult.found) {
      riskScore += 20;
      sanitized = unicodeResult.sanitized;
    }

    return {
      allowed: true,
      sanitized,
      blocked: false,
      reason,
      anomalyType,
      riskScore,
    };
  }

  /**
   * Reset protection state (e.g., after idle period)
   */
  reset(): void {
    this.inputTimings = [];
    this.lastKeystroke = 0;
    this.burstCounter = 0;
    this.suspicionScore = 0;
    this.isInPasteMode = false;
  }

  /**
   * Get protection statistics
   */
  getStats(): {
    blockedAnomalys: number;
    sanitizedInputs: number;
    currentSuspicion: number;
    currentCPS: number;
  } {
    return {
      blockedAnomalys: this.blockedAnomalys,
      sanitizedInputs: this.sanitizedInputs,
      currentSuspicion: this.suspicionScore,
      currentCPS: this.calculateCPS(),
    };
  }

  // === Private helper methods ===

  private checkEscapeSequences(input: string): { found: boolean; type?: string; sanitized: string } {
    let sanitized = input;
    let found = false;
    let type: string | undefined;

    for (const pattern of this.dangerousEscapes) {
      if (pattern.test(sanitized)) {
        found = true;
        type = pattern.source;
        sanitized = sanitized.replace(new RegExp(pattern.source, 'g'), '');
      }
    }

    return { found, type, sanitized };
  }

  private checkControlCharacters(input: string): { found: boolean; chars: string[]; sanitized: string } {
    const foundChars: string[] = [];
    let sanitized = '';

    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);

      // Allow normal control characters: Tab (9), Newline (10), Carriage Return (13), Escape (27 - for legit sequences)
      if (code === 9 || code === 10 || code === 13) {
        sanitized += input[i];
        continue;
      }

      // Block dangerous control characters
      if (this.dangerousControls.includes(code)) {
        foundChars.push(`0x${code.toString(16).padStart(2, '0')}`);
        continue;
      }

      sanitized += input[i];
    }

    return {
      found: foundChars.length > 0,
      chars: foundChars,
      sanitized,
    };
  }

  private checkUnicodeAnomalys(input: string): { found: boolean; type?: string; sanitized: string } {
    let sanitized = input;
    let found = false;
    let type: string | undefined;

    for (const anomaly of this.unicodeAnomalys) {
      const pattern = typeof anomaly.pattern === 'string'
        ? new RegExp(anomaly.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
        : new RegExp(anomaly.pattern.source, anomaly.pattern.flags.includes("g") ? anomaly.pattern.flags : anomaly.pattern.flags + "g");

      if (pattern.test(sanitized)) {
        found = true;
        type = anomaly.name;
        sanitized = sanitized.replace(pattern, '');
      }
    }

    return { found, type, sanitized };
  }

  private cleanOldTimings(): void {
    const cutoff = Date.now() - 1000; // Keep last 1 second
    this.inputTimings = this.inputTimings.filter(t => t.timestamp > cutoff);
  }

  private getRecentCharCount(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.inputTimings
      .filter(t => t.timestamp > cutoff)
      .reduce((sum, t) => sum + t.charCount, 0);
  }

  private calculateCPS(): number {
    if (this.inputTimings.length < 2) return 0;

    const now = Date.now();
    const windowMs = 1000;
    const cutoff = now - windowMs;
    const recentTimings = this.inputTimings.filter(t => t.timestamp > cutoff);

    if (recentTimings.length === 0) return 0;

    const totalChars = recentTimings.reduce((sum, t) => sum + t.charCount, 0);
    const timeSpan = now - recentTimings[0].timestamp;

    return timeSpan > 0 ? (totalChars / timeSpan) * 1000 : 0;
  }

  private log(message: string): void {
    if (this.config.verbose || process.env['ANVILWING_DEBUG']) {
      reportStatus(`[InputProtection] ${message}`);
    }
  }
}

/**
 * Initialize global input protection (singleton)
 */
export function initializeInputProtection(config?: InputProtectionConfig): InputProtection {
  if (!inputProtectionInstance) {
    inputProtectionInstance = new InputProtection(config);
  }
  return inputProtectionInstance;
}

/**
 * Get input protection instance
 */
export function getInputProtection(): InputProtection | null {
  return inputProtectionInstance;
}

/**
 * Quick validate function for input
 */
export function validateChatInput(input: string, isPaste = false): InputValidation {
  const protection = inputProtectionInstance ?? new InputProtection();
  return protection.validateInput(input, isPaste);
}

/**
 * Validate final prompt before submission
 */
export function validatePromptSubmit(prompt: string): InputValidation {
  const protection = inputProtectionInstance ?? new InputProtection();
  return protection.validatePromptSubmission(prompt);
}

// Auto-initialize if environment variable is set
if (process.env['ANVILWING_INPUT_PROTECTION'] === '1' || process.env['ANVILWING_PROTECTED_MODE'] === '1') {
  initializeInputProtection({ verbose: process.env['ANVILWING_DEBUG'] === '1' });
}
