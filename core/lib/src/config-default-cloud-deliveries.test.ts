// The default config's recogniser of iterate Cloud's deliveries (core/configs/default/
// cloud-deliveries.ts): the key form, the mind form, and what it refuses.
import { expect, test } from "vitest";
import { cloudDeliveryOf } from "../../configs/default/cloud-deliveries.ts";

const CLOUD_KEY = { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } };
const ITERATE_COM = {
  signer: { principal: { actor: "iterate.com", kind: "mind" }, key: "iterate-com-key" },
};
const ADA = {
  provider: "google",
  account: "ada@example.com",
  context: "/integrations/google/ada@example.com",
};

test.for([
  {
    name: "the key form: the mind's own context, signed by the Cloud's key",
    event: { path: "/integrations/google/ada@example.com", source: CLOUD_KEY },
    delivery: ADA,
  },
  {
    name: "the mind form: under /minds/iterate.com, signed by the mind iterate.com",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: ITERATE_COM },
    delivery: ADA,
  },
  {
    name: "the mind form signed by another mind is not the Cloud's",
    event: {
      path: "/minds/iterate.com/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "example.com", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor the mind form's path with the Cloud key's actor",
    event: { path: "/minds/iterate.com/integrations/google/ada@example.com", source: CLOUD_KEY },
  },
  {
    name: "nor the key form signed by a mind",
    event: { path: "/integrations/google/ada@example.com", source: ITERATE_COM },
  },
  {
    name: "nor the key form signed by a mind that calls itself iterate-cloud",
    event: {
      path: "/integrations/google/ada@example.com",
      source: { signer: { principal: { actor: "iterate-cloud", kind: "mind" }, key: "k" } },
    },
  },
  {
    name: "nor another mind's path signed by iterate.com",
    event: { path: "/minds/example.com/integrations/google/ada@example.com", source: ITERATE_COM },
  },
  {
    name: "nor an event nobody signed",
    event: { path: "/integrations/google/ada@example.com", source: {} },
  },
  {
    name: "nor a path one segment too long",
    event: { path: "/integrations/google/ada@example.com/more", source: CLOUD_KEY },
  },
  {
    name: "nor one too short, as the Cloud's hand-over on /integrations/cloud",
    event: { path: "/integrations/cloud", source: CLOUD_KEY },
  },
  {
    name: "nor the mind form one segment too long",
    event: {
      path: "/minds/iterate.com/integrations/google/ada@example.com/more",
      source: ITERATE_COM,
    },
  },
  {
    name: "nor the mind form one segment too short",
    event: { path: "/minds/iterate.com/integrations/google", source: ITERATE_COM },
  },
  {
    name: "nor the mind's own context for the meld",
    event: { path: "/minds/iterate.com", source: ITERATE_COM },
  },
] as { name: string; event: Parameters<typeof cloudDeliveryOf>[0]; delivery?: unknown }[])(
  "$name",
  ({ event, delivery = null }) => {
    expect(cloudDeliveryOf(event)).toEqual(delivery);
  },
);
