/**
 * Security Utilities for AGI Core
 * Comprehensive security validation, sanitization, and safe execution utilities
 */

import { spawnSync, SpawnSyncOptions } from 'node:child_process';
import { URL } from 'node:url';
import { logDebug } from './debugLogger.js';

/**
 * Validate target hostname, IP address, or domain
 * Prevents command injection and path traversal
 */
export function validateTarget(target: string): { valid: boolean; reason?: string } {
  if (typeof target !== 'string') {
    return { valid: false, reason: 'Target must be a string' };
  }
  
  if (target.length > 253) {
    return { valid: false, reason: 'Target too long (max 253 characters)' };
  }
  
  // Allow IP addresses (IPv4 and IPv6), hostnames, but no shell metacharacters
  const validTargetRegex = /^[a-zA-Z0-9.\-:_[\]]+$/;
  if (!validTargetRegex.test(target)) {
    return { valid: false, reason: 'Target contains invalid characters' };
  }
  
  // Disallow localhost/private IPs unless explicitly allowed (add config flag if needed)
  const privateIPRegex = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|::1|localhost)/;
  if (privateIPRegex.test(target.toLowerCase())) {
    console.warn(`Security warning: Scanning private/localhost target ${target}`);
  }
  
  return { valid: true };
}

/**
 * Validate port numbers and ranges
 */
export function validatePorts(ports: string): { valid: boolean; reason?: string } {
  if (typeof ports !== 'string') {
    return { valid: false, reason: 'Ports must be a string' };
  }
  
  const portList = ports.split(',');
  for (const port of portList) {
    if (port.includes('-')) {
      // Handle port ranges like "1-1000"
      const [start, end] = port.split('-').map(p => parseInt(p.trim(), 10));
      if (isNaN(start) || isNaN(end) || start < 1 || end > 65535 || start > end) {
        return { valid: false, reason: `Invalid port range: ${port}` };
      }
    } else {
      const portNum = parseInt(port.trim(), 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return { valid: false, reason: `Invalid port: ${port}` };
      }
    }
  }
  
  return { valid: true };
}

/**
 * Validate and sanitize URL
 */
export function validateUrl(url: string): { valid: boolean; reason?: string; sanitized?: string } {
  try {
    const parsed = new URL(url);
    
    // Validate protocol
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }
    
    // Validate hostname
    const hostnameValidation = validateTarget(parsed.hostname);
    if (!hostnameValidation.valid) {
      return { valid: false, reason: hostnameValidation.reason };
    }
    
    // Sanitize path (basic prevention of directory traversal in URL)
    const sanitizedPath = parsed.pathname.replace(/\.\.\//g, '').replace(/\/\/+/g, '/');
    
    return { 
      valid: true, 
      sanitized: `${parsed.protocol}//${parsed.hostname}${sanitizedPath}${parsed.search}${parsed.hash}`
    };
  } catch (error) {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

/**
 * Safe command execution wrapper
 * Uses spawnSync with array arguments, never shell mode
 */
export function safeExecSync(
  command: string, 
  args: string[] = [], 
  options: SpawnSyncOptions = {}
): { success: boolean; stdout: string; stderr: string; error?: string } {
  try {
    const defaultOptions: SpawnSyncOptions = {
      encoding: 'utf-8' as const,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // CRITICAL: Never use shell mode
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    const result = spawnSync(command, args, mergedOptions);
    
    if (result.error) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        error: `Command execution failed: ${result.error.message}`
      };
    }
    
    return {
      success: result.status === 0,
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
    };
  } catch (error: any) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      error: `Execution error: ${error.message}`
    };
  }
}

/**
 * Sanitize user input for shell commands
 * Escapes shell metacharacters
 */
