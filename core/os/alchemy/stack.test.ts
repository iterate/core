// alchemy/stack.test.ts — THE STACK AS A DEPLOYMENT'S FACET COMPILES IT: stack.ts over engine.ts's
// providers and host, as ../src/deployment/run.ts composes them, with a fake token and in-memory
// state. Compiling calls no API, so a row here sees what the stack decides before any plan; what
// Cloudflare makes of a plan and an apply is the live proofs' (tasks/alchemy-native-deploy.md).
// cf dev's binding table (../cloudflare.config.ts) is held to the stack's here too.
import { type CompiledStack, Stack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import cloudflareConfig from "../cloudflare.config.ts";
import { deploymentOf, type IterateConfigInput } from "../src/iterate-config.ts";
import { cloudflareProviders, hostLayer } from "./engine.ts";
import { iterateStack } from "./stack.ts";

// fake ids, built at run time (lint/public-copies.test.ts)
const account = "a".repeat(32);
const otherAccount = "b".repeat(32);

test.for([
  // protectData unset, as most configs leave it
  { name: "a destroy deletes every resource", cloudflare: {}, removal: "destroy" },
  {
    name: "protectData retains every resource, the sandboxes' application inside the Worker too",
    cloudflare: { protectData: true },
    removal: "retain",
  },
])("$name, and each stays live in alchemy dev", async ({ cloudflare, removal }) => {
  // "live" is remote()'s mark: a resource that alchemy dev emulated instead would be replaced
  const resource = { removal, mode: "live" };
  const resources = { DB: resource, OAUTH_KV: resource, ITX_KV: resource, FILES: resource };
  expect(deployed(await compile({ cloudflare }))).toMatchObject({
    resources: { ...resources, Worker: resource, SandboxContainer: resource },
  });
});

test("each set secret binds as secret_text, its value from the host's variables", async () => {
  expect(deployed(await compile({}))).toMatchObject({
    bindings: {
      ITERATE: { type: "plain_text" },
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: { type: "secret_text", text: '"a-password"' },
      ITERATE__SECRETS_ENCRYPTION__KEY: { type: "secret_text", text: '"the-key"' },
    },
  });
});

test("the warehouse's stream and Worker bind as Cloudflare's own descriptors", async () => {
  const telemetry = { workerName: "telemetry", eventsStream: "iterate-events" };
  expect(deployed(await compile({ cloudflare: { telemetry } }))).toMatchObject({
    bindings: {
      TELEMETRY_EVENTS: { type: "pipelines", pipeline: "iterate-events" },
      TELEMETRY: { type: "service", service: "telemetry", entrypoint: "TelemetryQuery" },
    },
  });
});

test.for([
  {
    name: "a config without a cloudflare section",
    deploy: { config: { cloudflare: undefined } },
    error: "the iterate config has no `cloudflare` section",
  },
  {
    name: "a stage other than the Worker's name",
    deploy: { stage: "acme" },
    error: "the stage is acme, but it must be the Worker's name: --stage acme-os",
  },
  {
    name: "credentials that reach another account",
    deploy: { credentialsAccount: otherAccount },
    error: `cloudflare.accountId is ${account}, but the credentials reach ${otherAccount}`,
  },
])("refuses $name", async ({ deploy, error }) => {
  await expect(compile(deploy)).rejects.toThrow(error);
});

test("a deployment has each binding cf dev has, under the same compatibility flags", async () => {
  const { worker } = await cloudflareConfig({ mode: "test", isPreview: false });
  const { bindings, props } = deployed(await compile({}));
  // Alchemy binds ASSETS itself for a Worker with assets (Cloudflare/Workers/WorkerProvider.ts)
  expect({ names: [...Object.keys(bindings), "ASSETS"], props }).toMatchObject({
    names: expect.arrayContaining(Object.keys(worker.env)),
    props: { compatibility: { flags: worker.compatibilityFlags } },
  });
});

/** The stack compiled as a deployment's attempt compiles it: the config below with `cloudflare`
 *  merged into its section and `config` over the whole, and the host's variables its ITERATE and
 *  each secret as a variable of its own. */
function compile({
  cloudflare = {},
  config = {},
  stage = "acme-os",
  credentialsAccount = account,
}: {
  cloudflare?: Partial<NonNullable<IterateConfigInput["cloudflare"]>>;
  config?: Partial<IterateConfigInput>;
  stage?: string;
  credentialsAccount?: string;
}) {
  const deployment = deploymentOf({
    cloudflare: {
      accountId: account,
      apiToken: "cf-token",
      resourcePrefix: "acme-os",
      ...cloudflare,
    },
    login: { methods: { password: { password: "a-password" } }, allow: [{ everyone: {} }] },
    secretsEncryption: { key: "the-key" },
    ...config,
  });
  const { ITERATE, secrets } = deployment.vars;
  // compiling reads no path of the release
  const release = { dir: "/r", version: "abc1234" };
  return Effect.runPromise(
    Stack(
      "iterate",
      {
        providers: cloudflareProviders("a-fake-token", credentialsAccount),
        state: inMemoryState(),
      },
      iterateStack({ deployment, release, images: {} }),
    ).pipe(Effect.scoped, Effect.provide(hostLayer(stage, { ITERATE, ...secrets }))),
  );
}

/** What a deploy of the compiled stack would send: the Worker's binding rows by name and its props,
 *  and each resource's removal policy and provider mode. */
function deployed(stack: CompiledStack) {
  const rows = (stack.bindings.Worker || []).flatMap((row) => row.data.bindings || []);
  return {
    bindings: Object.fromEntries(rows.map((row) => [row.name, row])),
    props: stack.resources.Worker.Props,
    resources: Object.fromEntries(
      Object.values(stack.resources).map((resource) => [
        resource.LogicalId,
        { removal: resource.RemovalPolicy, mode: resource.Mode },
      ]),
    ),
  };
}
