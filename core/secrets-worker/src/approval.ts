import type { VaultAnswerKind } from "iterate/secret-placeholder";
import { z } from "zod";

export const ApprovalRule = z
  .object({
    methods: z
      .array(z.string().regex(/^[A-Za-z]+$/, "a method is a word, such as POST"))
      .min(1, "name the methods that wait"),
    hosts: z
      .array(
        z.string().regex(/^[A-Za-z0-9.-]+$/, "a host is a hostname, such as gmail.googleapis.com"),
      )
      .min(1, "name the hosts that wait"),
  })
  .strict()
  .transform(({ methods, hosts }) => ({
    methods: [...new Set(methods.map((method) => method.toUpperCase()))].sort(),
    hosts: [...new Set(hosts.map((host) => host.toLowerCase()))].sort(),
  }));
export type ApprovalRule = z.infer<typeof ApprovalRule>;

export function ruleMatches(rule: ApprovalRule, method: string, url: string): boolean {
  return rule.methods.includes(method.toUpperCase()) && rule.hosts.includes(new URL(url).hostname);
}

export function isTightening(before: ApprovalRule | null, after: ApprovalRule | null): boolean {
  if (!after) return false;
  if (!before) return true;
  return (
    before.methods.every((method) => after.methods.includes(method)) &&
    before.hosts.every((host) => after.hosts.includes(host))
  );
}

export const HELD_BODY_LIMIT = 1024 * 1024;

// Headers that change between two tries of one request: left out of the text, and so not sent.
const HOP_HEADER = /^(?:cf-|x-iterate-|x-itx-)|^(?:traceparent|tracestate|content-length)$/;

// The placeholder of the secret stays in it.
export type HeldRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
};

export function requestText(request: {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}): string {
  const headers = [...request.headers]
    .filter(([name]) => !HOP_HEADER.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    method: request.method.toUpperCase(),
    url: request.url,
    headers,
    body: request.body,
  } satisfies HeldRequest);
}

export function requestOfText(text: string): Request {
  const held = JSON.parse(text) as HeldRequest;
  const bodyless = held.method === "GET" || held.method === "HEAD";
  return new Request(held.url, {
    method: held.method,
    headers: held.headers,
    ...(!bodyless && held.body && { body: held.body }),
  });
}

export class HeldAnswer extends Error {
  readonly status: number;
  readonly kind: VaultAnswerKind;
  constructor(status: number, kind: VaultAnswerKind, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}
