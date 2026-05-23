import type { CliIO } from './io.js';

export interface WizardProject {
  root: string
  packageJson: Record<string, any>
  hasDependency: (name: string) => boolean
}

export interface WizardContext {
  io: CliIO<any>
  project: WizardProject
}
