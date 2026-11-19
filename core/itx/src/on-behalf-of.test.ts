import { expect, test } from "vitest";
import { stampCaller } from "./caller.ts";
import { askerOf, mintOnBehalfOf, verifyOnBehalfOf } from "./on-behalf-of.ts";

const SECRET = "test-signing-secret";

// The token is how a person's page names them on a call (person-context.ts): what it holds is what
// `source.onBehalfOf` then says. A name in any script crosses it; a field nobody defined does not.
test("the token carries the person's name, and no field it does not know", async () => {
  const principal = { actor: "user_1", email: "a@example.com", name: "\u0141ukasz \u674E" };
  const onBehalfOf = { principal, via: { appPage: "chat.example.com" }, call: "/a#agent.message" };
  const token = await mintOnBehalfOf(
    { ...onBehalfOf, principal: { ...principal, member: true } as typeof principal },
    SECRET,
    1000,
  );
  expect(await verifyOnBehalfOf(token, SECRET, 1000)).toEqual(onBehalfOf);
  expect(await verifyOnBehalfOf(token, "another-secret", 1000)).toBeUndefined();
});

// The mark of a guest crosses; any other kind is a signer's alone and is dropped, token and all
// the rest kept.
test.for([
  { kind: "guest", kept: { kind: "guest" } },
  { kind: "mind", kept: {} },
])("the token keeps the mark of a guest alone: $kind", async ({ kind, kept }) => {
  const principal = { actor: "user_9", name: "Bob" };
  const token = await mintOnBehalfOf(
    { principal: { ...principal, kind } as typeof principal, call: "/a#agent.message" },
    SECRET,
    1000,
  );
  expect(await verifyOnBehalfOf(token, SECRET, 1000)).toEqual({
    principal: { ...principal, ...kept },
    call: "/a#agent.message",
  });
});

// WHO ASKED is the kernel's own record of the call (`askerOf`): the Caller, never the cause.
test("who asked is a member's session or a person's view, a member is marked by the Caller alone, and a call that only carries a token names nobody", async () => {
  const via = { appPage: "dash.example.com" };
  const ada = { actor: "user_1", email: "ada@example.com" };
  const bob = { actor: "user_9", name: "Bob", kind: "guest" as const };
  const call = "/agents/a#call.join";
  expect(askerOf({ principal: ada, grant: "grant:ada", via }, call)).toStrictEqual({
    principal: ada,
    grant: "grant:ada",
    via,
    call,
    member: true,
  });
  // `toEqual` with every key named: the kernel names the call itself, hands on no other field
  // of the view's, and marks nobody a member whom the view did not
  expect(
    askerOf({ principal: null, onBehalfOf: { principal: bob, via, run: "/@7" } }, call),
  ).toEqual({ principal: bob, via, call, member: undefined, grant: undefined });
  expect(
    askerOf({ principal: null, onBehalfOf: { principal: ada, via, member: true } }, call),
  ).toStrictEqual({ principal: ada, via, call, member: true });
  // a key's session names the service that the key speaks for: no member
  expect(askerOf({ principal: { actor: "bridge" }, grant: "key:k1" }, call)).toStrictEqual({
    principal: { actor: "bridge" },
    grant: "key:k1",
    via: undefined,
    call,
  });
  // the mark is the Caller's alone: a token does not carry it
  const marked = await mintOnBehalfOf({ principal: bob, call, member: true }, SECRET, 1000);
  expect(await verifyOnBehalfOf(marked, SECRET, 1000)).toStrictEqual({ principal: bob, call });
  const token = await mintOnBehalfOf({ principal: ada, call }, SECRET, 1000);
  const cause = { chain: "c", depth: 0, onBehalfOf: token };
  expect(askerOf({ principal: null, app: true, cause }, call)).toBeUndefined();
  expect(askerOf({ principal: null, path: "/agents/a", cause }, call)).toBeUndefined();
  expect(askerOf({ principal: null }, call)).toBeUndefined();
});

// What a facet appends while it runs a person method: its code calls as loaded code, with the
// token of its call on the cause, which the append verifies and stamps (context/built-ins.ts
// `append`). The token of such a call names the person as a facet is told of them.
test("what a facet appends in a guest's call is stamped with the guest, and with no principal", async () => {
  const guest = { actor: "user_9", name: "Bob", kind: "guest" as const };
  const asked = {
    principal: guest,
    via: { appPage: "meet.example.com" },
    call: "/agents/a#call.join",
  };
  const onBehalfOf = await verifyOnBehalfOf(
    await mintOnBehalfOf(asked, SECRET, 1000),
    SECRET,
    1000,
  );
  const cause = { chain: "c", depth: 1 };
  // a writer's own `source` is dropped: the facet cannot name a principal itself
  const event = {
    type: "events.iterate.com/agent/context-added",
    source: { principal: { actor: "user_1" } },
  };
  // `toEqual`: no `principal`, no `grant`, and nothing beyond these
  expect(
    stampCaller(event, { principal: null, app: true, cause, onBehalfOf }, "/agents/a"),
  ).toEqual({ ...event, source: { origin: "/agents/a", cause, onBehalfOf: asked } });
});
