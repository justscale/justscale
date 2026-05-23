/**
 * Configuration support for JustScale TypeScript compiler
 *
 * JustScale extends tsconfig.json with a custom "justscale" section,
 * similar to how TypeScriptToLua uses a "tstl" section.
 *
 * Example tsconfig.json:
 * ```json
 * {
 *   "compilerOptions": {
 *     "target": "ESNext",
 *     "module": "NodeNext"
 *   },
 *   "justscale": {
 *     "processFilePattern": "*.process.ts",
 *     "strict": true,
 *     "plugins": ["./my-plugin.js"]
 *   }
 * }
 * ```
 */

import ts from 'typescript';
import { dirname } from 'node:path';

/**
 * JustScale-specific configuration options
 */
export interface JustScaleConfig {
  /**
   * Glob pattern for process files (default: "*.process.ts")
   */
  processFilePattern?: string

  /**
   * Enable strict mode for process compilation (default: true)
   * When enabled, additional checks are performed:
   * - All suspension points must be awaited
   * - Variables captured across suspension points are validated
   */
  strict?: boolean

  /**
   * Custom plugins to load during compilation
   * Plugins can modify the AST or add custom diagnostics
   */
  plugins?: Array<string | PluginConfig>

  /**
   * Enable verbose diagnostic output
   */
  verbose?: boolean

  /**
   * Generate source maps for compiled processes
   */
  sourceMap?: boolean

  /**
   * Path mapping for process imports
   */
  paths?: Record<string, string[]>

  /**
   * Modules to treat as process-aware (imports suspension primitives)
   */
  processModules?: string[]
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  /**
   * Path or package name of the plugin
   */
  name: string

  /**
   * Plugin-specific options
   */
  options?: Record<string, unknown>
}

/**
 * Parsed configuration result
 */
export interface ParsedConfig {
  /**
   * TypeScript compiler options
   */
  compilerOptions: ts.CompilerOptions

  /**
   * Files to compile
   */
  fileNames: string[]

  /**
   * JustScale-specific options
   */
  justscale: JustScaleConfig

  /**
   * Project references
   */
  projectReferences?: readonly ts.ProjectReference[]

  /**
   * Configuration file path
   */
  configFilePath: string

  /**
   * Diagnostics from parsing
   */
  errors: ts.Diagnostic[]
}

/**
 * Default JustScale configuration
 */
export const defaultConfig: Required<JustScaleConfig> = {
  processFilePattern: '*.process.ts',
  strict: true,
  plugins: [],
  verbose: false,
  sourceMap: true,
  paths: {},
  processModules: ['@justscale/core/process'],
};

/**
 * Parse a tsconfig.json file and extract JustScale configuration
 */
export function parseConfig(
  configPath: string,
  existingOptions?: ts.CompilerOptions
): ParsedConfig {
  const errors: ts.Diagnostic[] = [];

  // Read and parse the config file
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    errors.push(configFile.error);
    return {
      compilerOptions: existingOptions ?? {},
      fileNames: [],
      justscale: { ...defaultConfig },
      configFilePath: configPath,
      errors,
    };
  }

  const configDir = dirname(configPath);

  // Parse TypeScript config
  const parsedTsConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configDir,
    existingOptions
  );

  errors.push(...parsedTsConfig.errors);

  // Extract JustScale config
  const rawJustscaleConfig = configFile.config.justscale || {};
  const justscaleConfig = parseJustScaleConfig(rawJustscaleConfig, configDir, errors);

  return {
    compilerOptions: parsedTsConfig.options,
    fileNames: parsedTsConfig.fileNames,
    justscale: justscaleConfig,
    projectReferences: parsedTsConfig.projectReferences,
    configFilePath: configPath,
    errors,
  };
}

/**
 * Parse and validate JustScale configuration
 */
