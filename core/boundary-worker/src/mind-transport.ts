// mind-transport.ts — HOW THE BOUNDARY REACHES THE MIND, by the config's `topology`. The boundary
// is one build for both: its request policy (./http.ts) and its mail handlers call a
// `MindTransport`, and this file answers the one that the deploy made bindings for.
//
//   full-cloudflare                                    the mind Worker's `Mind` entrypoint, `MIND`
//   external-mind-connects-into-cloudflare-boundary    the Durable Object `ProvidedMind`
//                                                      (./provided-mind.ts), `PROVIDED_MIND`
import type { MindConfig } from "iterate/mind-config";
import { boundaryConfigOf } from "./config.ts";
import type { Env } from "./env.ts";
import type { MindTransport } from "./http.ts";
import { PROVIDED_MIND_DIAL_HEADER } from "./provided-mind.ts";

export function mindTransportOf(env: Env): MindTransport {
  const { topology } = boundaryConfigOf(env);
  if (topology === "full-cloudflare") {
    const mind = bindingOf(env.MIND, "MIND", topology);
    return {
      fetch: (request) => mind.fetch(request),
      append: (path, events, fromAuth) => mind.append(path, events, fromAuth),
      runAct: (held) => mind.runAct(held),
      receiveEmail: (mail) => mind.receiveEmail(mail),
      emailForwardRequest: (wait) => mind.emailForwardRequest(wait),
      emailForwardClaim: (claim) => mind.emailForwardClaim(claim),
      api: (who) => mind.api(who),
    };
  }
  // one instance: a boundary has one mind
  const provided = bindingOf(env.PROVIDED_MIND, "PROVIDED_MIND", topology).getByName("mind");
  return {
    fetch: (request) => provided.fetch(markedRequest(request, false)),
    append: (path, events, fromAuth) => provided.append(path, events, fromAuth),
    runAct: (held) => provided.runAct(held),
    receiveEmail: (mail) => provided.receiveEmail(mail),
    emailForwardRequest: (wait) => provided.emailForwardRequest(wait),
    emailForwardClaim: (claim) => provided.emailForwardClaim(claim),
    api: (who) => provided.api(who),
    link: (dial) => provided.fetch(markedRequest(dial, true)),
    appendOrKeep: (path, fact) => provided.appendOrKeep(path, fact),
  };
}

/** A deploy gives the boundary the one binding of its topology (core/alchemy). A missing one is a
 *  broken deploy, and no request can be answered without it. */
function bindingOf<Binding>(
  binding: Binding | undefined,
  name: string,
  topology: MindConfig["topology"],
) {
  if (!binding) throw new Error(`the boundary of a ${topology} stack has no ${name} binding`);
  return binding;
}

/** `request` for `ProvidedMind`, with the mark that says a dial (./provided-mind.ts
 *  `PROVIDED_MIND_DIAL_HEADER`): set for the dial alone, and removed from everything else,
 *  whatever sent it. A dial keeps what it carried but a caller's stamps, which only the boundary
 *  writes: the object reads the dial's credential as the boundary reads any session's. */
function markedRequest(request: Request, dial: boolean) {
  const headers = new Headers(
    dial ? [...request.headers].filter(([name]) => !name.startsWith("x-itx-")) : request.headers,
  );
  if (dial) headers.set(PROVIDED_MIND_DIAL_HEADER, "1");
  else headers.delete(PROVIDED_MIND_DIAL_HEADER);
  return new Request(request, { headers });
}
