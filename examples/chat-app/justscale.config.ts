import { defineProject } from '@justscale/core';

export default defineProject({
  app: {
    default:     () => import('./src/app.js'),
    development: () => import('./src/dev.js'),
    test:        () => import('./src/test.js'),
  },
});
