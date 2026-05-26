import { createConfig, createEnvironment, type EnvContract } from '@justscale/core';
import { HttpConfig } from '@justscale/http';

export type AppEnv = EnvContract<{
  config: readonly [typeof HttpConfig];
}>;

const TestConfig = createConfig({
  provides: [HttpConfig],
  factory: () => ({
    [HttpConfig.key]: {
      port: Number(process.env.PORT ?? '0'),
      host: '127.0.0.1',
    },
  }),
});

export default createEnvironment<AppEnv>({
  name: 'test',
  type: 'test',
  providers: [TestConfig],
});
