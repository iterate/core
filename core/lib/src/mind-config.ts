// mind-config.ts — THE CONFIG THAT EVERY WORKER OF A MIND GETS (`iterate/mind-config`). The stack
// (core/alchemy) writes the same object to the auth, secrets, mind and boundary Workers as the
// variable `ITERATE`: the mind's id, where its control plane answers, which zones are its own,
// who owns it, and where its mind Worker runs. The four have the same trust level, so they share one shape. Each Worker's own key
// comes beside it as a secret variable, `ITERATE__<NAME>`, and is a `redacted` field of that
// Worker's schema (./app-config.ts). A binding to a resource is never config.
import { z } from "zod";
import { parseAppConfigVars } from "./app-config.ts";

/** A DNS hostname, lowercased: at least two labels, and no scheme, port, path or trailing dot. */
export const Hostname = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a hostname");

/** WHETHER A ZONE'S CERTIFICATE COVERS THE CONTROL-PLANE HOSTNAME: the hostname is the apex of one of
 *  `zones`, or exactly one label under one. Cloudflare's certificate for a zone covers the zone
 *  and `*.zone` alone, so a browser gets no TLS answer at a name two labels deep
 *  (https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/). The
 *  deploy's config asks this same function before it deploys anything. */
export const zoneCoversControlPlaneHostname = (config: {
  controlPlaneHostname: string;
  zones: readonly string[];
}) =>
  config.zones.some(
    (zone) =>
      config.controlPlaneHostname === zone ||
      (config.controlPlaneHostname.endsWith(`.${zone}`) &&
        !config.controlPlaneHostname.slice(0, -zone.length - 1).includes(".")),
  );

/** AN OWNER EMAIL PATTERN: `*@<domain>`, and nothing else. It names every address whose domain
 *  is exactly that one: no sub-domain, no star in the domain, no part of a local part. Lower-case
 *  ASCII as written, so the config says exactly who it admits; a pattern in any other spelling is
 *  refused, never read loosely. */
