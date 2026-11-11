import { reportIssue } from "./lib.ts";
import type { StreamEventInput } from "./stream/processor.ts";

/** Only a trusted Worker sets it: egress and the home lab's link drop any other answer's copy
 *  (`withFacts(response, [])`) before anyone could believe it. */
export const FACTS_HEADER = "x-iterate-facts";

/** `storeFirst`: the events are the act itself and not the record of one, as a signed statement's
 *  event is. Whoever appends them answers only once they are stored (`recordFacts`). */
export type Facts = { path: string; events: StreamEventInput[]; storeFirst?: true }[];

export function encodeFacts(facts: Facts): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(facts)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeFacts(header: string): Facts {
  try {
    const binary = atob(header.replaceAll("-", "+").replaceAll("_", "/"));
    const facts: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))),
    );
    const isFact = (fact: unknown) =>
      typeof fact === "object" &&
      !!fact &&
      "path" in fact &&
      typeof fact.path === "string" &&
      fact.path.startsWith("/") &&
      "events" in fact &&
      Array.isArray(fact.events);
    if (Array.isArray(facts) && facts.every(isFact)) return facts as Facts;
    throw new Error("not a list of { path, events }");
  } catch (error) {
    reportIssue("facts.unreadable", error);
    return [];
  }
}

export function withFacts(response: Response, facts: Facts): Response {
  if (!facts.length && !response.headers.has(FACTS_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(FACTS_HEADER);
  if (facts.length) headers.set(FACTS_HEADER, encodeFacts(facts));
  if (response.webSocket)
    return new Response(null, { status: 101, webSocket: response.webSocket, headers });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Never rejects: an append that fails is reported. A fact records an act that stands, so `answer`
 *  goes on at once. A `storeFirst` fact is the act: `answer` waits for it, and is a 503 when it was
 *  not stored, so the sender sends the same request again. */
export function recordFacts(
  response: Response,
  append: (path: string, events: StreamEventInput[]) => Promise<unknown>,
): { answer: Response | Promise<Response>; recorded: Promise<void> } {
  const header = response.headers.get(FACTS_HEADER);
  if (!header) return { answer: response, recorded: Promise.resolve() };
  const facts = decodeFacts(header);
  const stored = facts.map(({ path, events, storeFirst }) =>
    append(path, events).then(
      () => true,
      (error: unknown) => {
        reportIssue(storeFirst ? "facts.not-stored" : "facts.not-recorded", error, { path });
        return !storeFirst;
      },
    ),
  );
  const answer = withFacts(response, []);
  const all = Promise.all(stored);
  return {
    answer: facts.some((fact) => fact.storeFirst)
      ? all.then((kept) => (kept.every(Boolean) ? answer : notStored(answer)))
      : answer,
    recorded: all.then(() => {}),
  };
}

function notStored(answer: Response): Response {
  void answer.body?.cancel();
  return Response.json(
    { refused: "this was not stored: send the same request again" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
