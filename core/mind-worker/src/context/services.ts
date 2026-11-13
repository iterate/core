// services.ts — `itx.services`, the services the stack binds (core/alchemy config `services`); the
// call contract is iterate/principal `ServiceCaller`. A rule to one method gives a context that alone.
import { verifyOnBehalfOf, type ItxHostRootContext } from "core-itx";
import { codedError, releasedAnswer, withTimeout } from "iterate/lib";
import type { ServiceCaller } from "iterate/principal";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { z } from "zod";
import { hopCaller } from "./hop-caller.ts";

/** What the deploy gives this Worker as `SERVICES`: each service's name, and its line for the list
 *  of capabilities. */
export const ServiceListing = z.array(
  z.object({ name: z.string(), description: z.string().optional() }),
);
export type ServiceListing = z.infer<typeof ServiceListing>;

export type ServiceStub = Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;

export type ServicesOptions = {
  listed: ServiceListing;
  binding(name: string): ServiceStub | undefined;
  domain: string;
  signingSecret(): Promise<string>;
};

export function servicesRootDescription(listed: ServiceListing): string {
  const names = listed.map(({ name, description }) =>
    description ? `\`${name}\` (${description})` : `\`${name}\``,
  );
  return `the Workers of the mind's Cloudflare account that its stack binds, each called with who calls first: \`itx.services.<name>.<method>(...args)\` → <method>(caller, ...args) on its entrypoint; ${names.join(", ")}`;
}

export function servicesRoot(scope: ItxHostRootContext, options: ServicesOptions) {
  const call = async (name: string, method: string, args: unknown[]) => {
    const what = `itx.services.${name}.${method}`;
    const stub = options.listed.some((listed) => listed.name === name)
      ? options.binding(name)
      : undefined;
    if (!stub)
      throw codedError(
        "NO_SERVICE",
        `${what}: the stack binds no service "${name}" (it binds ${options.listed.map((listed) => listed.name).join(", ")})`,
      );
    const missing = () =>
      codedError("NOT_A_METHOD", `${what}: the service has no method "${method}"`);
    const fn = stub[method];
    if (typeof fn !== "function") throw missing();
    const caller = await serviceCallerOf(scope, options, method);
    try {
      // `Reflect.apply`: `.call` on an RPC stub's method is a remote path (core/itx dispatch.ts)
      const answer: Promise<unknown> = Reflect.apply(fn, stub, [caller, ...args]);
      return await withTimeout(releasedAnswer(answer), RUN_DEADLINE_MS, what);
    } catch (error) {
      // workerd's own words for an entrypoint that has no such method
      if (String(error).includes(`does not implement the method "${method}"`)) throw missing();
      throw error;
    }
  };
  // Any name answers: a thenable or a symbol never, so awaiting a step finds no `then`.
  const named = <T>(of: (name: string) => T) =>
    new Proxy(
      {},
      { get: (_, key) => (typeof key === "string" && key !== "then" ? of(key) : undefined) },
    );
  return named((name) =>
    named(
      (method) =>
        (...args: unknown[]) =>
          call(name, method, args),
    ),
  );
}

async function serviceCallerOf(
  scope: Pick<ItxHostRootContext, "caller" | "path">,
  options: Pick<ServicesOptions, "domain" | "signingSecret">,
  method: string,
): Promise<ServiceCaller> {
  const caller = hopCaller(scope);
  // a run's person rides as a token its cause carries; a forged or stale one names nobody
  const token = caller.cause?.onBehalfOf;
  const onBehalfOf =
    caller.onBehalfOf ||
    (token ? await verifyOnBehalfOf(token, await options.signingSecret(), Date.now()) : undefined);
  // a grant is the principal's: with nobody, it names nothing
  return {
    mind: options.domain,
    path: caller.path || scope.path,
    call: method,
    principal: caller.principal || undefined,
    grant: caller.principal ? caller.grant : undefined,
    onBehalfOf: onBehalfOf && {
      principal: onBehalfOf.principal,
      grant: onBehalfOf.grant,
      run: onBehalfOf.run,
      call: onBehalfOf.call,
    },
  };
}
