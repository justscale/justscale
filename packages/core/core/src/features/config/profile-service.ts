/** Environment profile management service. */

import { defineService } from '../../core/index.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// ============================================================================
// ProfileService Interface
// ============================================================================

export interface ProfileService {
  /**
   * Get the active profile name.
   *
   * Priority:
   * 1. JUSTSCALE_PROFILE env var
   * 2. .justscale/.active-profile file
   * 3. Default: 'local'
   */
  active(): string

  /**
   * Switch to a different profile.
   * Writes to .justscale/.active-profile file.
   *
   * @throws Error if profile doesn't exist
   */
  use(name: string): void

  /**
   * List available profiles.
   * Returns all .json files in .justscale/profiles/
   */
  list(): string[]

  /**
   * Get profile config values.
   * Returns empty object if profile doesn't exist.
   */
  get(name: string): Record<string, unknown>

  /**
   * Create a new profile.
   *
   * @param name - Profile name
   * @param copyFrom - Optional profile to copy from
   * @throws Error if profile already exists
   */
  create(name: string, copyFrom?: string): void

  /**
   * Delete a profile.
   *
   * @throws Error if profile doesn't exist or is currently active
   */
  delete(name: string): void

  /**
   * Compare two profiles and return differences.
   *
   * @returns Array of differences with key and values from both profiles
   */
  diff(from: string, to: string): Array<{ key: string; from: unknown; to: unknown }>
}

// ============================================================================
// Implementation
// ============================================================================

class ProfileServiceImpl implements ProfileService {
  private readonly configDir = join(process.cwd(), '.justscale');
  private readonly profilesDir = join(this.configDir, 'profiles');
  private readonly activeProfilePath = join(this.configDir, '.active-profile');

  /**
   * Ensure config and profiles directories exist
   */
  private ensureDirs(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    if (!existsSync(this.profilesDir)) {
      mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  active(): string {
    if (process.env.JUSTSCALE_PROFILE) {
      return process.env.JUSTSCALE_PROFILE;
    }
    if (existsSync(this.activeProfilePath)) {
      return readFileSync(this.activeProfilePath, 'utf-8').trim();
    }
    return 'local';
  }

  use(name: string): void {
    this.ensureDirs();

    // Validate profile exists
    const profilePath = join(this.profilesDir, `${name}.json`);
    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' does not exist. Run 'config profile create ${name}' first.`);
    }

    writeFileSync(this.activeProfilePath, name);
  }

  list(): string[] {
    if (!existsSync(this.profilesDir)) {
      return [];
    }

    const files = readdirSync(this.profilesDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }

  get(name: string): Record<string, unknown> {
    const profilePath = join(this.profilesDir, `${name}.json`);
    if (!existsSync(profilePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(profilePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  create(name: string, copyFrom?: string): void {
    this.ensureDirs();

    const profilePath = join(this.profilesDir, `${name}.json`);
    if (existsSync(profilePath)) {
      throw new Error(`Profile '${name}' already exists.`);
    }

    let initial: Record<string, unknown> = {};
    if (copyFrom) {
      const sourceProfilePath = join(this.profilesDir, `${copyFrom}.json`);
      if (!existsSync(sourceProfilePath)) {
        throw new Error(`Source profile '${copyFrom}' does not exist.`);
      }
      initial = this.get(copyFrom);
    }

    writeFileSync(profilePath, JSON.stringify(initial, null, 2));
  }

  delete(name: string): void {
    const profilePath = join(this.profilesDir, `${name}.json`);
    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' does not exist.`);
    }

    if (this.active() === name) {
      throw new Error(`Cannot delete active profile '${name}'. Switch to another profile first.`);
    }

    unlinkSync(profilePath);
  }

  diff(from: string, to: string): Array<{ key: string; from: unknown; to: unknown }> {
    const fromValues = this.get(from);
    const toValues = this.get(to);
    const diffs: Array<{ key: string; from: unknown; to: unknown }> = [];

    // Get all keys from both profiles
    const allKeys = new Set([...Object.keys(fromValues), ...Object.keys(toValues)]);

    for (const key of allKeys) {
      const fromVal = fromValues[key];
      const toVal = toValues[key];

      // Compare using JSON stringification for deep equality
      if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
        diffs.push({ key, from: fromVal, to: toVal });
      }
    }

    return diffs;
  }
}

// ============================================================================
// Service Definition
// ============================================================================

/** ProfileService DI token. */
export class ProfileServiceDef extends defineService({
  inject: {},
  factory: (): ProfileService => new ProfileServiceImpl(),
}) {}
