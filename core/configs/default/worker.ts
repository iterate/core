// worker.ts — THIS FILE IS THE MIND.
//
// A mind is a small stack of Cloudflare Workers in its owner's own Cloudflare account, at the
// owner's own domain. The platform keeps the mind's contexts (each one a log of events), runs its
// agents, keeps its secrets and signs people in. What the mind DOES is this repo: a commit to
// `main` is live a few seconds later, and the mind's own agents commit here too.
//
// The platform calls three methods of the class below:
//
//   fetch(request)             every request to a hostname of the mind: its apps, its website
//   email({ mail, forward })   every mail to an address of the mind
//   processEvent({ event })    every event of every context: a mail, a Slack message, a commit,
//                              a schedule that fired
//
// Every other public method of the class is the mind's own API, `itx.config.<name>(…)`, for its
// agents and its pages. Those are in api.ts. AGENTS.md is the guide to the rest of the repo.
import type { EmailHookArgs } from "iterate/email";
import type { IterateConfigProcessEventArgs } from "iterate/sdk";
import { ConfigApi, TASKS_BOARD_REPO } from "./api.ts";
import { dashApp } from "./apps/dash/app.ts";
import { framedSignIn } from "./apps/dash/framed-sign-in.ts";
import { docsApp } from "./apps/docs/app.ts";
import { meetApp } from "./apps/meet/app.ts";
import { onboardingApp } from "./apps/onboarding/app.ts";
import { tasksApp } from "./apps/tasks/app.ts";
import { crashSweepEvent, installCrashSweep } from "./apps/telemetry/crashes.ts";
import { exceptionsEvent } from "./apps/telemetry/exceptions.ts";
import { addPageTag, documentRequest, pageEvents } from "./apps/telemetry/page-tag.ts";
import { cloudHandoverEvent, iterateLetInEvent } from "./cloud-handover.ts";
import { cloudDeliveryEvent, otherMindEvent } from "./deliveries.ts";
import { everyEvent } from "./every-event.ts";
import { homepage } from "./homepage.ts";
import { init, step } from "./init.ts";
import { ITERATE_CORE_SYNC_REQUESTED, iterateCoreSyncEvent } from "./iterate-core.ts";
import { mailDeliveryFailed, mailReceived } from "./mail.ts";
import { cloudflareClient, me, publicProfile } from "./website.ts";

// The apps: a folder each under apps/ (apps.md).
const dash = dashApp();
const docs = docsApp();
const meet = meetApp();
// The onboarding page and its guides are the repo /repos/onboarding; this repo keeps its steps.
const onboarding = onboardingApp({ repo: "/repos/onboarding" });
// The Tasks board shows the markdown files under tasks/ of the repo that the task calls use too
// (api.ts `TASKS_BOARD_REPO`): /repos/onboarding, the onboarding cards.
const tasks = tasksApp({ repo: TASKS_BOARD_REPO });

export default class extends ConfigApi {
  // EVERY REQUEST, on every hostname of the mind but `iterate.<zone>`, where the platform answers
  // (sign-in, the API, MCP).
  async fetch(request: Request) {
    // Every page reports its views, its speed and its errors (page-events.md): the reports are
    // taken here, and at the end each HTML page among the answers gets the tag that sends them.
    const reported = await pageEvents(request, this);
    if (reported) return reported;

    // An app is on `<name>.<zone>`. Each call below is a partial fetcher: it answers, or it says
    // null and the next one gets the request. `this.auth.require` is one too: null for a member,
    // the sign-in for anyone else. An app's name and icon are for anyone (`open`).
    const route = async (request: Request): Promise<Response> => {
      switch (new URL(request.url).hostname.split(".")[0]) {
        case "dash": // the Dash, for members: the mind seen from above, and a chat with every agent
          return (
            dash.open(request) ||
            framedSignIn(request, this.auth.require(request)) ||
            dash.fetch(request, this)
          );
        case "docs": // Docs, for members: the files of the mind's repos, written together
          return docs.open(request) || this.auth.require(request) || docs.fetch(request, this);
        case "meet": // Meet, for members and their guests: its own routes ask for who they need
          return meet.fetch(request, this);
        case "onboarding": // the first steps of a new mind, for members
          return (
            onboarding.open(request) ||
            this.auth.require(request) ||
            onboarding.fetch(request, this)
          );
        case "tasks": // Tasks, for members: the board of markdown files under tasks/
          return tasks.open(request) || this.auth.require(request) || tasks.fetch(request, this);
      }
      // THE PUBLIC WEBSITE, for anyone, on every other hostname
      return (
        me(request, this) || // who the visitor is
        (await cloudflareClient(request, this)) || // the mind's client at Cloudflare's MCP server
        publicProfile(request) || // the mind's name, description and icon (profile/)
        (await homepage(request, this)) || // homepage.ts: change that file to make the site yours
        new Response("Not found\n", { status: 404 })
      );
    };
    const answer = await route(documentRequest(request, this));
    return addPageTag(request, answer, this, (work) => this.ctx.waitUntil(work));
  }

