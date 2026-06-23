/**
 * AI Error Fixer - Minimal stub for backward compatibility
 */

export enum ErrorType {
  BUILD_ERROR = 'build_error',
  TEST_FAILURE = 'test_failure',
  TYPE_ERROR = 'type_error',
  LINT_ERROR = 'lint_error',
  IMPORT_ERROR = 'import_error',
  SYNTAX_ERROR = 'syntax_error',
  FILE_NOT_FOUND = 'file_not_found',
  PERMISSION_ERROR = 'permission_error',
  EDIT_CONFLICT = 'edit_conflict',
  NEWLINE_IN_STRING = 'newline_in_string',
  UNKNOWN = 'unknown',
}

export interface ErrorLocation {
  filePath: string;
  lineNumber?: number;
  column?: number;
}

export interface ErrorFix {
  description: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  confidence: number;
  autoApplicable: boolean;
  requiresConfirmation: boolean;
}

export interface ParsedError {
  errorType: ErrorType;
  message: string;
  rawOutput: string;
  locations: ErrorLocation[];
  suggestedFixes: ErrorFix[];
  relatedErrors: string[];
  metadata: Record<string, unknown>;
}

const TS_ERROR_PATTERN = /([^\s:]+\.tsx?):(\d+):(\d+)\s*-\s*error\s+TS(\d+):\s*(.+)/gm;
const NPM_DEP_PATTERN = /(?:Cannot find|Module not found).*['"]([^'"]+)['"]/gm;
const TEST_FAIL_PATTERN = /FAIL\s+([^\n]+)/gm;

export class AIErrorFixer {
  private readonly workingDir: string;

  constructor(options: { workingDir?: string } = {}) {
    this.workingDir = options.workingDir ?? process.cwd();
  }

  analyzeOutput(output: string, command?: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const outputType = this.detectOutputType(output, command);

    if (outputType === 'typescript') errors.push(...this.parseTypeScriptErrors(output));
    else if (outputType === 'npm') errors.push(...this.parseNpmErrors(output));
    else if (outputType === 'test') errors.push(...this.parseTestErrors(output));
    else errors.push(...this.parseGenericErrors(output));

    for (const error of errors) {
      error.suggestedFixes = this.generateFixes(error);
    }
    return errors;
  }

  formatForAI(errors: ParsedError[]): string {
    if (errors.length === 0) return '';
    const lines: string[] = ['', '═══ AI ERROR ANALYSIS ═══', ''];
    for (let i = 0; i < Math.min(errors.length, 5); i++) {
      const error = errors[i];
      if (!error) continue;
      lines.push(`• ${error.errorType.toUpperCase()}: ${error.message.slice(0, 150)}`);
      const loc = error.locations[0];
      if (loc) lines.push(`  at ${loc.filePath}:${loc.lineNumber ?? '?'}`);
      const bestFix = error.suggestedFixes[0];
      if (bestFix) lines.push(`  FIX: ${bestFix.description}`);
      lines.push('');
    }
    if (errors.length > 5) lines.push(`... and ${errors.length - 5} more errors`);
    return lines.join('\n');
  }

  private detectOutputType(output: string, command?: string): string {
    const outputLower = output.toLowerCase();
    const commandLower = (command ?? '').toLowerCase();
    if (commandLower.includes('tsc') || commandLower.includes('typescript')) return 'typescript';
    if (commandLower.includes('test') || commandLower.includes('jest')) return 'test';
    if (commandLower.includes('npm') || commandLower.includes('yarn')) return 'npm';
    if (outputLower.includes('error ts') || output.includes('.ts:')) return 'typescript';
    if (outputLower.includes('npm err!')) return 'npm';
    return 'generic';
  }

