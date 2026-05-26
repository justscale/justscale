/**
 * @justscale/install - project scaffolder
 *
 * Usage: npx @justscale/install
 *        pnpm dlx @justscale/install
 */

import { createInterface } from 'node:readline';
import { execSync, execFileSync } from 'node:child_process';
import { basename, join, resolve, sep } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { detectSystem } from './detect.js';
import { scaffoldProject } from './scaffold.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function confirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

export async function main(): Promise<void> {
  console.log('\n  JustScale - Project Setup\n');

  try {
    await run();
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {

  const cwd = process.cwd();
  const system = detectSystem(cwd);

  console.log('  Detected:');
  console.log(`    OS:              ${system.os} (${system.arch})`);
  console.log(`    Node:            ${system.nodeVersion}`);
  console.log(`    Package manager: ${system.packageManager}`);
  console.log(`    IDEs:            ${system.ides.length ? system.ides.join(', ') : 'none detected'}`);
  console.log(`    AI tools:        ${system.aiTools.length ? system.aiTools.join(', ') : 'none detected'}`);
  console.log(`    Git hosting:     ${system.gitHosting ?? 'not detected'}`);
  console.log('');

  const defaultName = basename(cwd) === '.' ? 'my-app' : basename(cwd);
  const projectName = await ask('  Project name', defaultName);

  // If the project name matches the current directory name, scaffold here. Otherwise create a subdirectory.
  const scaffoldInPlace = projectName === basename(cwd);
  const projectDir = scaffoldInPlace ? cwd : resolve(cwd, projectName);

  // Refuse to scaffold outside cwd. Catches malicious or accidental project
  // names like '../etc' or absolute paths.
  if (!scaffoldInPlace && !projectDir.startsWith(cwd + sep)) {
    console.log(`\n  Project name "${projectName}" resolves outside the current directory. Refusing for safety.\n`);
    process.exit(1);
  }

  if (existsSync(join(projectDir, 'package.json'))) {
    console.log('\n  Directory already has a package.json. Use \'just init\' to set up an existing project.\n');
    process.exit(1);
  }

  // Refuse to silently overwrite a non-empty directory. Without this,
  // scaffolding into a dir that already has a .gitignore / README /
  // CLAUDE.md / .git would clobber files. The package.json check above
  // catches the common case but not these.
  if (existsSync(projectDir)) {
    const existing = readdirSync(projectDir).filter(
      // .git is fine to coexist (this is how `init in current dir`
      // workflows look); other dotfiles and source files are not.
      (n) => n !== '.git',
    );
    if (existing.length > 0) {
      const sample = existing.slice(0, 5).join(', ');
      const more = existing.length > 5 ? `, +${existing.length - 5} more` : '';
      const proceed = await ask(
        `  Directory ${projectDir} is not empty (${sample}${more}). Files may be overwritten. Continue? (y/N)`,
        'N',
      );
      if (!/^y(es)?$/i.test(proceed.trim())) {
        console.log('\n  Aborted.\n');
        process.exit(1);
      }
    }
  }

  console.log('\n  Scaffolding project...');
  const generated = scaffoldProject({
    projectDir,
    projectName,
    system,
  });

  for (const file of generated) {
    console.log(`    [x] ${file}`);
  }

  console.log('\n  Installing dependencies...');
  try {
    const pm = system.packageManager;
    execSync(`${pm} install`, { cwd: projectDir, stdio: 'inherit' });
    console.log('    [x] Dependencies installed');
  } catch {
    console.log('    [!] Failed to install dependencies. Run it manually.');
  }

  if (!existsSync(join(projectDir, '.git'))) {
    try {
      execSync('git init', { cwd: projectDir, stdio: 'ignore' });
      console.log('    [x] Git initialized');
    } catch {
      /* optional - git init is a nicety; user can run it manually */
    }
  }

  const relPath = projectDir === cwd ? '.' : projectName;
  // `just`/`tsc` are local bins (node_modules/.bin). They resolve bare inside
  // IDE terminals (which add that dir to PATH) but not in a plain shell. A
  // child process can't edit the parent shell's PATH, so we can only tell the
  // user how to get it for this session.
  const pm = system.packageManager;
  const localJust = pm === 'npm' ? 'npx just' : `${pm} just`;
  console.log('\n  Done! Next steps:\n');
  if (relPath !== '.') {
    console.log(`    cd ${relPath}`);
  }
  if (system.hasDirenv) {
    // .envrc was generated — one allow and `just`/`tsc` work bare here, always.
    console.log('    direnv allow          # enable .envrc so `just`/`tsc` work bare here');
  } else {
    // No direnv — offer the session-scoped PATH fix.
    console.log('    export PATH="$PWD/node_modules/.bin:$PATH"   # use `just` directly this session');
  }
  console.log('');
  console.log('    just dev              # start the dev server');
  console.log('    just install <pkg>    # add a plugin');
  console.log('');
  console.log(`  No PATH change needed: \`${localJust} dev\` (or \`${pm} run dev\`).`);
  console.log('  Bare `just` everywhere: `npm i -g @justscale/core`.');
  console.log('');

  if (system.ides.includes('jetbrains')) {
    const open = await confirm('  Open in WebStorm?', true);
    if (open) {
      try { execFileSync('webstorm', [projectDir], { stdio: 'ignore' }); } catch {
        /* optional - editor launch is best-effort */
      }
    }
  } else if (system.ides.includes('vscode')) {
    const open = await confirm('  Open in VS Code?', true);
    if (open) {
      try { execFileSync('code', [projectDir], { stdio: 'ignore' }); } catch {
        /* optional - editor launch is best-effort */
      }
    }
  }

  if (system.aiTools.includes('claude')) {
    const start = await confirm('  Start Claude Code in this project?', true);
    if (start) {
      try { execFileSync('claude', [projectDir], { stdio: 'ignore' }); } catch {
        /* optional - AI tool launch is best-effort */
      }
    }
  }

}
