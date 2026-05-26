import JustScale, { defineApp } from '@justscale/core';
import type { AppEnv } from '../env/test.js';
import { GreetingController } from './greeting.controller.js';
import { GreetingService } from './greeting.service.js';
// Pre-imported but not wired. The "adds a new controller" e2e edits
// this file to insert `.add(AdminController)`; keeping the import here
// upfront means the edit is a single-line change AND the module is
// actually loaded on boot (esbuild tree-shakes unused named imports,
// so we `void` the reference to keep it live until the edit uses it
// for real).
import { AdminController } from './admin.controller.js';
import { CounterService } from './counter.service.js';
import { CounterController } from './counter.controller.js';
import { ChildService } from './child.service.js';
import { ParentService } from './parent.service.js';
import { LoudController } from './loud.controller.js';
import { SubApp } from './sub-app.js';
void AdminController;
void CounterService;
void CounterController;
void ChildService;
void ParentService;
void LoudController;

export default defineApp(import.meta, (env: AppEnv) =>
  JustScale()
    .add(env)
    .add(GreetingService)
    .add(SubApp)
    .add(GreetingController),
);
