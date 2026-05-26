import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SystemInfo {
  os: 'macos' | 'linux' | 'windows'
  arch: string
  nodeVersion: string
  packageManager: 'pnpm' | 'yarn' | 'npm'
  /** Resolved version of `packageManager` (e.g. "10.6.3"); '' if undetectable. */
  packageManagerVersion: string
  ides: ('jetbrains' | 'vscode' | 'cursor')[]
  aiTools: ('claude' | 'cursor')[]
  gitHosting: 'github' | 'gitlab' | null
  /** direnv on PATH — lets us drop a .envrc so local bins (just, tsc) work bare. */
  hasDirenv: boolean
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

/** Capture trimmed stdout of a command, or '' if it fails. */
function cmdOut(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function detectSystem(projectRoot: string): SystemInfo {
  const ides: ('jetbrains' | 'vscode' | 'cursor')[] = [];
  const aiTools: ('claude' | 'cursor')[] = [];

  // IDE detection
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

  // AI tools
  if (which('claude')) aiTools.push('claude');
  if (which('cursor')) aiTools.push('cursor');

  // Git hosting
  let gitHosting: 'github' | 'gitlab' | null = null;
  const gitConfigPath = join(projectRoot, '.git', 'config');
  if (existsSync(gitConfigPath)) {
    try {
      const config = readFileSync(gitConfigPath, 'utf-8');
      if (config.includes('github.com')) gitHosting = 'github';
      else if (config.includes('gitlab.com')) gitHosting = 'gitlab';
    } catch {
      /* optional - unreadable git config means unknown hosting */
    }
  }

  // Package manager
  let packageManager: 'pnpm' | 'yarn' | 'npm' = 'npm';
  if (which('pnpm')) packageManager = 'pnpm';
  else if (which('yarn')) packageManager = 'yarn';

  return {
    os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch,
    nodeVersion: process.version,
    packageManager,
    packageManagerVersion: cmdOut(`${packageManager} --version`),
    ides,
    aiTools,
    gitHosting,
    hasDirenv: which('direnv'),
  };
}
