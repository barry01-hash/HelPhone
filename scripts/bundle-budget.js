#!/usr/bin/env node
/**
 * Bundle Budget CI Gate
 *
 * Fails the build if the initial JavaScript bundle exceeds the configured
 * size budget. Run after `vite build` to enforce bundle size limits.
 *
 * Usage: node scripts/bundle-budget.js [budgetKB]
 * Default budget: 250KB compressed
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const BUDGET_KB = parseInt(process.argv[2] || '250', 10);
const DIST_DIR = join(process.cwd(), 'dist');

function getJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getJsFiles(fullPath));
    } else if (entry.endsWith('.js')) {
      files.push({ path: fullPath, size: stat.size });
    }
  }
  return files;
}

function formatKB(bytes) {
  return (bytes / 1024).toFixed(2);
}

try {
  const jsFiles = getJsFiles(DIST_DIR);

  // Find the main entry chunk (index-*.js or similar)
  const indexChunk = jsFiles.find(f =>
    f.path.includes('index') || f.path.includes('app')
  );

  if (!indexChunk) {
    console.warn('⚠️  No index chunk found, skipping budget check');
    process.exit(0);
  }

  const sizeKB = indexChunk.size / 1024;

  console.log(`\n📦 Bundle Budget Check`);
  console.log(`   File: ${indexChunk.path.replace(DIST_DIR, 'dist')}`);
  console.log(`   Size: ${formatKB(indexChunk.size)}KB`);
  console.log(`   Budget: ${BUDGET_KB}KB`);

  if (sizeKB > BUDGET_KB) {
    console.error(`\n❌ Bundle exceeds budget: ${formatKB(indexChunk.size)}KB > ${BUDGET_KB}KB`);
    console.error(`\n   To fix:`);
    console.error(`   1. Use dynamic imports for heavy dependencies`);
    console.error(`   2. Check manualChunks configuration in vite.config.ts`);
    console.error(`   3. Run \`npx vite-bundle-visualizer\` to identify large chunks\n`);
    process.exit(1);
  }

  console.log(`\n✅ Bundle within budget (${formatKB(indexChunk.size)}KB <= ${BUDGET_KB}KB)\n`);
  process.exit(0);
} catch (err) {
  console.error('❌ Bundle budget check failed:', err.message);
  process.exit(1);
}
