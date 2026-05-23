#!/usr/bin/env node
/**
 * @justscale/core/process - Compiler CLI
 *
 * Command-line interface for compiling process files.
 *
 * Usage:
 *   npx @justscale/core/process compile <input> [options]
 *   npx @justscale/core/process compile src/processes/*.ts -o dist/
 */

import { parseArgs } from 'node:util';
import { resolve, dirname, basename, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { compileProcessSource, formatDiagnostics } from './compile.js';

interface CLIOptions {
  output?: string
  watch?: boolean
  verbose?: boolean
  sourceMap?: boolean
  help?: boolean
}

const HELP = `
@justscale/core/process compiler

Usage:
  process-compile <files...> [options]

Arguments:
  files           Input file(s) or glob pattern(s)

Options:
  -o, --output    Output directory (default: same as input)
  -w, --watch     Watch for changes
  -v, --verbose   Verbose output
  --sourcemap     Generate source maps
  -h, --help      Show this help

Examples:
  process-compile src/order.process.ts
  process-compile "src/**/*.process.ts" -o dist/
  process-compile src/processes/ -o dist/processes/ --verbose
`;

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      output: { type: 'string', short: 'o' },
      watch: { type: 'boolean', short: 'w' },
      verbose: { type: 'boolean', short: 'v' },
      sourcemap: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const options: CLIOptions = {
    output: values.output,
    watch: values.watch,
    verbose: values.verbose,
    sourceMap: values.sourcemap,
  };

  // Collect input files
  const inputFiles: string[] = [];
  for (const pattern of positionals) {
    const resolved = resolve(pattern);

    if (existsSync(resolved)) {
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        // Recursively find .ts files in directory
        const files = findTsFiles(resolved);
        inputFiles.push(...files);
      } else {
        inputFiles.push(resolved);
      }
    } else if (pattern.includes('*')) {
      // Glob pattern - use simple matching
      const files = expandGlob(pattern);
      inputFiles.push(...files);
    } else {
      console.error(`Error: File not found: ${pattern}`);
      return 1;
    }
  }

  if (inputFiles.length === 0) {
    console.error('Error: No input files found');
    return 1;
  }

  if (options.verbose) {
    console.log(`Compiling ${inputFiles.length} file(s)...`);
  }

  let hasErrors = false;

  for (const inputFile of inputFiles) {
    const outputFile = getOutputPath(inputFile, options.output);

    if (options.verbose) {
      console.log(`  ${inputFile} -> ${outputFile}`);
    }

    try {
      const source = readFileSync(inputFile, 'utf-8');
      const result = compileProcessSource(source, inputFile, {
        sourceMap: options.sourceMap,
        verbose: options.verbose,
      });

      // Check for errors
      const errors = result.diagnostics.filter(d => d.category === 1); // Error
      if (errors.length > 0) {
        console.error(formatDiagnostics(errors));
        hasErrors = true;
        continue;
      }

      // Ensure output directory exists
      const outDir = dirname(outputFile);
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      // Write output
      writeFileSync(outputFile, result.outputText);

      if (result.declarationText) {
        writeFileSync(outputFile.replace(/\.js$/, '.d.ts'), result.declarationText);
      }

      if (result.sourceMapText) {
        writeFileSync(outputFile + '.map', result.sourceMapText);
      }

      if (options.verbose) {
        console.log('    ✓ Compiled successfully');
      }
    } catch (error) {
      console.error(`Error compiling ${inputFile}:`, error);
      hasErrors = true;
    }
  }

  if (!hasErrors) {
    console.log(`✓ Compiled ${inputFiles.length} file(s)`);
  }

  return hasErrors ? 1 : 0;
}

/**
 * Find all TypeScript files in a directory recursively.
 */
function findTsFiles(dir: string): string[] {
  const files: string[] = [];

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Expand a simple glob pattern.
 */
function expandGlob(pattern: string): string[] {
  // Simple glob expansion - supports ** and *
  const parts = pattern.split('/');
  const baseParts: string[] = [];
  let globStart = -1;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes('*')) {
      globStart = i;
      break;
    }
    baseParts.push(parts[i]);
  }

  if (globStart === -1) {
    return [pattern];
  }

  const baseDir = baseParts.length > 0 ? resolve(baseParts.join('/')) : process.cwd();
  if (!existsSync(baseDir)) {
    return [];
  }

  const globPattern = parts.slice(globStart).join('/');
  const files = findTsFiles(baseDir);

  // Filter by pattern
  return files.filter(file => {
    const relativePath = file.slice(baseDir.length + 1);
    return matchGlob(relativePath, globPattern);
  });
}

/**
 * Simple glob matching.
 */
function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*')
    .replace(/\./g, '\\.');

  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Get the output path for an input file.
 */
function getOutputPath(inputFile: string, outputDir?: string): string {
  const baseName = basename(inputFile, '.ts') + '.js';

  if (outputDir) {
    return join(resolve(outputDir), baseName);
  }

  return join(dirname(inputFile), baseName);
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code));
}
