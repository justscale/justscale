import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Attempt to run `code --install-extension <path>` and return whether it worked. */
function installVSCodeExtension(extensionPath: string): boolean {
  try {
    const bin = process.platform === 'win32' ? 'code.cmd' : 'code';
    execSync(`${bin} --install-extension "${extensionPath}" --force`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Find the justscale VS Code extension bundled with @justscale/vscode. */
function findVSCodeExtension(projectRoot: string): string | undefined {
  const candidates = [
    join(projectRoot, 'node_modules/@justscale/vscode'),
    join(projectRoot, '../node_modules/@justscale/vscode'),
  ];
  return candidates.find(p => existsSync(join(p, 'package.json')));
}

export function generateJetBrainsConfig(projectRoot: string): string[] {
  const ideaDir = join(projectRoot, '.idea');
  mkdirSync(ideaDir, { recursive: true });

  const generated: string[] = [];

  // TypeScript config — point to JustScale compiler
  const tsConfigPath = join(ideaDir, 'typescript.xml');
  if (!existsSync(tsConfigPath)) {
    writeFileSync(tsConfigPath, `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="TypeScriptCompilerConfiguration">
    <option name="useService" value="true" />
    <option name="typeScriptServiceDirectory" value="$PROJECT_DIR$/node_modules/@justscale/typescript" />
    <option name="versionType" value="SERVICE_DIRECTORY" />
  </component>
</project>
`);
    generated.push('.idea/typescript.xml');
  }

  // LSP configuration for proto files (JetBrains 2023.2+ with LSP support plugin)
  const lspConfigPath = join(ideaDir, 'justscale-lsp.xml');
  if (!existsSync(lspConfigPath)) {
    writeFileSync(lspConfigPath, `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <!--
    JustScale Proto LSP (requires JetBrains 2023.2+ with Language Server Protocol plugin)
    Plugin: https://plugins.jetbrains.com/plugin/10209-language-server-protocol-client

    The justscale-lsp binary is installed with @justscale/typescript.
    Configure via: Settings → Languages & Frameworks → Language Server Protocol
      Command: node_modules/.bin/justscale-lsp
      File patterns: *.proto
  -->
  <component name="JustScaleLSP">
    <option name="serverBin" value="$PROJECT_DIR$/node_modules/.bin/justscale-lsp" />
    <option name="filePatterns" value="*.proto" />
  </component>
</project>
`);
    generated.push('.idea/justscale-lsp.xml');
  }

  // Run configurations
  const runConfigDir = join(ideaDir, 'runConfigurations');
  mkdirSync(runConfigDir, { recursive: true });

  const runConfigs: Record<string, string> = {
    'just_dev.xml': runConfig('just dev', 'dev'),
    'just_build.xml': runConfig('just build', 'build'),
    'just_test.xml': runConfig('just test', 'test'),
  };

  for (const [filename, content] of Object.entries(runConfigs)) {
    const path = join(runConfigDir, filename);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      generated.push(`.idea/runConfigurations/${filename}`);
    }
  }

  return generated;
}

function runConfig(name: string, command: string): string {
  return `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${name}" type="js.build_tools.npm">
    <package-json value="$PROJECT_DIR$/package.json" />
    <command value="run" />
    <scripts>
      <script value="${command}" />
    </scripts>
    <node-interpreter value="project" />
    <envs />
    <method v="2" />
  </configuration>
</component>
`;
}

export function generateVSCodeConfig(projectRoot: string): string[] {
  const vscodeDir = join(projectRoot, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });

  const generated: string[] = [];

  const settingsPath = join(vscodeDir, 'settings.json');
  const tsdk = './node_modules/@justscale/typescript/lib';

  const defaultSettings: Record<string, unknown> = {
    'typescript.tsdk': tsdk,
    'typescript.enablePromptUseWorkspaceTsdk': true,
    // Associate .proto files with the proto3 language so the LSP activates
    'files.associations': { '*.proto': 'proto3' },
  };

  if (existsSync(settingsPath)) {
    try {
      const existing: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      let updated = false;
      for (const [key, value] of Object.entries(defaultSettings)) {
        if (existing[key] === undefined) {
          existing[key] = value;
          updated = true;
        }
      }
      if (updated) {
        writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
        generated.push('.vscode/settings.json (updated)');
      }
    } catch {
      // malformed json — leave it alone
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2) + '\n');
    generated.push('.vscode/settings.json');
  }

  const launchPath = join(vscodeDir, 'launch.json');
  if (!existsSync(launchPath)) {
    writeFileSync(launchPath, JSON.stringify({
      version: '0.2.0',
      configurations: [
        {
          type: 'node',
          request: 'launch',
          name: 'just dev',
          runtimeExecutable: 'npx',
          runtimeArgs: ['just', 'dev'],
          cwd: '${workspaceFolder}',
          console: 'integratedTerminal',
        },
      ],
    }, null, 2) + '\n');
    generated.push('.vscode/launch.json');
  }

  const extensionsPath = join(vscodeDir, 'extensions.json');
  const recommendations = ['dbaeumer.vscode-eslint', 'justscale.justscale-vscode'];
  if (existsSync(extensionsPath)) {
    try {
      const existing = JSON.parse(readFileSync(extensionsPath, 'utf-8'));
      const existing_recs: string[] = existing.recommendations ?? [];
      const missing = recommendations.filter(r => !existing_recs.includes(r));
      if (missing.length > 0) {
        existing.recommendations = [...existing_recs, ...missing];
        writeFileSync(extensionsPath, JSON.stringify(existing, null, 2) + '\n');
        generated.push('.vscode/extensions.json (updated)');
      }
    } catch {
      // malformed — leave it
    }
  } else {
    writeFileSync(extensionsPath, JSON.stringify({ recommendations }, null, 2) + '\n');
    generated.push('.vscode/extensions.json');
  }

  // Install VS Code extension for proto LSP if code CLI is available
  const extPath = findVSCodeExtension(projectRoot);
  if (extPath) {
    const installed = installVSCodeExtension(extPath);
    if (installed) {
      generated.push('JustScale VS Code extension installed');
    }
  }

  return generated;
}
