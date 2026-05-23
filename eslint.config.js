import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Stylistic rules - semicolons required, single quotes, 2-space indent
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/indent': ['error', 2],

      // TypeScript rules (matching previous biome config)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-namespace': 'off',

      // General rules
      'no-unused-vars': 'off', // Handled by @typescript-eslint/no-unused-vars
      '@typescript-eslint/no-this-alias': 'off',
      'require-yield': 'off',
    },
  },
  {
    files: ['packages/core/typescript/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      'out/**',
      '**/.test-fixtures/**',
      '**/.justscale/**',
      // Emitted build artifacts that land next to .ts sources
      // (docs examples, per-package src/ emits). These are generated;
      // linting them is noise. `src/` and `test/` are TS-only by
      // convention — any .js/.d.ts there came from the compiler.
      '**/*.d.ts',
      '**/*.d.ts.map',
      '**/*.js.map',
      '**/src/**/*.js',
      '**/test/**/*.js',
    ],
  }
);
