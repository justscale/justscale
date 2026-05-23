import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function generateClaudeConfig(projectRoot: string): string[] {
  const claudeDir = join(projectRoot, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const generated: string[] = [];

  // MCP settings
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        justscale: {
          command: './node_modules/.bin/just',
          args: ['mcp', 'serve'],
        },
      },
    }, null, 2) + '\n');
    generated.push('.claude/settings.json');
  }

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# CLAUDE.md

## Commands

\`\`\`bash
just build              # Build all packages
just test               # Run all tests
just dev                # Development mode with hot reload
just init               # Re-run project setup
just install <package>  # Install a JustScale plugin
\`\`\`

## Architecture

This project uses JustScale — a TypeScript framework with:
- Custom TypeScript compiler (\`ptsc\`) for durable process compilation
- Dependency injection with compile-time validation
- CLI commands discoverable from installed packages
- Mode-based entry points defined in \`justscale.config.ts\`

## Conventions

- ESM everywhere (\`"type": "module"\`)
- 2-space indent, single quotes, semicolons
- Tests: \`node:test\` runner via \`tsx --test\`
`);
    generated.push('CLAUDE.md');
  }

  return generated;
}

export function generateCursorConfig(projectRoot: string): string[] {
  const cursorDir = join(projectRoot, '.cursor');
  mkdirSync(cursorDir, { recursive: true });

  const generated: string[] = [];

  const mcpPath = join(cursorDir, 'mcp.json');
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {},
    }, null, 2) + '\n');
    generated.push('.cursor/mcp.json');
  }

  return generated;
}
