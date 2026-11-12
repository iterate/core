// sign-ins-page.ts — /sign-ins: A PERSON WHO IS NO MEMBER SEES AND ENDS THEIR OWN SIGN-INS. An
// app of a mind may have users of its own: a person signs in to it with an address, and is no
// member of the mind. /keys is a member's page, so such a person has this one: the apps of the
// mind that hold a sign-in as them, by client (./oauth.ts `sessionsByClientOf`), each with the
// button that ends it (`endAccess`), and nothing else: no key, no member, nobody else's sign-in.
// A member's own list is a part of /keys.
import { AccountFacts } from "./account-facts.ts";
import { clientsWithAccess, endFields, endsOf, logoOriginsOf } from "./access-list.ts";
import { sessionOf } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { standingOf } from "./members.ts";
import { endAccess, sessionsByClientOf } from "./oauth.ts";
import { errorPage, otherAccountForm, page, text } from "./pages.ts";
import { signInHref } from "./sign-in.ts";

const SIGN_INS_PATH = "/sign-ins";
const KEYS_ACCESS = "/keys#access";

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

export async function signInsResponse(env: Env, request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== SIGN_INS_PATH) return null;
  const post = request.method === "POST";
  if (!post && request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  const session = await sessionOf(env, request);
  if (!session)
    return post
      ? errorPage("You are signed out. Sign in and try again.", 401)
      : seeOther(signInHref(env, SIGN_INS_PATH));
  const member = (await standingOf(env, session)) !== "not-member";
  if (post) {
    // the session's cookie ends a sign-in, so the form must come from this origin's own page
    if (request.headers.get("origin") !== issuerOf(env))
      return errorPage("Send this from its own page.", 403);
    const ends = endsOf(await request.formData().catch(() => null));
    const facts = new AccountFacts();
    if (ends) await endAccess(env, session.userId, ends, facts);
    return facts.on(seeOther(member ? KEYS_ACCESS : SIGN_INS_PATH));
  }
  if (member) return seeOther(KEYS_ACCESS);
  const { domain } = iterateConfigOf(env);
  const access = await sessionsByClientOf(env, session.userId);
  const list = clientsWithAccess(
    env,
    access,
    (ends, button) => `<form method="post" action="${SIGN_INS_PATH}" class="inline">
          ${endFields(ends)}
          <button type="submit" class="link">${button}</button>
        </form>`,
  );
  return page({
    title: `Your sign-ins at ${domain}`,
    wide: true,
    imageOrigin: logoOriginsOf(access),
    body: `<h1>Your sign-ins at ${text(domain)}</h1>
      <p>You are signed in as <strong>${text(session.email)}</strong>. Each app of ${text(domain)} that you signed in to holds a sign-in as you. End one here, and the app asks you to sign in again.</p>
      ${list ? `<ul class="access-list">${list}</ul>` : `<p class="muted">No app of ${text(domain)} holds a sign-in as you.</p>`}
      <div class="muted">This browser is also signed in here, at ${text(new URL(issuerOf(env)).host)}, which is what signs you in to an app without a new code. ${otherAccountForm(SIGN_INS_PATH, "Sign out here")}</div>`,
  });
}
