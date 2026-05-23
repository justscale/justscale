import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SystemInfo {
  os: 'macos' | 'linux' | 'windows'
  arch: string
  nodeVersion: string
  packageManager: 'pnpm' | 'yarn' | 'npm'
  ides: ('jetbrains' | 'vscode' | 'cursor')[]
  aiTools: ('claude' | 'cursor')[]
  gitHosting: 'github' | 'gitlab' | null
}

function which(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where.exe ${bin}` : `which ${bin}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectPackageManager(): 'pnpm' | 'yarn' | 'npm' {
  if (which('pnpm')) return 'pnpm';
  if (which('yarn')) return 'yarn';
  return 'npm';
}

export function detectIDEs(): ('jetbrains' | 'vscode' | 'cursor')[] {
  const ides: ('jetbrains' | 'vscode' | 'cursor')[] = [];

  // JetBrains — check for Toolbox or common install paths
  if (process.platform === 'darwin') {
    if (existsSync(join(process.env.HOME ?? '', 'Library/Application Support/JetBrains/Toolbox')) ||
        existsSync('/Applications/WebStorm.app') ||
        existsSync('/Applications/IntelliJ IDEA.app')) {
      ides.push('jetbrains');
    }
  } else if (existsSync(join(process.env.HOME ?? '', '.local/share/JetBrains/Toolbox'))) {
    ides.push('jetbrains');
  }

  if (which('code') || which('code-insiders')) ides.push('vscode');
  if (which('cursor')) ides.push('cursor');

  return ides;
}

export function detectAITools(): ('claude' | 'cursor')[] {
  const tools: ('claude' | 'cursor')[] = [];
  if (which('claude')) tools.push('claude');
  if (which('cursor')) tools.push('cursor');
  return tools;
}

export function detectGitHosting(projectRoot: string): 'github' | 'gitlab' | null {
  const gitConfigPath = join(projectRoot, '.git', 'config');
  if (!existsSync(gitConfigPath)) return null;

  try {
    const config = readFileSync(gitConfigPath, 'utf-8');
    if (config.includes('github.com')) return 'github';
    if (config.includes('gitlab.com')) return 'gitlab';
  } catch {
    /* optional — unreadable git config means unknown hosting */
  }

  return null;
}

export function detectSystem(projectRoot: string): SystemInfo {
  return {
    os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch,
    nodeVersion: process.version,
    packageManager: detectPackageManager(),
    ides: detectIDEs(),
    aiTools: detectAITools(),
    gitHosting: detectGitHosting(projectRoot),
  };
}
