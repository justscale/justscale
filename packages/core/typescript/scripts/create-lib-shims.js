#!/usr/bin/env node
/**
 * Copy TypeScript lib files for IDE compatibility
 *
 * This script copies TypeScript's lib.*.d.ts files to our lib/ directory.
 * The actual typescript.js and tsserver.js come from compiling src/lib/*.ts
 *
 * After building:
 *   pnpm build
 *
 * Users can set:
 *   "typescript.tsdk": "node_modules/@justscale/typescript/lib"
 */

import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const libDir = resolve(packageRoot, 'lib')

// Create lib directory
mkdirSync(libDir, { recursive: true })

// Find TypeScript installation
function findTypeScript() {
  const possiblePaths = [
    resolve(packageRoot, 'node_modules/typescript'),
    resolve(packageRoot, '../../../node_modules/typescript'),
    resolve(packageRoot, '../../../../node_modules/typescript'),
  ]

  for (const p of possiblePaths) {
    if (existsSync(resolve(p, 'lib/typescript.js'))) {
      return p
    }
  }

  throw new Error('Could not find TypeScript installation')
}

const tsPath = findTypeScript()
const tsLibPath = resolve(tsPath, 'lib')

console.log('Copying TypeScript lib files...')
console.log(`  TypeScript found at: ${tsPath}`)
console.log(`  Output directory: ${libDir}`)

// Copy all lib.*.d.ts files from TypeScript
const libFiles = readdirSync(tsLibPath).filter(f =>
  f.startsWith('lib.') && f.endsWith('.d.ts')
)

console.log(`  Found ${libFiles.length} lib.*.d.ts files`)

for (const file of libFiles) {
  const src = resolve(tsLibPath, file)
  const dest = resolve(libDir, file)

  try {
    copyFileSync(src, dest)
  } catch (e) {
    console.warn(`  Warning: Could not copy ${file}: ${e.message}`)
  }
}

// Copy typesMap.json (used by tsserver for type acquisition)
const typesMapSrc = resolve(tsLibPath, 'typesMap.json')
if (existsSync(typesMapSrc)) {
  copyFileSync(typesMapSrc, resolve(libDir, 'typesMap.json'))
  console.log('  Copied typesMap.json')
}

// Create package.json for the lib directory
const tsPackageJson = JSON.parse(readFileSync(resolve(tsPath, 'package.json'), 'utf-8'))

const libPackageJson = {
  name: '@justscale/typescript-lib',
  version: '0.1.0',
  description: 'JustScale TypeScript lib directory for IDE integration',
  main: 'typescript.js',
  typescriptVersion: tsPackageJson.version,
}

writeFileSync(resolve(libDir, 'package.json'), JSON.stringify(libPackageJson, null, 2))

console.log('')
console.log('TypeScript lib files copied successfully!')
console.log('')
console.log('To use with VS Code, add to settings.json:')
console.log('  "typescript.tsdk": "node_modules/@justscale/typescript/lib"')
console.log('')
console.log('To use with JetBrains:')
console.log('  Settings > Languages & Frameworks > TypeScript')
console.log('  Set "TypeScript" to: node_modules/@justscale/typescript/lib')
console.log('')
