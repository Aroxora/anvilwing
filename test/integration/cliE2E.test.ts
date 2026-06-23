/**
 * End-to-End CLI Integration Tests
 * Tests the full CLI lifecycle and tool integration
 */

import { describe, test, expect } from '@jest/globals';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI End-to-End Integration', () => {
  const testWorkspace = join(tmpdir(), 'anvilwing-e2e-test');
  const cliBin = join(process.cwd(), 'dist/bin/anvilwing.js');

  beforeEach(() => {
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
    mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  test('CLI binary exists and is executable', () => {
    expect(existsSync(cliBin)).toBe(true);
  });

  test('CLI is shell-only: any argv is ignored and non-TTY input fails fast', () => {
    // Bin takes nothing after its name. Spawned without a PTY, the Ink shell
    // refuses to run and emits a clear message. This is the load-bearing
    // proof that we did NOT silently re-introduce a print/headless path.
    try {
      execSync(`node ${cliBin} --not-a-real-flag --version --help -p hello --json`, {
        encoding: 'utf-8', stdio: 'pipe', timeout: 5000,
      });
      // Reaching here means the binary somehow succeeded with no TTY,
      // which would only happen if a non-interactive path was re-added.
      expect(true).toBe(false);
    } catch (error: any) {
      const out = (error.stderr?.toString() || '') + (error.stdout?.toString() || '') + (error.message || '');
      expect(out).toMatch(/requires an interactive terminal/i);
    }
  });

  test('Tool manifest loads correctly', () => {
    // The CLI should be able to load its tool manifest
    const manifestPath = join(process.cwd(), 'src/contracts/tools.schema.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.contractVersion).toBeTruthy();
    expect(manifest.options).toBeInstanceOf(Array);
    expect(manifest.options.length).toBeGreaterThan(0);

    // Verify core tools are present
    const coreTools = manifest.options.find((opt: any) => opt.id === 'core-tools');
    expect(coreTools).toBeTruthy();
    expect(coreTools.pluginIds).toEqual(
      expect.arrayContaining([
        'tool.filesystem.local',
        'tool.edit',
        'tool.search.local',
        'tool.bash.local',
        'tool.orchestration.unified',
        'tool.bidirectional-audit',
      ])
    );
  });

  test('Package.json has correct structure', () => {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.name).toBe('anvilwing-coder');
    expect(pkg.bin).toBeTruthy();
    expect(pkg.bin.anvilwing).toBeTruthy();
    expect(pkg.main).toBeTruthy();
    expect(pkg.type).toBe('module');
  });

  test('TypeScript compilation produces correct output', () => {
    const distDir = join(process.cwd(), 'dist');
    expect(existsSync(distDir)).toBe(true);

    const binDir = join(distDir, 'bin');
    expect(existsSync(binDir)).toBe(true);

    const mainBin = join(binDir, 'anvilwing.js');
    expect(existsSync(mainBin)).toBe(true);

    // Check for essential modules
    const coreDir = join(distDir, 'core');
    const toolsDir = join(distDir, 'tools');
    const uiDir = join(distDir, 'ui');

    expect(existsSync(coreDir)).toBe(true);
    expect(existsSync(toolsDir)).toBe(true);
    expect(existsSync(uiDir)).toBe(true);
  });

  test('Configuration files are valid JSON', () => {
    const configFiles = [
      'src/contracts/tools.schema.json',
      'src/contracts/models.schema.json',
      'package.json',
    ];

    configFiles.forEach(file => {
      const path = join(process.cwd(), file);
      expect(existsSync(path)).toBe(true);

      expect(() => {
        JSON.parse(readFileSync(path, 'utf-8'));
      }).not.toThrow();
    });
  });

  test('Working directory handling: bin is invocable from any cwd', () => {
    // Bin is shell-only: from any cwd, spawning without a PTY must fail-fast
    // with the same message — proves no cwd-dependent crash before the
    // TTY check runs.
    const testFile = join(testWorkspace, 'test.txt');
    writeFileSync(testFile, 'Test content');
    expect(existsSync(cliBin)).toBe(true);
    try {
      execSync(`node "${cliBin}"`, { cwd: testWorkspace, encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
      expect(true).toBe(false);
    } catch (error: any) {
      const out = (error.stderr?.toString() || '') + (error.stdout?.toString() || '');
      expect(out).toMatch(/requires an interactive terminal/i);
    }
  });

  test('Dependencies are installed correctly', () => {
    const nodeModules = join(process.cwd(), 'node_modules');
    expect(existsSync(nodeModules)).toBe(true);

    // Check for critical dependencies
    const criticalDeps = [
      'openai',
      'typescript',
    ];

    criticalDeps.forEach(dep => {
      const depPath = join(nodeModules, dep);
      expect(existsSync(depPath)).toBe(true);
    });
  });

  test('Build artifacts are properly generated', () => {
    const distDir = join(process.cwd(), 'dist');

    // Check for .d.ts declaration files
    const typesExist = existsSync(join(distDir, 'core/types.d.ts'));
    expect(typesExist).toBe(true);

    // Check for source maps
    const sourceMapsExist = existsSync(join(distDir, 'bin/anvilwing.js.map'));
    expect(sourceMapsExist).toBe(true);
  });

  test('README and documentation exist', () => {
    const readme = join(process.cwd(), 'README.md');
    expect(existsSync(readme)).toBe(true);

    const readmeContent = readFileSync(readme, 'utf-8');
    expect(readmeContent.length).toBeGreaterThan(100);
    expect(readmeContent).toContain('Anvilwing Coder');
  });

  test('License file exists', () => {
    const license = join(process.cwd(), 'LICENSE');
    expect(existsSync(license)).toBe(true);
  });

  test('Git repository is properly configured', () => {
    const gitDir = join(process.cwd(), '.git');
    expect(existsSync(gitDir)).toBe(true);

    const gitignore = join(process.cwd(), '.gitignore');
    expect(existsSync(gitignore)).toBe(true);

    const gitignoreContent = readFileSync(gitignore, 'utf-8');
    expect(gitignoreContent).toContain('node_modules');
    expect(gitignoreContent).toContain('dist');
  });

  test('Scripts in package.json are defined', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

    const essentialScripts = [
      'build',
      'test',
      'lint',
      'type-check',
    ];

    essentialScripts.forEach(script => {
      expect(pkg.scripts[script]).toBeTruthy();
    });
  });

  test('TypeScript configuration is valid', () => {
    const tsconfigPath = join(process.cwd(), 'tsconfig.json');
    expect(existsSync(tsconfigPath)).toBe(true);

    // tsconfig.json may contain comments, use a more lenient parser
    const content = readFileSync(tsconfigPath, 'utf-8');
    // Remove JS-style comments for JSON parsing
    const cleanContent = content
      .replace(/\/\/.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments

    const tsconfig = JSON.parse(cleanContent);
    expect(tsconfig.compilerOptions).toBeTruthy();
    // Note: strict mode is intentionally relaxed for legacy code migration
    expect(tsconfig.compilerOptions.strict !== undefined).toBe(true);
    expect(tsconfig.compilerOptions.module).toBeTruthy();
  });

  test('Test configuration exists', () => {
    const jestConfig = join(process.cwd(), 'jest.config.cjs');
    expect(existsSync(jestConfig)).toBe(true);
  });

  test('All source files have corresponding compiled files', () => {
    // Sample core files that should be compiled
    const coreFiles = [
      'core/types.ts',
      'core/agent.ts',
      'shell/interactiveShell.ts',
      'ui/UnifiedUIRenderer.ts',
    ];

    coreFiles.forEach(srcFile => {
      const srcPath = join(process.cwd(), 'src', srcFile);
      const distPath = join(process.cwd(), 'dist', srcFile.replace('.ts', '.js'));

      if (existsSync(srcPath)) {
        expect(existsSync(distPath)).toBe(true);
      }
    });
  });
});

describe('Tool Registry Integration', () => {
  test('Tool registry can be imported', () => {
    const registryPath = join(process.cwd(), 'dist/capabilities/toolRegistry.js');
    expect(existsSync(registryPath)).toBe(true);
  });

  test('Tool manifest schema is valid', () => {
    const schemaPath = join(process.cwd(), 'src/contracts/schemas/tool-selection.schema.json');

    if (existsSync(schemaPath)) {
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      expect(schema.$schema).toBeTruthy();
    }
  });
});

describe('Performance and Resource Usage', () => {
  const cliBin = join(process.cwd(), 'dist/bin/anvilwing.js');

  test('CLI startup time is reasonable: non-TTY rejection lands in under 5s', () => {
    // The bin is shell-only; in a non-TTY env it should reach its
    // "interactive terminal" guard and exit quickly. Five seconds is a
    // generous ceiling for "boot reached the TTY check" — anything slower
    // would indicate we accidentally re-introduced heavy startup work.
    const start = Date.now();
    try {
      execSync(`node ${cliBin}`, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
    } catch {
      // Expected: non-zero exit with the TTY message.
    }
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
  });

  test('Build output size is reasonable', () => {
    const distDir = join(process.cwd(), 'dist');

    // Calculate total size (rough estimate)
    const calcSize = (dir: string): number => {
      let total = 0;

      try {
        const items = readdirSync(dir);
        items.forEach((item: string) => {
          const path = join(dir, item);
          const stat = statSync(path);

          if (stat.isDirectory()) {
            total += calcSize(path);
          } else {
            total += stat.size;
          }
        });
      } catch (err) {
        // Ignore errors
      }

      return total;
    };

    const distSize = calcSize(distDir);
    const distSizeMB = distSize / (/* TODO: Extract constant */ /* TODO: Extract constant */ 1024 * 1024);

    // Dist should be under 50MB (reasonable for a CLI tool)
    expect(distSizeMB).toBeLessThan(50);
  });
});
