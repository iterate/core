// integrations.ts — THE INTEGRATION PACKAGES THIS MIND HOSTS.
//
// Each element's `processEvent` sees every event of the mind, beside the kinds of agent
// (every-event.ts). The hook contract is iterate/sdk `Integration`.
import type { Integration } from "iterate/sdk";

// The integration packages this mind hosts (a Telegram bot, your own GitHub App, …), one element
// each: apps.md, and the recipes at https://github.com/jonastemplestein/iterategrations. A
// package that serves pages gets a case of its own in worker.ts's `fetch`.
export const integrations: Integration[] = [];
