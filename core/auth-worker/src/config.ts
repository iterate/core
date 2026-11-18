// config.ts — WHAT THE AUTH WORKER IS TOLD: the config that every Worker of the mind gets
// (iterate/mind-config), and its own key. Its owners are `ownerEmails`, the resources it issues
// tokens for follow from the control-plane hostname and the topology, and every hostname of every zone
// is the mind's own. Pure: ./env.ts reads it out of the Worker's variables.
import { fieldNameOf, redacted } from "iterate/app-config";
import { mindApiUrlOf, mindMcpUrlOf, mindProvideConnectResourceOf } from "iterate/mind-api";
import { Hostname, type MindConfig, mindConfigOf, zoneOfMailAddress } from "iterate/mind-config";
import { z } from "zod";

const ownFields = {
  signingKey: redacted(z.string().min(1)),
  /** The domain of the account's Zero Trust team, `<name>.cloudflareaccess.com`: the issuer of
   *  the tokens that prove an owner's address (./access-sign-in.ts), where its keys are read. */
  cloudflareAccessTeamDomain: Hostname,
  /** The audience tag of the stack's one Access application, on the control plane's
   *  `/sign-in/access`: a token of the team for any other application proves nothing here. */
  cloudflareAccessAudienceTag: z.string().min(1),
};

/** The Worker's config out of its variables: `ITERATE`, with the two facts of Cloudflare Access
 *  that are this Worker's own, and the secret `ITERATE__SIGNING_KEY`, which signs the session
 *  cookies (./cookies.ts) and a key's tokens (./key-tokens.ts). Throws
 *  naming the field that is wrong. An owner's address at a zone of the mind is refused: the mind
 *  receives that address's mail, so the mind's code, which may be hostile, could sign in as that
 *  owner. */
export function authConfigOf(env: object) {
  const config = mindConfigOf(env, ownFields);
  const own = config.ownerEmails.find((email) => atMindsZone(config, email));
  if (own)
    throw new Error(
      `${fieldNameOf(["ownerEmails"], { prefix: "ITERATE" })}: ${own} is at a zone of the mind, which receives that address's mail, so the mind could sign in as that owner`,
    );
  return config;
}

/** Whether `email` is at a zone of the mind or under one. Every mailbox there is the mind's,
 *  whose code may be hostile: the mind receives the sign-in code mailed to that address. */
export const atMindsZone = (config: Pick<MindConfig, "zones">, email: string) =>
  zoneOfMailAddress(config, email.trim()) !== null;

/** An owner is a member the config names: the people a deploy lets in, so the only ones who let
 *  another member in again. */
export const isOwner = (config: Pick<MindConfig, "ownerEmails">, email: string) =>
  config.ownerEmails.includes(email.trim().toLowerCase());

/** THE AUDIENCES OF THE TOKENS THIS WORKER ISSUES TO MEMBERS (RFC 8707 resources), each a
 *  canonical URI: the mind's API and its MCP server, and the address an external mind connects in
 *  at, when the mind runs outside the stack. Besides them, any hostname of the mind is an audience
 *  for anyone signed in (./oauth.ts `mindHostResourceOf`). A request for any other is refused. */
export const tokenAudiencesOf = (config: Pick<MindConfig, "controlPlaneHostname" | "topology">) => [
  mindApiUrlOf(config.controlPlaneHostname),
  mindMcpUrlOf(config.controlPlaneHostname),
  ...(config.topology === "external-mind-connects-into-cloudflare-boundary"
    ? [mindProvideConnectResourceOf(config.controlPlaneHostname)]
    : []),
];
