// access-list.ts — WHO HOLDS ACCESS AS A PERSON, DRAWN: the list of ./oauth.ts
// `sessionsByClientOf`, which says what the list is and which pages show it. Here a client has
// its mark and name and says where its access goes; a sign-in under it says what it reaches,
// since when, when it was last used and when it ends. Each sign-in has the button that ends it,
// and a client with several has one that ends them all.
//
// A CLIENT SAYS ITS OWN NAME AND LOGO (./client-mark.ts). So a client also says where the access
// went: that is the one thing here a client cannot claim for another.
import { mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { appTile } from "./asking-app.ts";
import { clientTile, shownLogoOf } from "./client-mark.ts";
import { type Env, iterateConfigOf } from "./env.ts";
import { type ClientWithAccess, mindHostResourceOf, type SignIn } from "./oauth.ts";

const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The name a person reads for a client. */
const nameOf = (client: ClientWithAccess) => client.name || "An app";

/** The icon of one of the mind's own apps: its client's logo, which counts from the app's own
 *  origin alone. */
const ownIconOf = (client: ClientWithAccess) =>
  client.host &&
  URL.canParse(client.logoUri || "") &&
  new URL(client.logoUri!).origin === client.host
    ? client.logoUri!
    : null;

/** The client's mark. One of the mind's own apps has its own icon or its initials, as on the
 *  sign-in pages (./asking-app.ts), and never a built-in brand mark. Any other client has the
 *  mark of ./client-mark.ts. */
const tileOf = (client: ClientWithAccess) =>
  client.host
    ? appTile({ name: nameOf(client), icon: ownIconOf(client) }, { small: true })
    : otherTile(client);

const otherTile = (client: ClientWithAccess) =>
  clientTile(
    {
      name: nameOf(client),
      redirectUri: client.redirectUri || "",
      redirectHost: client.goesTo || "",
      logoUri: client.logoUri,
      clientDomain: client.clientDomain,
    },
    { small: true },
  );

/** What a client is and where its access goes, in words. */
function clientInWords(client: ClientWithAccess): string {
  if (client.host)
    return "one of this mind's own pages: a browser that opened it holds the sign-in";
  if (client.device) return "a device or a CLI, signed in by a code";
  return client.goesTo ? `access went to ${client.goesTo}` : "an app";
}

/** What a sign-in reaches, in words: the resource its tokens are for. */
function reachOf(env: Env, signIn: SignIn): string {
  const { domain } = iterateConfigOf(env);
  const { resource } = signIn;
  if (!resource) return "the mind or one of its pages";
  if (resource === mindMcpUrlOf(domain)) return "the mind's MCP server";
  if (resource === mindProvideUrlOf(domain))
    return "the mind's /provide link, as the computer that runs the mind";
  const host = mindHostResourceOf(env, resource);
  if (!host) return `the mind, through ${new URL(resource).pathname}`;
  const { pathname } = new URL(resource);
  return pathname.length > 1 ? `${new URL(host).host}${pathname}` : new URL(host).host;
}

const SCOPES: Record<string, string> = {
  iterate: "everything in this mind, as the member",
  identity: "who the person is, and no more",
};

/** When a sign-in was made, when it was last used, and when it ends. */
function timesOf(signIn: SignIn): string {
  const since = `since ${day(signIn.createdAt * 1000)}`;
  if (signIn.until)
    return `${since}, let in until ${new Date(signIn.until).toISOString().slice(0, 16).replace("T", " ")} UTC: it cannot renew this`;
  if (!signIn.endsAt) return since;
  const ends = day(signIn.endsAt * 1000);
  if (!signIn.renews) return `${since}, ends ${ends}`;
  const used = signIn.renewedAt ? `last used ${day(signIn.renewedAt * 1000)}, ` : "";
  return `${since}, ${used}renews by use: it ends ${ends} if it is not used`;
}

/** A form's hidden fields that name what its button ends: one sign-in, or all of one client. */
export type Ends = { signIn: string } | { client: string };

/** The list. `end` makes the form that ends a sign-in or all of a client, with that word on its
 *  button; `whose` names the person on an owner's page. */
export function clientsWithAccess(
  env: Env,
  clients: ClientWithAccess[],
  end: (ends: Ends, button: string) => string,
  whose?: string,
): string {
  const word = (client: ClientWithAccess) => (client.host ? "Sign out" : "Revoke");
  const signInItem = (client: ClientWithAccess, signIn: SignIn) => {
    const scopes = signIn.scopes.map((scope) => SCOPES[scope] || scope).join("; ");
    return `<li data-access="${text(signIn.id)}">
          <span class="muted">Reaches ${text(reachOf(env, signIn))}${scopes ? `: ${text(scopes)}` : ""}, ${text(timesOf(signIn))}.</span>
          ${end({ signIn: signIn.id }, word(client))}
        </li>`;
  };
  return clients
    .map(
      (client) => `<li class="access" data-client="${text(client.clientId)}">
      ${tileOf(client)}
      <div>
        <p><strong>${text(nameOf(client))}</strong>${whose ? ` <span class="muted">of ${text(whose)}</span>` : ""}</p>
        <p class="muted">${text(clientInWords(client))}.</p>
        <ul class="access-sessions">${client.signIns.map((signIn) => signInItem(client, signIn)).join("")}</ul>
      </div>
      ${client.signIns.length > 1 ? end({ client: client.clientId }, `${word(client)} all ${client.signIns.length}`) : ""}
    </li>`,
    )
    .join("");
}

/** The origins that the list's pictures come from, for the page's `img-src`: each is a verified
 *  client's own logo on its own domain, or the icon of one of the mind's own apps on its own host. */
export function logoOriginsOf(clients: ClientWithAccess[]): string | undefined {
  const origins = new Set(
    clients.flatMap((client) => {
      if (client.host) return ownIconOf(client) ? [client.host] : [];
      const logo = shownLogoOf(client);
      return logo ? [logo.origin] : [];
    }),
  );
  return origins.size ? [...origins].join(" ") : undefined;
}

/** What a posted form names to end, or null when it names nothing. */
export function endsOf(form: FormData | null): Ends | null {
  const [signIn, client] = [form?.get("signIn"), form?.get("client")];
  if (typeof signIn === "string" && signIn) return { signIn };
  return typeof client === "string" && client ? { client } : null;
}

/** The hidden fields of a form that ends `ends`. */
export const endFields = (ends: Ends) =>
  "signIn" in ends
    ? `<input type="hidden" name="signIn" value="${text(ends.signIn)}">`
    : `<input type="hidden" name="client" value="${text(ends.client)}">`;
