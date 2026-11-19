// config.ts — THE ONE INPUT of the stack (./stack.ts): what `iterate deploy` learned from
// the person and from Cloudflare. A JSON file, named in ITERATE_MIND_CONFIG. No field is optional
// for a reason of history, and no variable of the environment changes what it means.
import { readFileSync } from "node:fs";
import { z } from "zod";

const hostname = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a hostname");

export const MindConfig = z
  .strictObject({
    /** The mind's id: the SHA-256 of its signed genesis, 64 lowercase hex characters
     *  (iterate/mind-identity). `iterate deploy` signs the genesis before the deploy and posts it
     *  after: the stack does no identity cryptography. */
    mindId: z.string().regex(/^[0-9a-f]{64}$/, "a mind id: 64 lowercase hex characters"),
    /** Where the mind's control plane answers: its sign-in, its API and its MCP server. A zone of
     *  the mind, or one label under one. Every other hostname of the zones is the mind's own. */
    controlPlaneHostname: hostname,
    /** The mind's owners, each by email address: a member from the first deploy, who signs in
     *  with a code mailed to that address and then adds a passkey. An owner may remove another
     *  member's passkeys. Members added later are in the mind, not here. */
    ownerEmails: z.array(z.email().toLowerCase()).min(1),
    /** Where the mind Worker runs: in the stack, or elsewhere, connecting in through the
     *  boundary. */
    topology: z.enum(["full-cloudflare", "external-mind-connects-into-cloudflare-boundary"]),
    alchemy: z.strictObject({
      /** The Alchemy stage, and the middle of every resource's name: `iterate-<stageName>-auth`.
       *  `iterate deploy` infers it from the first zone. At most 32 characters: the state store's
       *  name, `iterate-<stageName>-state`, may have 54. */
      stageName: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lower case, digits and -, at most 32"),
    }),
    cloudflare: z.strictObject({
      accountId: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id: 32 hex characters"),
      /** The zones the mind takes, each whole: its sites, its mail. `sub.example.com` when that
       *  is a zone of its own. Nothing else may use them. */
      zones: z.array(hostname).min(1),
      /** An image in the account's registry that sandboxes start. Absent: Cloudflare's own small
       *  image. Only iterate's own mind sets it. */
      containerImage: z.string().min(1).optional(),
    }),
    /** A FORWARD BY THE STACK, beside the config's own `email` method (iterate/sdk), where a
     *  mind's config forwards. Absent: the config's `email` alone decides where a mail goes. `forwardTo`:
     *  each mail is also forwarded there as it arrived (a team's mailbox or group), before the
     *  config's `email` runs. The address must be a verified destination address of the
     *  account's Email Routing, which a person confirms once by the link Cloudflare mails to it. */
    mail: z.strictObject({ forwardTo: z.email() }).optional(),
  })
  // One label, because Cloudflare's certificate for a zone covers the zone and `*.<zone>` alone.
  .refine(
    ({ controlPlaneHostname, cloudflare }) =>
      cloudflare.zones.some(
        (zone) =>
          controlPlaneHostname === zone ||
          controlPlaneHostname.split(".").slice(1).join(".") === zone,
      ),
    {
      path: ["controlPlaneHostname"],
      error:
        "a zone of the mind, or one label under one: Cloudflare's certificate for a zone covers the zone and *.<zone> alone, so a deeper name would get a route and no certificate",
    },
  )
  .refine(
    ({ ownerEmails, cloudflare }) =>
      ownerEmails.every((email) =>
        cloudflare.zones.every((zone) => !`.${email.split("@")[1]}`.endsWith(`.${zone}`)),
      ),
    {
      path: ["ownerEmails"],
      error: "no address at a zone of the mind: the mind takes that mail",
    },
  )
  .refine(
    ({ mail, cloudflare }) =>
      !mail ||
      cloudflare.zones.every(
        (zone) => !`.${mail.forwardTo.split("@")[1]}`.toLowerCase().endsWith(`.${zone}`),
      ),
    {
      path: ["mail", "forwardTo"],
      error:
        "not an address at a zone of the mind: its mail comes to the mind, so the forward would come back",
    },
  );
export type MindConfig = z.infer<typeof MindConfig>;

/** The config of this deploy, from the JSON file that ITERATE_MIND_CONFIG names. */
export function loadMindConfig(): MindConfig {
  const file = process.env.ITERATE_MIND_CONFIG;
  if (!file)
    throw new Error("ITERATE_MIND_CONFIG names no file: the stack has one input, its config");
  return MindConfig.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Every name the stack gives a resource of the account. */
export const namesOf = ({ alchemy }: { alchemy: { stageName: string } }) => {
  const prefix = `iterate-${alchemy.stageName}`;
  return {
    state: `${prefix}-state`,
    auth: `${prefix}-auth`,
    authDb: `${prefix}-auth-db`,
    authKv: `${prefix}-auth-kv`,
    ownerEmailProof: `${prefix}-owner-email-proof`,
    secrets: `${prefix}-secrets`,
    cloudflareClient: `${prefix}-cloudflare`,
    realtimeSfu: `${prefix}-realtime-sfu`,
    turnKey: `${prefix}-turn`,
    mind: `${prefix}-mind`,
    mindKv: `${prefix}-mind-kv`,
    files: `${prefix}-files`,
    repos: `${prefix}-repos`,
    boundary: `${prefix}-boundary`,
    cloudflareEvents: `${prefix}-events`,
    telemetry: `${prefix}-telemetry`,
    telemetryBucket: `${prefix}-telemetry`,
    // Analytics Engine and Pipelines take no `-` in a name
    telemetryMetrics: `${prefix.replaceAll("-", "_")}_metrics`,
    telemetryTables: `${prefix.replaceAll("-", "_")}_telemetry`,
  };
};
