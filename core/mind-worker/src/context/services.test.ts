import type { Caller, ItxHostRootContext } from "core-itx";
import { codedError, errorCode } from "iterate/lib";
import { serviceCallerOf } from "iterate/principal";
import { expect, test, vi } from "vitest";
import { servicesRoot, servicesRootDescription, type ServiceStub } from "./services.ts";

const listed = [{ name: "cloud", description: "installs minds" }];

test("a call names who calls first, from the platform: the mind, the calling context, the person and the method", async () => {
  const { stub, calls } = pretendService();
  const cloud = services(
    {
      principal: { actor: "u1", email: "ada@mind.example" },
      grant: "g1",
      path: "/agents/jail",
      app: true,
    },
    stub,
  ).cloud!;
  expect(await cloud.whoCalled!({ slug: "x" })).toEqual({
    caller: {
      mind: "mind.example",
      path: "/agents/jail",
      call: "whoCalled",
      principal: { actor: "u1", email: "ada@mind.example" },
      grant: "g1",
    },
    args: [{ slug: "x" }],
  });
  expect(calls).toHaveLength(1);
  // a caller with no path is the context the root is built at
  expect(await services({ principal: null }).cloud!.whoCalled!()).toMatchObject({
    caller: { mind: "mind.example", path: "/", call: "whoCalled" },
  });
});

test("a service not bound, a method it has not got, and its own coded refusal each answer a code", async () => {
  const root = services({ principal: null });
  await expect(root.nope!.whoCalled!()).rejects.toSatisfy(
    (error) => errorCode(error) === "NO_SERVICE",
  );
  await expect(root.cloud!.noSuchMethod!()).rejects.toSatisfy(
    (error) => errorCode(error) === "NOT_A_METHOD",
  );
  await expect(root.cloud!.refuses!()).rejects.toSatisfy(
    (error) => errorCode(error) === "FORBIDDEN",
  );
  // configured, but the binding is not there
  await expect(services({ principal: null }, null).cloud!.whoCalled!()).rejects.toSatisfy(
    (error) => errorCode(error) === "NO_SERVICE",
  );
});

test("workerd's refusal of a method an entrypoint has not got becomes NOT_A_METHOD", async () => {
  const stub: ServiceStub = {
    gone: async () => {
      throw new TypeError('The RPC receiver does not implement the method "gone".');
    },
  };
  await expect(services({ principal: null }, stub).cloud!.gone!()).rejects.toSatisfy(
    (error) => errorCode(error) === "NOT_A_METHOD",
  );
});

test("a service that never answers fails the call with TIMEOUT", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const answer = services({ principal: null }).cloud!.hangs!();
  const settled = expect(answer).rejects.toSatisfy((error) => errorCode(error) === "TIMEOUT");
  await vi.runAllTimersAsync();
  await settled;
});

test("awaiting the root or a service finds no `then`, and the description lists each service", async () => {
  const root = services({ principal: null });
  expect(root.then).toBeUndefined();
  expect(root.cloud!.then).toBeUndefined();
  expect(servicesRootDescription(listed)).toContain("`cloud` (installs minds)");
});

test("a call that did not come through a mind is refused by the service's read of its caller", () => {
  expect(() => serviceCallerOf({ path: "/" })).toThrow(/not a mind's call/);
});

/** A service's entrypoint as a binding answers it: each call's arguments kept, and a method that
 *  throws a coded error. */
function pretendService() {
  const calls: unknown[][] = [];
  const stub: ServiceStub = {
    whoCalled: async (caller: unknown, ...args: unknown[]) => {
      calls.push([caller, ...args]);
      return { caller: serviceCallerOf(caller), args };
    },
    refuses: async () => {
      throw codedError("FORBIDDEN", "not this mind");
    },
    hangs: () => new Promise(() => {}),
  };
  return { stub, calls };
}

function services(caller: Caller, stub: ServiceStub | null = pretendService().stub) {
  const scope = { path: "/", caller: () => caller } as unknown as ItxHostRootContext;
  return servicesRoot(scope, {
    listed,
    binding: (name) => (name === "cloud" && stub ? stub : undefined),
    domain: "mind.example",
    signingSecret: async () => "proof-secret",
  }) as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}