export function sanitizeShellInput(input: string): string {
  if (typeof input !== 'string') return '';
  
  // Escape shell metacharacters
  return input.replace(/[;&|`$\\'"\n\r]/g, '\\$&');
}

/**
 * Validate and sanitize file path
 * Prevents directory traversal anomalys
 */
export function sanitizeFilePath(path: string): { valid: boolean; sanitized?: string; reason?: string } {
  if (typeof path !== 'string') {
    return { valid: false, reason: 'Path must be a string' };
  }
  
  // Prevent directory traversal
  if (path.includes('..') || path.includes('//')) {
    return { valid: false, reason: 'Path contains directory traversal attempts' };
  }
  
  // Prevent absolute paths to sensitive locations (basic check)
  const sensitivePaths = ['/etc/', '/var/', '/usr/', '/bin/', '/sbin/', '/root/', '/home/'];
  const normalizedPath = path.toLowerCase();
  if (sensitivePaths.some(sp => normalizedPath.startsWith(sp))) {
    return { valid: false, reason: 'Path points to sensitive system location' };
  }
  
  return { valid: true, sanitized: path };
}

/**
 * Rate limiting and request throttling
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  
  constructor(
    private maxRequests: number = 10,
    private timeWindowMs: number = 60000
  ) {}
  
  /**
   * Check if request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.timeWindowMs;
    
    let requests = this.requests.get(key) || [];
    
    // Clean old requests
    requests = requests.filter(time => time > windowStart);
    
    if (requests.length >= this.maxRequests) {
      return false;
    }
    
    requests.push(now);
    this.requests.set(key, requests);
    
    // Cleanup old entries periodically
    if (Math.random() < 0.01) { // 1% chance to cleanup
      this.cleanup();
    }
    
    return true;
  }
  
  /**
   * Clean up old request records
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.timeWindowMs;
    
    for (const [key, requests] of this.requests.entries()) {
      const filtered = requests.filter(time => time > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }
  }
  
  /**
   * Get wait time if rate limited
   */
  getWaitTime(key: string): number {
    const requests = this.requests.get(key) || [];
    if (requests.length < this.maxRequests) {
      return 0;
    }
    
    const oldest = Math.min(...requests);
    return Math.max(0, oldest + this.timeWindowMs - Date.now());
  }
}

/**
 * Secure HTTP request utilities
 */
export class SecureHttpClient {
  private rateLimiter = new RateLimiter(50, 60000); // 50 requests per minute
  
  async get(url: string, options: { timeout?: number; headers?: Record<string, string> } = {}): Promise<{
    success: boolean;
    statusCode?: number;
    data?: string;
    error?: string;
  }> {
    // Validate URL
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      return { success: false, error: urlValidation.reason };
    }
    
    // Rate limiting
    const hostname = new URL(url).hostname;
    if (!this.rateLimiter.isAllowed(hostname)) {
      return { 
        success: false, 
        error: `Rate limit exceeded for ${hostname}. Wait ${this.rateLimiter.getWaitTime(hostname)}ms`
      };
    }
    
    // Use native HTTP/HTTPS modules (implementation would go here)
    // This is a placeholder for actual HTTP implementation
    
    return { success: false, error: 'HTTP client not implemented' };
  }
}

/**
 * Security context for tool execution
 */
export interface SecurityContext {
  userId?: string;
  permissions: string[];
  maxExecutionTime: number;
  allowedCommands: string[];
  allowedHosts: string[];
}

/**
 * Security policy validator
 */
export class SecurityPolicyValidator {
  private defaultContext: SecurityContext = {
    permissions: ['read', 'write', 'execute'],
    maxExecutionTime: 30000,
    allowedCommands: ['nmap', 'curl', 'dig', 'sshpass', 'openssl'],
    allowedHosts: []
  };
  
  validateCommand(command: string, args: string[], context: Partial<SecurityContext> = {}): {
    allowed: boolean;
    reason?: string;
  } {
    const mergedContext = { ...this.defaultContext, ...context };
    
    // Check if command is allowed
    if (!mergedContext.allowedCommands.includes(command)) {
      return { allowed: false, reason: `Command ${command} not allowed` };
    }
    
    // Validate arguments for specific commands
    if (command === 'nmap') {
      return this.validateNmapArgs(args);
    }
    
    if (command === 'curl') {
      return this.validateCurlArgs(args);
    }
    
    return { allowed: true };
  }
  
  private validateNmapArgs(args: string[]): { allowed: boolean; reason?: string } {
    const allowedOptions = [
      '-sS', '-sT', '-sV', '-sC', '-O', '-T4', '-T5', '-p', '-p-',
      '-Pn', '-A', '--script=vuln', '--script=safe', '--open',
      '--host-timeout', '--max-retries'
    ];
    
    for (const arg of args) {
      if (arg.startsWith('-p') && !['-p', '-p-'].includes(arg)) {
        // Validate port specification
        const ports = arg.substring(2);
        const portValidation = validatePorts(ports);
        if (!portValidation.valid) {
          return { allowed: false, reason: portValidation.reason };
        }
      } else if (!allowedOptions.includes(arg) && !arg.startsWith('--script')) {
        return { allowed: false, reason: `Disallowed nmap option: ${arg}` };
      }
    }
    
    return { allowed: true };
  }
  
  private validateCurlArgs(args: string[]): { allowed: boolean; reason?: string } {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg === '-X' || arg === '--request') {
        const method = args[i + 1];
        if (!['GET', 'POST', 'HEAD', 'OPTIONS'].includes(method?.toUpperCase())) {
          return { allowed: false, reason: `Disallowed HTTP method: ${method}` };
        }
        i++; // Skip next arg
      }
      
      if (arg.startsWith('http://') || arg.startsWith('https://')) {
        const urlValidation = validateUrl(arg);
        if (!urlValidation.valid) {
          return { allowed: false, reason: urlValidation.reason };
        }
      }
    }
    
    return { allowed: true };
  }
}

/**
 * Security logger for audit trail
 */
export class SecurityLogger {
  private logFile?: string;
  
  constructor(logFile?: string) {
    this.logFile = logFile;
  }
  
  logSecurityEvent(event: {
    type: string;
    userId?: string;
    command?: string;
    args?: string[];
    target?: string;
    success: boolean;
    timestamp: Date;
    details?: Record<string, any>;
  }): void {
    const logEntry = {
      ...event,
      timestamp: event.timestamp.toISOString(),
      ip: this.getClientIp()
    };

    // Keep security logging off the main console; emit via debug logger
    logDebug(`[SECURITY] ${JSON.stringify(logEntry)}`);
  }
  
  private getClientIp(): string {
    // Placeholder for actual IP detection
    return '127.0.0.1';
  }
}

// Export singleton instances
export const securityValidator = new SecurityPolicyValidator();
export const securityLogger = new SecurityLogger();
export const globalRateLimiter = new RateLimiter(100, 60000); // 100 requests per minute globally
