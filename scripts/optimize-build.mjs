#!/usr/bin/env node

/**
 * Build optimization script for Anvilwing Coder
 * 
 * This script optimizes the production build by:
 * 1. Minifying JavaScript files
 * 2. Removing debug code and console logs in production
 * 3. Optimizing file structure
 * 4. Generating source maps
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const DIST_DIR = resolve(ROOT_DIR, 'dist');

// Configuration
const PRODUCTION = process.env.NODE_ENV === 'production';
const MINIFY = process.env.MINIFY !== 'false';
const REMOVE_DEBUG = process.env.REMOVE_DEBUG !== 'false';
const GENERATE_SOURCEMAP = process.env.SOURCEMAP !== 'false';

console.log('🔧 Anvilwing Coder Build Optimization');
console.log(`Mode: ${PRODUCTION ? 'Production' : 'Development'}`);
console.log(`Minify: ${MINIFY ? 'Yes' : 'No'}`);
console.log(`Remove debug: ${REMOVE_DEBUG ? 'Yes' : 'No'}`);
console.log(`Source maps: ${GENERATE_SOURCEMAP ? 'Yes' : 'No'}`);
console.log('---');

function walkDir(dir, callback) {
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      walkDir(filePath, callback);
    } else {
      callback(filePath);
    }
  }
}

function minifyJavaScript(source) {
  // Basic minification (can be enhanced with uglify-js or terser)
  let minified = source;
  
  // Remove block comments (but preserve license headers)
  minified = minified.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Keep license headers
    if (match.includes('@license') || match.includes('MIT') || match.includes('Apache')) {
      return match;
    }
    return '';
  });
  
  // Remove line comments (except shebang)
  minified = minified.replace(/^\s*\/\/.*$/gm, '');
  
  // Remove extra whitespace
  minified = minified.replace(/\s+/g, ' ');
  minified = minified.replace(/\s*([{}()\[\];,=:])\s*/g, '$1');
  
  return minified.trim();
}

function removeDebugCode(source) {
  if (!REMOVE_DEBUG) return source;
  
  let cleaned = source;
  
  // Remove console.debug, console.log, console.info (keep console.error, console.warn)
  cleaned = cleaned.replace(/console\.(debug|log|info)\(.*?\);?/g, '');

  // Remove debug-only function calls
  cleaned = cleaned.replace(/debugLog\(.*?\);?/g, '');
  
  return cleaned;
}

function optimizeFile(filePath) {
  if (!filePath.endsWith('.js')) return;
  
  const relativePath = relative(DIST_DIR, filePath);
  console.log(`🔨 Optimizing: ${relativePath}`);
  
  try {
    let content = readFileSync(filePath, 'utf8');
    const originalSize = content.length;
    
    // Remove debug code in production
    if (PRODUCTION) {
      content = removeDebugCode(content);
    }
    
    // Minify if enabled
    if (MINIFY && PRODUCTION) {
      content = minifyJavaScript(content);
    }
    
    // Write optimized file
    writeFileSync(filePath, content, 'utf8');
    
    const optimizedSize = content.length;
    const reduction = ((originalSize - optimizedSize) / originalSize * 100).toFixed(1);
    
    if (optimizedSize < originalSize) {
      console.log(`  📉 Size reduction: ${reduction}% (${originalSize} → ${optimizedSize} bytes)`);
    }
  } catch (error) {
    console.error(`  ❌ Error optimizing ${relativePath}:`, error.message);
  }
}

function generateBundleAnalysis() {
  console.log('\n📊 Generating bundle analysis...');
  
  try {
    // Create bundle size report
    const bundleSizes = [];
    let totalSize = 0;
    
    walkDir(DIST_DIR, (filePath) => {
      if (filePath.endsWith('.js')) {
        const stat = statSync(filePath);
        const size = stat.size;
        const relativePath = relative(DIST_DIR, filePath);
        totalSize += size;
        bundleSizes.push({ path: relativePath, size });
      }
    });
    
    // Sort by size
    bundleSizes.sort((a, b) => b.size - a.size);
    
    // Write analysis report
    const analysisPath = join(DIST_DIR, 'bundle-analysis.json');
    const report = {
      generated: new Date().toISOString(),
      totalSize,
      totalFiles: bundleSizes.length,
      files: bundleSizes.map(f => ({
        path: f.path,
        size: f.size,
        sizeKB: (f.size / 1024).toFixed(2),
        sizeMB: (f.size / (1024 * 1024)).toFixed(3)
      })),
      topLargest: bundleSizes.slice(0, 10)
    };
    
    writeFileSync(analysisPath, JSON.stringify(report, null, 2));
    console.log(`  ✅ Bundle analysis saved to: ${relative(ROOT_DIR, analysisPath)}`);
    console.log(`  📦 Total bundle size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
    
    // Display top 5 largest files
    console.log('\n🏆 Top 5 largest files:');
    report.topLargest.slice(0, 5).forEach((file, i) => {
      console.log(`  ${i + 1}. ${file.path} - ${file.sizeKB} KB`);
    });
    
  } catch (error) {
    console.error('  ❌ Error generating bundle analysis:', error.message);
  }
}

function cleanupBuildArtifacts() {
  console.log('\n🧹 Cleaning up build artifacts...');
  
  const artifactsToRemove = [
    '**/*.tsbuildinfo',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/package-lock.json',
    '**/yarn.lock'
  ];
  
  artifactsToRemove.forEach(pattern => {
    try {
      execSync(`find ${DIST_DIR} -name "${pattern}" -delete`, { stdio: 'inherit' });
    } catch (error) {
      // Ignore errors for missing files
    }
  });
  
  console.log('  ✅ Build artifacts cleaned');
}

async function main() {
  console.log('🚀 Starting build optimization...\n');
  
  // 1. Optimize all JavaScript files
  console.log('📦 Optimizing JavaScript files...');
  walkDir(DIST_DIR, optimizeFile);
  
  // 2. Generate bundle analysis
  generateBundleAnalysis();
  
  // 3. Clean up build artifacts
  cleanupBuildArtifacts();
  
  console.log('\n✅ Build optimization complete!');
  console.log('📁 Optimized build available in:', relative(ROOT_DIR, DIST_DIR));
  
  if (PRODUCTION) {
    console.log('\n🚀 Production build ready for deployment!');
    console.log('👉 Run tests: npm test');
    console.log('👉 Create release: npm run release');
  }
}

// Run optimization
main().catch(error => {
  console.error('❌ Build optimization failed:', error);
  process.exit(1);
});