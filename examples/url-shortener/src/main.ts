// Importing the http protocol registers the server adapter (side effect).
import '@justscale/http';

import { app } from './app.js';

async function main() {
  const compiled = app.compile();
  await compiled.ready;
  await app.serve();

  const port = process.env.PORT ?? 3000;
  console.log(`URL shortener running on http://localhost:${port}`);
  console.log('  POST /shorten   { "url": "https://example.com" }  -> { slug, short }');
  console.log('  GET  /:slug      -> { target, hits }');
}

main().catch(console.error);
