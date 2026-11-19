// Attribution, not authority: the code still calls as loaded code. Signed because anyone can
// write a cause, and a name is worth forging; `purpose` keeps it apart from the secret's other tokens.
import type { Principal } from "iterate/principal";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { z } from "zod";
import { signClaims, verifyClaims, type Caller } from "./caller.ts";

// `run` names a script's request (`<path>@<offset>`), `call` a person's own call into a facet
// (`<path>#<facet>.<method>`): one of the two on a call made for someone. A holder's stamp has
// neither: it names who holds a lent callback, not a call (person-context.ts). `via` is the
// caller's (caller.ts).
export type OnBehalfOf = {
  principal: Principal;
  grant?: string;
  via?: { appPage: string };
  run?: string;
  call?: string;
  // A member of the mind asks. Only on a Caller, where kernel code sets it for a person's view,
  // and on what `askerOf` answers: a token and a stamp have no such field (`OnBehalfOfStamp`).
  member?: true;
};

const PrincipalStamp = z.object({
  actor: z.string(),
  email: z.string().optional(),
  // a person's name to show, and that they are a guest (iterate/principal `Principal.name`,
  // `kind`): neither decides anything
  name: z.string().optional(),
  kind: z.literal("guest").optional().catch(undefined),
  impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
});

export const OnBehalfOfStamp = z.object({
  principal: PrincipalStamp,
  grant: z.string().optional(),
  via: z.object({ appPage: z.string() }).optional(),
  run: z.string().optional(),
  call: z.string().optional(),
});

const Claims = z.object({
  purpose: z.literal("on-behalf-of"),
  onBehalfOf: OnBehalfOfStamp,
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

/** WHO ASKED FOR A CALL, AS THE KERNEL ITSELF KNOWS THEM: a member's own session, or a person's
 *  one-context view (person-context.ts names the person on the Caller of a person method's call).
 *  Read from the Caller, which only the kernel's own code sets (caller.ts), and never from the
 *  cause: loaded code hands its cause back, and the token on it could be one that it kept from
 *  another call. So a call that came through loaded code (a script, a worker, a facet) names
 *  nobody here, whatever its cause says. `call` is `<path>#<facet>.<method>`.
 *
 *  `member` says that a member of the mind asks: in their own session, or through a person's
 *  view, where the view says so from the boundary's stamp. A key's session names the service that
 *  the key speaks for, which is no member (core/mind-worker rpc.ts). A guest and a person who
 *  proved an address and is no member have no mark, and no other field tells the two from a
 *  member. */
export function askerOf(caller: Caller, call: string): OnBehalfOf | undefined {
  const { principal, grant, via, onBehalfOf } = caller;
  if (principal)
    return { principal, grant, via, call, ...(!grant?.startsWith("key:") && { member: true }) };
  if (!onBehalfOf) return undefined;
  const { principal: person, via: page, member } = onBehalfOf;
  return { principal: person, via: page, call, member };
}
