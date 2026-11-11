// Node-side stand-in for the `cloudflare:workers` module, aliased by the Node unit tests of
// core/lib, the core Workers and the packages and suites outside core (each vitest.config.ts). It
// exists so a module whose only platform dependency is a base class (RpcTarget, WorkerEntrypoint,
// DurableObject) can load in plain Node without a per-file `vi.mock("cloudflare:workers")`
// (iterate/no-vi-mock). It proves nothing about the runtime: class bodies never run as Workers
// here, and `env` starts empty; a test may fill it with the bindings the module reads
// (packages/ui's src/apps/server.test.ts). Behaviour that needs workerd is not tested here.
// Types still come from @cloudflare/workers-types; the alias
// replaces the module at run time only.

export class RpcTarget {}
export class RpcStub {}
export class RpcPromise {}
export class RpcProperty {}
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  env!: Env;
  ctx!: {
    props: Props;
    exports: Record<string, unknown>;
    waitUntil(promise: Promise<unknown>): void;
  };
}
export class DurableObject<Env = unknown> {
  protected env: Env;
  protected ctx: unknown;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
/** The runtime keeps the invocation alive until the promise settles; Node runs it to the end. A test
 *  replaces `waitUntil.hold` (vi.spyOn) to see what a module hands over, or to throw as a runtime
 *  with no invocation to hold would. */
export function waitUntil(promise: Promise<unknown>): void {
  waitUntil.hold(promise);
}
waitUntil.hold = (promise: Promise<unknown>): void => {
  void promise;
};
