import { z } from "zod";
import { normalizedItxExpression, type ItxExpression } from "iterate/expression";
import { ITERATE_ROUTING_SLUG_HEADER, ROUTING_SLUG } from "iterate/mind-ingress";

const FetchRouteName = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "a fetch route name is a DNS label: lowercase letters, digits and inner hyphens, at most 63",
  );

const UrlPatternInit = z
  .strictObject({
    protocol: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    hostname: z.string().optional(),
    port: z.string().optional(),
    pathname: z.string().optional(),
    search: z.string().optional(),
    hash: z.string().optional(),
    baseURL: z.string().optional(),
  })
  .refine(
    (init) => {
      try {
        new URLPattern(init);
        return true;
      } catch {
        return false;
      }
    },
    { message: "url is not a URLPattern" },
  );

// The routing slug is absent on the apex, so a route naming one never takes the apex.
const FetchRouteRequestMatcher = z.strictObject({
  routingSlug: z
    .string()
    .max(63)
    .regex(
      ROUTING_SLUG,
      "a routing slug is a DNS label starting with a letter: lowercase letters, digits and single hyphens, at most 63",
    )
    .optional(),
  url: UrlPatternInit.optional(),
  headers: z.record(z.string().min(1), z.string()).optional(),
});
type FetchRouteRequestMatcher = z.infer<typeof FetchRouteRequestMatcher>;

const FetchRouteAuthRequirement = z.strictObject({
  visitors: z.literal("mind-members"),
});

const FetchRouteTarget = z
  .custom<ItxExpression>(
    (value) => {
      try {
        normalizedItxExpression(value as ItxExpression);
        return Array.isArray(value);
      } catch {
        return false;
      }
    },
    { message: "target is an itx expression (the array half)" },
  )
  .refine(
    (target) => target.every((step) => (Array.isArray(step) ? step[0] : step) !== "builtins"),
    { message: "target has no builtins step: it runs as the config worker's call" },
  )
  .refine((target) => /^[\x20-\x7e]*$/.test(JSON.stringify(target)), {
    message: "target is ASCII: it travels in the x-itx-expression header",
  })
  .refine(
    (target) => {
      const lastStep = target.at(-1);
      return !Array.isArray(lastStep) || lastStep[0] !== "fetch" || lastStep.length === 1;
    },
    { message: "target's fetch takes no args: the request is its one" },
  );

// Also checked at the append boundary (stream/core-processor.ts `normalizeControlEvent`).
export const FetchRouteConfiguredPayload = z
  .strictObject({
    fetchRouteName: FetchRouteName,
    requestMatcher: FetchRouteRequestMatcher.nullable(),
    target: FetchRouteTarget.optional(),
    authRequirement: FetchRouteAuthRequirement.nullable().optional(),
    priority: z.number().int().optional(),
  })
  .refine((payload) => !payload.requestMatcher || Boolean(payload.target), {
    message: "a route with a requestMatcher names its target",
  });

export type FetchRouteTable = Record<
  string,
  {
    requestMatcher: FetchRouteRequestMatcher;
    target: ItxExpression;
    authRequirement: z.infer<typeof FetchRouteAuthRequirement> | null;
    priority: number;
    configuredOffset: number;
  }
>;

export type FetchRoute = FetchRouteTable[string] & { fetchRouteName: string };

// `writable` is the core reduce's draft, so a page of facts copies the table once: a copy per fact
// is O(routes²), a reboot loop against the CPU limit. A malformed payload is skipped, never thrown.
export function reduceFetchRouteConfigured(
  table: FetchRouteTable,
  event: { offset: number; payload?: unknown },
  writable: (table: FetchRouteTable) => FetchRouteTable = (table) => ({ ...table }),
): FetchRouteTable | undefined {
  const parsed = FetchRouteConfiguredPayload.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const { fetchRouteName, requestMatcher, target, authRequirement, priority } = parsed.data;
  if (!requestMatcher && !Object.hasOwn(table, fetchRouteName)) return undefined;
  const next = writable(table);
  // A DNS label is never `__proto__`: an assignment makes an own key, `constructor` included.
  if (!requestMatcher) delete next[fetchRouteName];
  else
    next[fetchRouteName] = {
      requestMatcher,
      target: target!,
      authRequirement: authRequirement || null,
      priority: priority || 0,
      configuredOffset: event.offset,
    };
  return next;
}

export function matchFetchRoute(
  table: FetchRouteTable,
  request: { url: string; headers: Headers },
): FetchRoute | null {
  const ordered = Object.entries(table).sort(
    ([nameA, routeA], [nameB, routeB]) =>
      routeB.priority - routeA.priority || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );
  for (const [fetchRouteName, route] of ordered)
    if (requestMatcherHolds(route.requestMatcher, request)) return { fetchRouteName, ...route };
  return null;
}

function requestMatcherHolds(
  requestMatcher: FetchRouteRequestMatcher,
  request: { url: string; headers: Headers },
): boolean {
  const { routingSlug, url, headers } = requestMatcher;
  if (routingSlug && request.headers.get(ITERATE_ROUTING_SLUG_HEADER) !== routingSlug) return false;
  if (url && !new URLPattern(url).test(request.url)) return false;
  for (const [name, value] of Object.entries(headers || {}))
    if (request.headers.get(name) !== value) return false;
  return true;
}
