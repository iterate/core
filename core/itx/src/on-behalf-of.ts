// Attribution, not authority: the code still calls as loaded code. Signed because anyone can
// write a cause, and a name is worth forging; `purpose` keeps it apart from the secret's other tokens.
import type { Principal } from "iterate/principal";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { z } from "zod";
import { signClaims, verifyClaims } from "./caller.ts";

// `run` names a script's request (`<path>@<offset>`), `call` a person's own call into a facet
// (`<path>#<facet>.<method>`): one of the two. `via` is the caller's (caller.ts).
export type OnBehalfOf = {
  principal: Principal;
  grant?: string;
  via?: { appPage: string };
  run?: string;
  call?: string;
};

const Claims = z.object({
  purpose: z.literal("on-behalf-of"),
  onBehalfOf: z.object({
    principal: z.object({
      actor: z.string(),
      email: z.string().optional(),
      impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
    }),
    grant: z.string().optional(),
    via: z.object({ appPage: z.string() }).optional(),
    run: z.string().optional(),
    call: z.string().optional(),
  }),
  expiresAt: z.number(),
});

export function mintOnBehalfOf(
  onBehalfOf: OnBehalfOf,
  secret: string,
  now: number,
): Promise<string> {
  const expiresAt = now + RUN_DEADLINE_MS + 60_000;
  return signClaims({ purpose: "on-behalf-of", onBehalfOf, expiresAt }, secret);
}

export async function verifyOnBehalfOf(
  token: string | undefined,
  secret: string,
  now: number,
): Promise<OnBehalfOf | undefined> {
  if (!token) return undefined;
  const claims = Claims.safeParse(await verifyClaims(token, secret));
  if (!claims.success || claims.data.expiresAt < now) return undefined;
  return claims.data.onBehalfOf;
}
