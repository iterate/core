import type { ItxHostRootContext } from "core-itx";
import { InvokeHandle, print } from "iterate/expression";
import { codedError } from "iterate/lib";
import { publishedMindOf } from "iterate/mind-identity-log";
import {
  isMindControlPlaneHostname,
  isMindId,
  PLATFORM_NAMESPACES,
  STATEMENTS_PATH,
} from "iterate/signed";
import type { StreamEvent } from "iterate/stream/processor";
import type { Door } from "iterate/workers";
import { hopCaller } from "./hop-caller.ts";
import { assertDeliveryCaller } from "./webhooks.ts";

export const MINDS_ROOT_DESCRIPTION =
  "another mind that lets this one in, by its control-plane hostname, as a row's target: `subscribe({ name, target: \"itx.minds.get('<hostname>').deliverEvents\" })` signs each event with this mind's key and adds it on that mind under /minds/<this mind's id><the event's path>, signed for the id that the log at that hostname proves; `.at('<path>').deliverEvents` adds it at that context of the other mind instead, when its rule lets this mind append there (minds.md in the config repo); `itx.minds.get('<hostname or id>').fetch(request)` sends an https request to that mind signed as this one, five minutes, so its boundary stamps this mind as the caller (a WebSocket upgrade is refused on this path). It is `itx.fetch(request, { signFor: '<hostname>' })` of the context where dispatch starts, one Request and nothing more, so that context's rule for itx.fetch decides it: for loaded code that is the caller, wherever the call is spelled (`minds` is answered at the caller); a member's itx.cd(<context>) handle starts at that context, so there that context's fetch decides. A mask refuses it, and a narrow fetch passes the request on and nothing else, so the built-in does not sign it (a request that names a by-proxy secret is still signed by the secrets Worker for that proxy); a context signs wherever it can reach the built-in fetch unchanged, its own or another context's by itx.cd, exactly as it can fetch there: a table that masks its own fetch and leaves itx.cd('/') open has not narrowed fetch. The kernel's loop count does not cross a mind's edge: never answer another mind's request or event with one to that mind unless the app bounds the exchange itself (a nest of requests ends only at Cloudflare's limit, a 503 at about the 14th; a chain of events never ends)";

const NOT_SENT = [...PLATFORM_NAMESPACES, "mind-meld"];

/** A context's own path, as the other mind's intake takes it (core/auth-worker/src/key-rules.ts
 *  `canonicalPath`): no empty, `.` or `..` segment. */
const isContextPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.startsWith("/") &&
  (path === "/" ||
    path
      .split("/")
      .slice(1)
      .every((segment) => segment && segment !== "." && segment !== ".."));

/** `itx.minds.get(hostname)`: a row's target that sends each event to the mind at the
 *  control-plane hostname `hostname`, as a statement signed with this mind's key for the id that
 *  the log there proves (core/auth-worker/src/minds.ts checks it there). `mind` is this mind's own
 *  control-plane hostname, `mindId` its id.
 *  WHERE IT LANDS: under `/minds/<this mind's id><the event's path>`, or, with `.at(path)` before
 *  the delivery, at that one context of the other mind, whatever context here the event is from.
 *  The other mind's rule decides whether this mind may append there; this side only spells the
 *  path. */