  // EVERY MAIL to an address of the mind, while its delivery is live. `save()` keeps it: one
  // event on the context /integrations/email, which the `email/received` case below hands to an
  // agent. A hook that returns without it leaves the mail off the log, and no agent gets it; one
  // that throws or runs out of time leaves the mail on the log. To send the original on:
  // `await forward("someone@example.com")`.
  async email({ save }: EmailHookArgs) {
    await save();
  }

  // EVERY EVENT of every context of the mind, one at a time, in no order, at least once: each
  // case is idempotent, and nothing is kept here. `itx` is the mind's root.
  async processEvent({ event, itx }: IterateConfigProcessEventArgs<"agents">) {
    // what broke, anywhere in the mind, becomes an event on /exceptions (errors.md)
    await exceptionsEvent(itx, event);
    switch (event.type) {
      case "events.iterate.com/mind/worker-updated":
        // This repo was published. It happens after every commit, so every line is idempotent.
        // A `step` that throws is reported under its name, and the lines after it still run.
        await init(itx); // the agents, and what iterate Cloud is told (init.ts)
        // A schedule appends an event on a clock, and a case below reacts to it. This one asks
        // every 60 s what crashed.
        await step("crash-sweep", () => installCrashSweep(itx));
        // await step("heartbeat", () =>
        //   itx.schedules.set({ key: "heartbeat", when: { everyMs: 300_000 }, events: [{ type: "heartbeat" }] }),
        // );
        break;
      case "events.iterate.com/exception/sweep-requested": // the crash schedule fired
        await crashSweepEvent(itx, event);
        break;
      case ITERATE_CORE_SYNC_REQUESTED: // pull latest github.com/iterate/core into /repos/github.com/iterate/core
        await iterateCoreSyncEvent(itx, event);
        break;
      case "events.iterate.com/email/received": // a mail came: it goes to the agent it is for
        await mailReceived(itx, event);
        break;
      case "events.iterate.com/email/delivery-failed": // a mail bounced: its sender's agent is told
        await mailDeliveryFailed(itx, event);
        break;
      case "events.iterate.com/cloud/installation-handed-over": // what the owner said at sign-up
        await cloudHandoverEvent(itx, event);
        break;
      case "events.iterate.com/mind-meld/configured": // the owner let iterate's mind in
        await iterateLetInEvent(itx, event);
        break;
      default:
        // What happens in the accounts a member connected, relayed and signed by iterate Cloud:
        // a Slack thread and an X conversation each get an agent, Gmail and Calendar are watched,
        // and this repo and its GitHub repository stay one history (deliveries.ts).
        await cloudDeliveryEvent(itx, event);
    }
    // what looks at every event: the Integrations page's cards, each context's description, the
    // onboarding steps, your integration packages (every-event.ts)
    await everyEvent(itx, event);
  }

  // An event that ANOTHER MIND added here, signed with its own key, never reaches `processEvent`:
  // its words are data, never a member's instruction (minds.md). iterate's mind sends iterate
  // Cloud's deliveries this way, and they run the same cases as above.
  async processMindEvent({
    event,
    itx,
  }: IterateConfigProcessEventArgs<"agents"> & { mind: string }) {
    await otherMindEvent(itx, event);
  }
}
