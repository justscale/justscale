import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function detectPostgresDep(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return '@justscale/postgres' in allDeps;
  } catch {
    return false;
  }
}

export function generateGitHubActions(projectRoot: string, options?: { hasPostgres?: boolean }): string[] {
  const workflowDir = join(projectRoot, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });

  const generated: string[] = [];

  // Detect if postgres is a dependency
  const hasPostgres = options?.hasPostgres ?? detectPostgresDep(projectRoot);

  const postgresService = hasPostgres ? `
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
` : '';

  const envBlock = hasPostgres ? `
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/test` : '';

  const ciPath = join(workflowDir, 'ci.yml');
  if (!existsSync(ciPath)) {
    writeFileSync(ciPath, `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
${postgresService}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install
      - run: pnpm build
      - run: pnpm test${envBlock}
`);
    generated.push('.github/workflows/ci.yml');
  }

  return generated;
}

export function generateGitLabCI(projectRoot: string): string[] {
  const generated: string[] = [];

  const ciPath = join(projectRoot, '.gitlab-ci.yml');
  if (!existsSync(ciPath)) {
    writeFileSync(ciPath, `image: node:22

stages:
  - build
  - test

build:
  stage: build
  script:
    - corepack enable
    - pnpm install
    - pnpm build

test:
  stage: test
  services:
    - postgres:16
  variables:
    POSTGRES_PASSWORD: postgres
    POSTGRES_DB: test
    DATABASE_URL: postgres://postgres:postgres@postgres:5432/test
  script:
    - corepack enable
    - pnpm install
    - pnpm build
    - pnpm test
`);
    generated.push('.gitlab-ci.yml');
  }

  return generated;
}