export function mindsRoot(
  context: ItxHostRootContext,
  {
    mind,
    mindId,
    boundary,
  }: { mind: string; mindId: string; boundary: () => Pick<Door, "signForMind"> },
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
      if ((!isMindControlPlaneHostname(peer) && !isMindId(peer)) || [mind, mindId].includes(peer))
        throw codedError(
          "INVALID_INPUT",
          "minds.get(mind): another mind's control-plane hostname, or its id, lowercase",
        );
      const delivery = (at?: string): InvokeHandle =>
        // A row's target is evaluated up to its last name, so `.at(path)` alone answers the handle
        // for that path (the delivery loop then calls `deliverEvents` on it); a walk that reduces
        // `.at(path).deliverEvents(events)` into one dispatch is taken whole.
        new InvokeHandle(async (methodSteps) => {
          const [first, ...rest] = methodSteps;
          if (!at && Array.isArray(first) && first[0] === "at") {
            const path = first[1];
            if (first.length !== 2 || !isContextPath(path))
              throw codedError(
                "INVALID_INPUT",
                "minds.get(hostname).at(path): a context's own path, with no empty, . or .. segment",
              );
            return rest.length > 0 ? delivery(path).invoke(rest) : delivery(path);
          }
          const [call] = methodSteps;
          if (!at && methodSteps.length === 1 && Array.isArray(call) && call[0] === "fetch") {
            // ONE ARGUMENT: a fetch row back to this wrapper (`itx.fetch => itx.minds.get(x).fetch(@)`)
            // hands it the option too, so it ends here, at its first turn, and loops no more.
            if (call.length !== 2)
              throw codedError(
                "INVALID_INPUT",
                "minds.get(hostname).fetch(request) takes one Request and nothing more",
              );
            return signedMindFetch(call[1], context, peer);
          }
          return deliver(methodSteps, at);
        });
      const deliver = async (methodSteps: Parameters<InvokeHandle["invoke"]>[0], at?: string) => {
        const [call] = methodSteps;
        const method = Array.isArray(call) ? call[0] : undefined;
        if (methodSteps.length !== 1 || (method !== "deliverEvents" && method !== "deliverEvent"))
          throw new Error(
            `minds.get(hostname).${print(methodSteps)}: a mind answers deliverEvents(events) and deliverEvent(event), each also after at(path), and fetch(request)`,
          );
        // an id says who, not where: the events go to the hostname, whose log proves the id
        if (isMindId(peer))
          throw codedError(
            "INVALID_INPUT",
            `minds.get(<id>).${method}: name the mind by its control-plane hostname to send it events; an id alone serves fetch(request), whose URL says where`,
          );
        // `method` is a string only when the step is a call, `[name, ...args]`: its first argument.
        const sent = (call as unknown[])[1];
        await assertDeliveryCaller(
          context.caller().delivery,
          `minds.get(hostname).${method}`,
          JSON.stringify(sent),
        );
        // What the delivery loop sent, and `assertDeliveryCaller` just matched with its hash: the
        // events of the row, or the one event of a fan-out row.
        const events = (method === "deliverEvents" ? sent : [sent]) as StreamEvent[];
        // A row's retries keep no word of why a try failed: this line does.
        try {
          const published = await publishedMindOf(peer, ownFetch);
          if ("why" in published) throw new Error(`${peer} gave no identity: ${published.why}`);
          for (const event of events) {
            // The platform's own facts and the rules that let a mind in are each mind's own. The
            // other mind refuses them always, so one sent would hold an ordered row for good.
            if (NOT_SENT.some((name) => event.type.startsWith(`events.iterate.com/${name}/`)))
              continue;
            // for the id that the log at `peer` proves: no second read of it
            const envelope = await boundary().signForMind({
              mind: published.expected,
              path: at || `/minds/${mindId}${event.path === "/" ? "" : event.path}`,
              type: event.type,
              payload: event.payload,
              about: [`${event.path}@${event.offset}`],
            });
            // A followed redirect would carry the statement to another origin. No signal: a Request
            // with one cannot cross to the root, and the delivery watchdog (20 s) ends a call that hangs.
            const answer = await ownFetch(
              new Request(`https://${peer}${STATEMENTS_PATH}`, {
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
      };
      return delivery();
    },
  };
}

/** `itx.minds.get(hostname).fetch(request)`: the calling context's OWN `itx.fetch`, as its caller,
 *  with one more argument, `{ signFor: hostname }` (core/itx built-in `fetch`), so the context's
 *  rules decide it as they decide any fetch of its code: a mask refuses it, a rewrite answers
 *  what its target does (a narrow fetch passes the request on and nothing else, so the built-in
 *  signs nothing), and where the built-in is reached the Door signs (`Door.fetchForMind`). */
async function signedMindFetch(
  input: unknown,
  context: Pick<ItxHostRootContext, "invokeAs" | "caller">,
  peer: string,
): Promise<Response> {
  if (!(input instanceof Request))
    throw codedError("INVALID_INPUT", "minds.get(hostname).fetch(request): one Request");
  const url = new URL(input.url);
  if (url.protocol !== "https:")
    throw codedError("INVALID_INPUT", "minds.get(hostname).fetch(request): an https URL");
  if (input.headers.get("upgrade")?.toLowerCase() === "websocket")
    throw codedError(
      "INVALID_INPUT",
      "minds.get(hostname).fetch(request): no WebSocket: a socket cannot come back across the signing call",
    );
  const method = input.method.toUpperCase();
  const request = new Request(url.href, {
    method: input.method,
    headers: input.headers,
    body: method === "GET" || method === "HEAD" ? null : input.body,
    redirect: "manual",
    // Node (undici) needs it for a streamed body; RequestInit does not declare it
    duplex: "half",
  } as RequestInit);
  // `invokeAs` answers unknown: the built-in fetch, or the rule's target, answers a Response.
  return (await context.invokeAs(context.caller(), [
    "itx",
    ["fetch", request, { signFor: peer }],
  ])) as Response;
}
