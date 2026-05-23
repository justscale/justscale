import { config, type ConfigSource } from '@justscale/core';
import type { z } from 'zod';
import { HttpConfig } from './config.js';

type HttpConfigShape = z.infer<typeof HttpConfig.schema>;

export const httpEnv = (source: ConfigSource<HttpConfigShape> = {}) =>
  config(HttpConfig, source);
