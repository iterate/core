import { reportIssue } from "./lib.ts";
import type { StreamEventInput } from "./stream/processor.ts";

/** Only a trusted Worker sets it: egress and the home lab's link drop any other answer's copy
 *  (`withFacts(response, [])`) before anyone could believe it. */
export const FACTS_HEADER = "x-iterate-facts";

export type Facts = { path: string; events: StreamEventInput[] }[];

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

/** Never rejects: an append that fails is reported, and the act it records stands. */
export function recordFacts(
  response: Response,
  append: (path: string, events: StreamEventInput[]) => Promise<unknown>,
): { answer: Response; recorded: Promise<void> } {
  const header = response.headers.get(FACTS_HEADER);
  if (!header) return { answer: response, recorded: Promise.resolve() };
  const recorded = Promise.all(
    decodeFacts(header).map(({ path, events }) =>
      append(path, events).catch((error: unknown) =>
        reportIssue("facts.not-recorded", error, { path }),
      ),
    ),
  ).then(() => {});
  return { answer: withFacts(response, []), recorded };
}
