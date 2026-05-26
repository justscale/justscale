import JustScale, { Config } from '@justscale/core';
import { HttpConfig } from '@justscale/http';
import { GreetingService } from './greeting.service.js';
import { SubController } from './sub.controller.js';
import { SubScopedService } from './sub.service.js';

export const SubApp = JustScale()
  .requires(GreetingService)
  .requires(Config.of(HttpConfig))
  .add(SubScopedService)
  .add(SubController)
  .build();