function parseJustScaleConfig(
  raw: Record<string, unknown>,
  configDir: string,
  errors: ts.Diagnostic[]
): JustScaleConfig {
  const config: JustScaleConfig = { ...defaultConfig };

  // Process file pattern
  if (typeof raw.processFilePattern === 'string') {
    config.processFilePattern = raw.processFilePattern;
  } else if (raw.processFilePattern !== undefined) {
    errors.push(createConfigError('processFilePattern must be a string'));
  }

  // Strict mode
  if (typeof raw.strict === 'boolean') {
    config.strict = raw.strict;
  } else if (raw.strict !== undefined) {
    errors.push(createConfigError('strict must be a boolean'));
  }

  // Verbose
  if (typeof raw.verbose === 'boolean') {
    config.verbose = raw.verbose;
  } else if (raw.verbose !== undefined) {
    errors.push(createConfigError('verbose must be a boolean'));
  }

  // Source map
  if (typeof raw.sourceMap === 'boolean') {
    config.sourceMap = raw.sourceMap;
  } else if (raw.sourceMap !== undefined) {
    errors.push(createConfigError('sourceMap must be a boolean'));
  }

  // Plugins
  if (Array.isArray(raw.plugins)) {
    config.plugins = raw.plugins.map((plugin) => {
      if (typeof plugin === 'string') {
        return plugin;
      }
      if (typeof plugin === 'object' && plugin !== null) {
        const pluginConfig = plugin as Record<string, unknown>;
        if (typeof pluginConfig.name !== 'string') {
          errors.push(createConfigError('plugin.name must be a string'));
          return '';
        }
        return {
          name: pluginConfig.name,
          options: pluginConfig.options as Record<string, unknown>,
        };
      }
      errors.push(createConfigError('plugin must be a string or object'));
      return '';
    }).filter(Boolean);
  } else if (raw.plugins !== undefined) {
    errors.push(createConfigError('plugins must be an array'));
  }

  // Process modules
  if (Array.isArray(raw.processModules)) {
    const validModules = raw.processModules.filter((m) => typeof m === 'string') as string[];
    if (validModules.length !== raw.processModules.length) {
      errors.push(createConfigError('processModules must be an array of strings'));
    }
    config.processModules = [...defaultConfig.processModules, ...validModules];
  } else if (raw.processModules !== undefined) {
    errors.push(createConfigError('processModules must be an array'));
  }

  // Paths
  if (typeof raw.paths === 'object' && raw.paths !== null) {
    config.paths = raw.paths as Record<string, string[]>;
  } else if (raw.paths !== undefined) {
    errors.push(createConfigError('paths must be an object'));
  }

  return config;
}

/**
 * Create a configuration error diagnostic
 */
function createConfigError(message: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 100001,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText: `JustScale config error: ${message}`,
  };
}

/**
 * Find and parse tsconfig.json from a directory
 */
export function findConfig(searchPath: string): ParsedConfig | undefined {
  const configPath = ts.findConfigFile(searchPath, ts.sys.fileExists, 'tsconfig.json');

  if (!configPath) {
    return undefined;
  }

  return parseConfig(configPath);
}

/**
 * Check if a file matches the process file pattern
 */
export function isProcessFile(
  fileName: string,
  config: JustScaleConfig = defaultConfig
): boolean {
  // Check file pattern
  const pattern = config.processFilePattern ?? defaultConfig.processFilePattern;
  if (pattern) {
    const regex = globToRegex(pattern);
    if (regex.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Convert a simple glob pattern to a regex
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(escaped);
}

/**
 * Merge two configurations, with the second taking precedence
 */
export function mergeConfig(
  base: JustScaleConfig,
  override: Partial<JustScaleConfig>
): JustScaleConfig {
  return {
    ...base,
    ...override,
    plugins: [...(base.plugins ?? []), ...(override.plugins ?? [])],
    processModules: [
      ...new Set([
        ...(base.processModules ?? defaultConfig.processModules),
        ...(override.processModules ?? []),
      ]),
    ],
    paths: {
      ...(base.paths ?? {}),
      ...(override.paths ?? {}),
    },
  };
}
