import type { ItxHostRootContext } from "core-itx";
import { InvokeHandle, print } from "iterate/expression";
import { codedError } from "iterate/lib";
import { isMindDomain, PLATFORM_NAMESPACES, publishedMindOf } from "iterate/signed";
import type { StreamEvent } from "iterate/stream/processor";
import type { Door } from "iterate/workers";
import { hopCaller } from "./hop-caller.ts";
import { assertDeliveryCaller } from "./webhooks.ts";

export const MINDS_ROOT_DESCRIPTION =
  "another mind that lets this one in, as a row's target: `subscribe({ name, target: \"itx.minds.get('<domain>').deliverEvents\" })` signs each event with this mind's key and adds it on that mind under /minds/<this mind><the event's path> (minds.md in the config repo)";

const NOT_SENT = [...PLATFORM_NAMESPACES, "mind-meld"];

/** `itx.minds.get(domain)`: a row's target that sends each event to the mind at `domain`, as a
 *  statement signed with this mind's key (core/auth-worker/src/minds.ts checks it there). */
export function mindsRoot(
  context: ItxHostRootContext,
  { domain, boundary }: { domain: string; boundary: () => Pick<Door, "signForMind"> },
) {
  // Through the mind root's `itx.fetch`, so the root's rules for a way out apply. Not the context's
  // own: a context with no parent link (`/integrations/…`, `/minds/…`) has no `itx.fetch` at all,
  // and a meld is the mind's, set by a member, not one context's.
  const ownFetch = async (request: Request) =>
    (await context
      .context("/")
      // `invoke` answers unknown; the root's `itx.fetch` answers a Response, as a webhook's does.
      .invoke(["itx", "fetch"], [request], hopCaller(context))) as Response;
  return {
    // An InvokeHandle, so across a `cd` hop the delivery's call reaches it whole, as a webhook's.
    get: (peer: string) => {
      if (!isMindDomain(peer) || peer === domain)
        throw codedError("INVALID_INPUT", "minds.get(domain): another mind's domain, lowercase");
      return new InvokeHandle(async (methodSteps) => {
        const [call] = methodSteps;
        const method = Array.isArray(call) ? call[0] : undefined;
        if (methodSteps.length !== 1 || (method !== "deliverEvents" && method !== "deliverEvent"))
          throw new Error(
            `minds.get(domain).${print(methodSteps)}: a mind answers deliverEvents(events) and deliverEvent(event) alone`,
          );
        // `method` is a string only when the step is a call, `[name, ...args]`: its first argument.
        const sent = (call as unknown[])[1];
        await assertDeliveryCaller(
          context.caller().delivery,
          `minds.get(domain).${method}`,
          JSON.stringify(sent),
        );
        // What the delivery loop sent, and `assertDeliveryCaller` just matched with its hash: the
        // events of the row, or the one event of a fan-out row.
        const events = (method === "deliverEvents" ? sent : [sent]) as StreamEvent[];
        // A row's retries keep no word of why a try failed: this line does.
        try {
          const published = await publishedMindOf(peer, ownFetch);
          if ("why" in published) throw new Error(`${peer} gave no document: ${published.why}`);
          for (const event of events) {
            // The platform's own facts and the rules that let a mind in are each mind's own. The
            // other mind refuses them always, so one sent would hold an ordered row for good.
            if (NOT_SENT.some((name) => event.type.startsWith(`events.iterate.com/${name}/`)))
              continue;
            const envelope = await boundary().signForMind({
              mind: peer,
              path: `/minds/${domain}${event.path === "/" ? "" : event.path}`,
              type: event.type,
              payload: event.payload,
              about: [`${event.path}@${event.offset}`],
            });
            // A followed redirect would carry the statement to another origin. No signal: a Request
            // with one cannot cross to the root, and the delivery watchdog (20 s) ends a call that hangs.
            const answer = await ownFetch(
              new Request(published.statements, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(envelope),
                redirect: "manual",
              }),
            );
            const text = await answer.text();
            if (answer.status !== 200)
              throw new Error(
                `${peer} answered ${answer.status} to ${event.path}@${event.offset}: ${text.slice(0, 500)}`,
              );
          }
        } catch (error) {
          console.info({ event: "minds.delivery-failed", peer, message: String(error) });
          throw error;
        }
      });
    },
  };
}
