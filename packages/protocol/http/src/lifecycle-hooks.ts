declare module '@justscale/core' {
  interface LifecycleHooks {
    /** Fired after the HTTP server binds successfully. */
    httpServing(): Promise<void> | void
  }
}

export {};