  private parseTypeScriptErrors(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const regex = new RegExp(TS_ERROR_PATTERN.source, 'gm');
    let match;
    while ((match = regex.exec(output)) !== null) {
      const [, file, line, col, code, msg] = match;
      if (!file || !code || !msg) continue;
      errors.push({
        errorType: ErrorType.TYPE_ERROR,
        message: `TS${code}: ${msg}`,
        rawOutput: match[0],
        locations: [{ filePath: file, lineNumber: line ? parseInt(line, 10) : undefined, column: col ? parseInt(col, 10) : undefined }],
        suggestedFixes: [],
        relatedErrors: [],
        metadata: { tsCode: code },
      });
    }
    return errors;
  }

  private parseNpmErrors(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const regex = new RegExp(NPM_DEP_PATTERN.source, 'gm');
    let match;
    while ((match = regex.exec(output)) !== null) {
      const [, dep] = match;
      if (!dep) continue;
      errors.push({
        errorType: ErrorType.IMPORT_ERROR,
        message: `Missing dependency: ${dep}`,
        rawOutput: match[0],
        locations: [],
        suggestedFixes: [],
        relatedErrors: [],
        metadata: { missingDep: dep },
      });
    }
    return errors;
  }

  private parseTestErrors(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const regex = new RegExp(TEST_FAIL_PATTERN.source, 'gm');
    let match;
    while ((match = regex.exec(output)) !== null) {
      const [, file] = match;
      if (!file) continue;
      errors.push({
        errorType: ErrorType.TEST_FAILURE,
        message: `Test failed: ${file}`,
        rawOutput: match[0],
        locations: [{ filePath: file.trim() }],
        suggestedFixes: [],
        relatedErrors: [],
        metadata: {},
      });
    }
    return errors;
  }

  private parseGenericErrors(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const errorLines: string[] = [];
    for (const line of output.split('\n')) {
      const lineLower = line.toLowerCase();
      if (lineLower.includes('error:') || lineLower.includes('failed:') || lineLower.includes('exception:') || lineLower.includes('fatal:')) {
        errorLines.push(line.trim());
      }
    }
    if (errorLines.length > 0 && errorLines[0]) {
      errors.push({
        errorType: ErrorType.UNKNOWN,
        message: errorLines[0].slice(0, 200),
        rawOutput: errorLines.slice(0, 5).join('\n'),
        locations: [],
        suggestedFixes: [],
        relatedErrors: errorLines.slice(1, 5),
        metadata: {},
      });
    }
    return errors;
  }

  private generateFixes(error: ParsedError): ErrorFix[] {
    const fixes: ErrorFix[] = [];
    const loc = error.locations[0];
    if (error.errorType === ErrorType.TYPE_ERROR && loc) {
      const tsCode = String(error.metadata['tsCode'] ?? '');
      if (tsCode === '2304') {
        const nameMatch = error.message.match(/Cannot find name '([^']+)'/);
        if (nameMatch?.[1]) {
          fixes.push({
            description: `Add import for '${nameMatch[1]}'`,
            filePath: loc.filePath,
            oldContent: '',
            newContent: `import { ${nameMatch[1]} } from './${nameMatch[1]}';`,
            confidence: 0.6,
            autoApplicable: false,
            requiresConfirmation: true,
          });
        }
      }
      if (tsCode === '6133') {
        const varMatch = error.message.match(/'([^']+)' is declared but/);
        if (varMatch?.[1]) {
          fixes.push({
            description: `Prefix '${varMatch[1]}' with underscore`,
            filePath: loc.filePath,
            oldContent: varMatch[1],
            newContent: `_${varMatch[1]}`,
            confidence: 0.8,
            autoApplicable: true,
            requiresConfirmation: false,
          });
        }
      }
    }
    if (error.errorType === ErrorType.IMPORT_ERROR) {
      const missingDep = String(error.metadata['missingDep'] ?? '');
      if (missingDep) {
        fixes.push({
          description: `Install: npm install ${missingDep}`,
          filePath: 'package.json',
          oldContent: '',
          newContent: '',
          confidence: 0.9,
          autoApplicable: false,
          requiresConfirmation: true,
        });
      }
    }
    return fixes;
  }
}

export function createErrorFixer(options?: { workingDir?: string }): AIErrorFixer {
  return new AIErrorFixer({ workingDir: options?.workingDir });
}