export const OwnerEmailPattern = z
  .string()
  .regex(
    /^\*@(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "an owner email pattern: *@<domain>, in lower case",
  );

/** The domain that an owner email pattern names. */
export const domainOfOwnerEmailPattern = (pattern: string) => pattern.slice(2);

export const MindConfig = z
  .object({
    /** The mind's id: the SHA-256 of its signed genesis, 64 lowercase hex characters
     *  (./mind-identity.ts). It stays when the hostname, the account or a key changes. The genesis
     *  itself is not config: it is posted to the control plane after the deploy. */
    mindId: z.string().regex(/^[0-9a-f]{64}$/, "a mind id: 64 lowercase hex characters"),
    /** The one hostname where the mind's sign-in, its API and its MCP server answer. Nothing
     *  computes it from a zone: it is any name that a zone's certificate covers
     *  (`zoneCoversControlPlaneHostname`). */
    controlPlaneHostname: Hostname,
    /** The zones the mind takes, each whole: every hostname of each is the mind's own, and so is
     *  its mail. */
    zones: z.array(Hostname).min(1),
    /** The mind's owners, each by email address: a member from the first deploy. */
    ownerEmails: z.array(z.email().toLowerCase()).min(1),
    /** More owners, by pattern: each `*@<domain>` makes every address at exactly that domain an
     *  owner (`isOwnerEmail`). Absent or empty: the owners are `ownerEmails` alone. Only a
     *  deploy sets it, as it sets the owners. */
    ownerEmailPatterns: z.array(OwnerEmailPattern).optional(),
    /** Where the mind Worker runs: in the stack, or elsewhere, connecting in through the
     *  boundary. */
    topology: z.enum(["full-cloudflare", "external-mind-connects-into-cloudflare-boundary"]),
  })
  .refine(zoneCoversControlPlaneHostname, {
    path: ["controlPlaneHostname"],
    message:
      "the apex of one of zones, or one label under one: a zone's certificate covers no deeper name",
  });
export type MindConfig = z.infer<typeof MindConfig>;

// A Worker's `env` is one object for the life of its isolate, and its `own` shape is one object of
// its module, so the two key the parsed config: it is parsed at an isolate's first use of it, and a
// malformed one throws there, naming its field.
const parsed = new WeakMap<object, WeakMap<object, unknown>>();

/** A Worker's config out of its `env`: the shared fields, and `own`, that Worker's own fields
 *  (its key, as `redacted(z.string().min(1))`). Parsed once for each `env` and `own`. Throws naming
 *  the field that is wrong. */
export function mindConfigOf<Own extends z.ZodRawShape>(env: object, own: Own) {
  const byOwn = parsed.get(env) ?? new WeakMap<object, unknown>();
  parsed.set(env, byOwn);
  // `safeExtend`: zod's `extend` refuses a schema that has a refinement.
  const schema = MindConfig.safeExtend(own);
  if (!byOwn.has(own)) byOwn.set(own, parseAppConfigVars(env, schema, { prefix: "ITERATE" }));
  // The cast: the map holds, under `own`, what this function parsed with that schema, whose
  // output is the shared fields and `own`'s (`safeExtend`'s own type names neither for a generic
  // shape).
  return byOwn.get(own) as MindConfig & z.output<z.ZodObject<Own>>;
}

/** THE ONE RULE BY WHICH A HOSTNAME IS COMPARED with the config's: lowercased, and with one
 *  trailing dot dropped, since `example.com.` is the same DNS name as `example.com`. A request
 *  with such a dot never gets this far: the boundary refuses it (421). */
const comparable = (hostname: string) => hostname.toLowerCase().replace(/\.$/, "");

/** Whether `hostname` is the mind's control-plane hostname, where the control plane answers. The boundary
 *  and the mind Worker both decide by it. */
export const isControlPlaneHostname = (
  config: Pick<MindConfig, "controlPlaneHostname">,
  hostname: string,
) => comparable(hostname) === config.controlPlaneHostname;

/** The zone of the mind that `hostname` is in (the zone itself or a name under it), or null: a
 *  hostname that is not the mind's. The longest zone wins, so `sub.example.com` as a zone of its
 *  own takes its names before `example.com` does. */
export function zoneOf(config: Pick<MindConfig, "zones">, hostname: string): string | null {
  const name = comparable(hostname);
  return (
    config.zones
      .filter((zone) => name === zone || name.endsWith(`.${zone}`))
      .toSorted((a, b) => b.length - a.length)[0] ?? null
  );
}

/** The zone of the mind that the mail address `address` is at, or null: an address that is not
 *  the mind's, or no address. Mail comes in for every zone, and goes out from an address at any
 *  zone. */
export function zoneOfMailAddress(config: Pick<MindConfig, "zones">, address: string) {
  const at = address.lastIndexOf("@");
  return at > 0 ? zoneOf(config, address.slice(at + 1).toLowerCase()) : null;
}

/** WHO IS AN OWNER: an address that `ownerEmails` names, or one that an owner email pattern
 *  names. A pattern names an address that has one "@", a local part with no space and no
 *  control character, and after the "@" exactly the pattern's domain, in any letter case: so
 *  `ada@sub.example.org`, `ada@example.org.evil.example` and `ada@evil.example@example.org` are
 *  not at `*@example.org`. The one rule for the auth Worker and for the recovery command. */
export function isOwnerEmail(
  config: Pick<MindConfig, "ownerEmails" | "ownerEmailPatterns">,
  email: string,
) {
  const address = email.trim().toLowerCase();
  if (config.ownerEmails.includes(address)) return true;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || !/^[!-~]+$/.test(address)) return false;
  const domain = address.slice(at + 1);
  return (config.ownerEmailPatterns || []).some(
    (pattern) => domainOfOwnerEmailPattern(pattern) === domain,
  );
}

/** `https://<controlPlaneHostname>`: the issuer, and the origin of the API and the MCP server. */
export const controlPlaneOriginOf = (config: Pick<MindConfig, "controlPlaneHostname">) =>
  `https://${config.controlPlaneHostname}`;
