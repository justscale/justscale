/**
 * Profile CLI Controller
 *
 * Provides CLI commands for managing configuration profiles:
 * - config profile list           - List available profiles
 * - config profile use <name>     - Switch active profile
 * - config profile create <name>  - Create a new profile
 * - config profile delete <name>  - Delete a profile
 * - config profile diff <from> <to> - Compare two profiles
 *
 * @example
 * ```bash
 * # List profiles
 * justscale config profile list
 *
 * # Switch profile
 * justscale config profile use staging
 *
 * # Create profile
 * justscale config profile create test --from=staging
 *
 * # Compare profiles
 * justscale config profile diff local staging
 * ```
 */

import { createController } from '../../../core/index.js';
import { Cli } from '../../../cli/index.js';
import { ProfileServiceDef } from '../profile-service.js';
import { formatValue } from './utils.js';

/**
 * Create the Profile CLI controller.
 *
 * This controller provides CLI commands for managing environment profiles.
 */
export function createProfileController() {
  return createController({
    inject: { profileService: ProfileServiceDef },
    routes: ({ profileService }) => ({
      /**
       * List available profiles.
       * Usage: config profile list
       *
       * @example
       * ```bash
       * justscale config profile list
       * ```
       */
      profileList: Cli('config profile list').handle(async ({ io }: any) => {
        try {
          const active = profileService.active();
          const all = profileService.list();

          if (all.length === 0) {
            io.log('No profiles found.');
            io.log('');
            io.log('Create a profile with:');
            io.log('  config profile create <name>');
            return;
          }

          io.log('Available profiles:\n');

          for (const name of all) {
            const marker = name === active ? '  *' : '   ';
            const suffix = name === active ? ' (active)' : '';
            io.log(`${marker} ${name}${suffix}`);
          }

          io.log('');
          io.log(`Active: ${active}`);

          // Show how the active profile is determined
          if (process.env.JUSTSCALE_PROFILE) {
            io.log('Source: JUSTSCALE_PROFILE environment variable');
          } else {
            io.log('Source: .justscale/.active-profile');
          }
        } catch (error) {
          io.error(`Failed to list profiles: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Switch active profile.
       * Usage: config profile use <name>
       *
       * @example
       * ```bash
       * justscale config profile use staging
       * ```
       */
      profileUse: Cli('config profile use').handle(async ({ io, args }: any) => {
        const name = (args as Record<string, unknown>)['0'] as string | undefined;

        if (!name) {
          io.error('Usage: config profile use <name>');
          io.log('');
          io.log('Examples:');
          io.log('  config profile use local');
          io.log('  config profile use staging');
          return;
        }

        try {
          const current = profileService.active();

          if (current === name) {
            io.log(`Already using profile: ${name}`);
            return;
          }

          profileService.use(name);

          io.log(`Active profile changed: ${current} -> ${name}`);
          io.log('  Saved to .justscale/.active-profile');
          io.log('');
          io.log('  Warning: Restart your application for changes to take effect.');
          io.log('  Currently running processes continue using the previous profile.');
        } catch (error) {
          io.error(`Failed to switch profile: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Create a new profile.
       * Usage: config profile create <name> [--from=<source>]
       *
       * @example
       * ```bash
       * justscale config profile create test
       * justscale config profile create test --from=staging
       * ```
       */
      profileCreate: Cli('config profile create').handle(async ({ io, args, options }: any) => {
        const name = (args as Record<string, unknown>)['0'] as string | undefined;
        const copyFrom = (options as Record<string, unknown>)?.['from'] as string | undefined;

        if (!name) {
          io.error('Usage: config profile create <name> [--from=<source>]');
          io.log('');
          io.log('Examples:');
          io.log('  config profile create test');
          io.log('  config profile create prod --from=staging');
          return;
        }

        try {
          profileService.create(name, copyFrom);

          io.log(`Created profile: ${name}`);
          if (copyFrom) {
            io.log(`  Copied from: ${copyFrom}`);
          } else {
            io.log('  Empty profile created');
          }
          io.log('');
          io.log('Edit the profile at:');
          io.log(`  .justscale/profiles/${name}.json`);
        } catch (error) {
          io.error(`Failed to create profile: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Delete a profile.
       * Usage: config profile delete <name>
       *
       * @example
       * ```bash
       * justscale config profile delete test
       * ```
       */
      profileDelete: Cli('config profile delete').handle(async ({ io, args }: any) => {
        const name = (args as Record<string, unknown>)['0'] as string | undefined;

        if (!name) {
          io.error('Usage: config profile delete <name>');
          io.log('');
          io.log('Examples:');
          io.log('  config profile delete test');
          return;
        }

        try {
          // Simple confirmation (no interactive prompt in MVP)
          io.log(`Deleting profile: ${name}`);
          profileService.delete(name);
          io.log(`Deleted profile: ${name}`);
        } catch (error) {
          io.error(`Failed to delete profile: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Compare two profiles.
       * Usage: config profile diff <from> <to>
       *
       * @example
       * ```bash
       * justscale config profile diff local staging
       * ```
       */
      profileDiff: Cli('config profile diff').handle(async ({ io, args }: any) => {
        const from = (args as Record<string, unknown>)['0'] as string | undefined;
        const to = (args as Record<string, unknown>)['1'] as string | undefined;

        if (!from || !to) {
          io.error('Usage: config profile diff <from> <to>');
          io.log('');
          io.log('Examples:');
          io.log('  config profile diff local staging');
          io.log('  config profile diff staging production');
          return;
        }

        try {
          const diffs = profileService.diff(from, to);

          if (diffs.length === 0) {
            io.log(`Profiles '${from}' and '${to}' are identical.`);
            return;
          }

          io.log(`Differences between '${from}' and '${to}':\n`);

          for (const { key, from: fromVal, to: toVal } of diffs) {
            io.log(`  ${key}:`);
            io.log(`    ${from}: ${formatValue(fromVal)}`);
            io.log(`    ${to}:   ${formatValue(toVal)}`);
            io.log('');
          }

          io.log(`Total differences: ${diffs.length}`);
        } catch (error) {
          io.error(`Failed to diff profiles: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    }),
  });
}
