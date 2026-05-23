/**
 * PTS Loader Registration
 *
 * This module registers the PTS loader with Node.js.
 * Use with --import flag:
 *
 *   node --import @justscale/compiler/register ./app.ts
 *
 * Or with tsx:
 *
 *   node --import @justscale/compiler/register --import tsx ./app.ts
 */

import { register } from 'node:module';

// Register the PTS loader
// The loader will be called before tsx (if also registered)
register('./loader.js', import.meta.url);

if (process.env.PTS_VERBOSE === '1') {
  console.log('[pts] Loader registered');
}
