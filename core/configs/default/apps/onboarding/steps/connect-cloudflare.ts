// connect-cloudflare.ts — THE STEP "Connect Cloudflare": the mind reads the Cloudflare account it
// runs in (its logs, errors and settings) and changes nothing there. Its one button begins the
// same connect as the Integrations card's "Connect" (../../../cloudflare.ts `cloudflareConnect`):
// one consent on the page of Cloudflare's MCP server, which then brings the owner back here.
//
// The card reads the vault alone: whether `/secrets/cloudflare` is set. Whether the grant still
// works, and for which account, is the Integrations card's to say. No request goes to Cloudflare
// before a press, and the step asks nothing to settle: the connect is the vault's attempt.
import { z } from "zod";
import { cloudflareConnect } from "../../../cloudflare.ts";
import type { Card, MindEvent, Step, StepContext } from "../steps.ts";
import type { StepState } from "../contract.ts";

const GRANT = "/secrets/cloudflare";

const Facts = z.object({ connected: z.boolean() });

function words(state: StepState): Card {
  const card = { step: connectCloudflare.id, title: "Connect Cloudflare", optional: true };
  if (Facts.safeParse(state.facts).data?.connected)
    return {
      ...card,
      status: "connected",
      text: [
        "Your mind reads the Cloudflare account it runs in. The Integrations page says which account, and whether Cloudflare still answers.",
      ],
      buttons: [],
    };
  if (state.declined)
    return {
      ...card,
      status: "declined",
      text: ["Not connected. You can connect at any time here or on the Integrations page."],
      buttons: [{ label: "Connect Cloudflare", action: "connect" }],
    };
  return {
    ...card,
    status: "not-asked",
    text: [
      "Let your mind read the Cloudflare account it runs in: what is deployed, its logs and its errors. It can change nothing there.",
      "You approve once, on Cloudflare's own page.",
    ],
    buttons: [
      { label: "Connect Cloudflare", action: "connect", primary: true },
      { label: "Not now", action: "decline" },
    ],
  };
}

export const connectCloudflare: Step = {
  id: "connect-cloudflare",
  actions: { connect: { opens: true } },
  offered: () => true,
  words: (state: StepState) => words(state),
  async check(context: StepContext) {
    return { connected: (await context.itx.secrets.describe(GRANT)).set };
  },
  // the consent's page brings the owner back to this page
  async act(context: StepContext, action: string) {
    if (action !== "connect") return;
    const { link } = await cloudflareConnect(context.itx, {
      next: `https://onboarding.${context.zone}/`,
    });
    return { link };
  },
  hears: (event: MindEvent) =>
    event.path === GRANT &&
    [
      "events.iterate.com/secret/set",
      "events.iterate.com/secret/deleted",
      "events.iterate.com/secret/grant-refused",
    ].includes(event.type),
  // the check after each event the step hears makes the card true
  async onEvent() {},
};
