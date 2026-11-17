import { base64url, fromBase64url, keyIdOf, MIND_DOCUMENT_PATH } from "iterate/signed";
import { type AccountFact, AccountFacts } from "./account-facts.ts";
import {
  type BrowserSession,
  clearSessionCookie,
  endSessions,
  endThisSession,
  sessionCookie,
  sessionOf,
} from "./cookies.ts";
import { dashOriginOf, type Env, issuerOf, iterateConfigOf } from "./env.ts";
import {
  allowsExactly,
  CLOUD_ACTOR,
  cloudNameRefusal,
  enrolPayloadOf,
  honouredNext,
  type LendingKey,
  otherKeyLending,
  scopeInWords,
  scopePlainly,
  type ServiceKeyRequest,
  serviceKeyRequestOf,
  statementInParts,
  type StatementPart,
} from "./key-rules.ts";
import { holdsPasskey } from "./keys.ts";
import { standingOf } from "./members.ts";
import { errorPage, notMemberPage, page, text } from "./pages.ts";
import { SESSIONS_PATH } from "./sessions-page.ts";
import { signInHref } from "./sign-in.ts";
import {
  KEY_ADDED,
  KEY_REMOVED,
  signedChange,
  signedChangeBy,
  signerOf,
  signScript,
} from "./signed-change.ts";
import { mindDocumentResponse, STACK_KEY_PATH, stackKeyOf, stackKeyResponse } from "./stack-key.ts";

const KEYS_PATH = "/keys";
const KEYS_JSON_PATH = "/keys.json";
const REMOVE_PATH = "/keys/remove";
const ENROL_PATH = "/keys/enrol";

const CHALLENGE_SECONDS = 5 * 60;
const CHALLENGE_KEY_PREFIX = "iterate-key-challenge:";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export async function keysPagesResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const get = request.method === "GET" || request.method === "HEAD";
  const post = request.method === "POST";
  if (pathname === STACK_KEY_PATH && get) return stackKeyResponse(env);
  if (pathname === MIND_DOCUMENT_PATH && get) return mindDocumentResponse(env);
  const known =
    (pathname === KEYS_PATH && (get || post)) ||
    (pathname === KEYS_JSON_PATH && get) ||
    (pathname === REMOVE_PATH && post) ||
    (pathname === ENROL_PATH && (get || post));
  if (!known) return null;
  const issuer = issuerOf(env);
  const { domain, trustedClients } = iterateConfigOf(env);
  const session = await sessionOf(env, request);
  const standing = session ? await standingOf(env, session) : "not-member";
  if (pathname === KEYS_JSON_PATH) {
    if (!session) return json({ error: "signed out" }, 401);
    if (standing === "not-member") return json({ error: "not a member" }, 403);
    return keysJson(env, session);
  }
  if (post) {
    // the page's own form or script alone
    if (request.headers.get("origin") !== issuer)
      return json({ error: "use this site's own page" }, 403);
    if (!session) return json({ error: "sign in first" }, 401);
  }
  const signIn = `${issuer}${signInHref(pathname + url.search)}`;
  if (!session) return Response.redirect(signIn, 302);
  if (standing === "not-member")
    return post
      ? json({ error: "not a member" }, 403)
      : notMemberPage({ domain, email: session.email });
  const owed = standing === "passkey-owed";
  // Such a session adds a passkey, on /keys, and no more. An address proven by a code, or a
  // member's link, adds the first one alone: with a passkey held, the session is from before it,
  // and its holder signs in again. The owner's ticket adds one beside those the owner lost.
  // A full sign-in by Google (`google.signsInAlone`) holds no key to sign with: its person's first
  // passkey is added as a proven address adds one.
  const proven =
    owed || (session.method === "google" && !(await holdsPasskey(env, session.userId)));
  const first = proven && session.method !== "first-owner-ticket";
  if (owed && (pathname !== KEYS_PATH || (first && (await holdsPasskey(env, session.userId))))) {
    if (post) return json({ error: "Sign in with your passkey first." }, 403);
    const facts = new AccountFacts();
    await endThisSession(env, session, facts);
    return facts.on(
      new Response(null, {
        status: 302,
        headers: {
          location: signIn,
          "set-cookie": clearSessionCookie,
          "cache-control": "no-store",
        },
      }),
    );
  }
  if (pathname === REMOVE_PATH) return removed(env, request, session);
  if (pathname === KEYS_PATH)
    return post
      ? passkeyAdded(env, request, session, { owed: proven, first })
      : keysPage(
          env,
          session,
          honouredNext(url.searchParams.get("next"), issuer, trustedClients),
          proven,
          owed,
        );
  if (get) return enrolPage(env, url, session);
  return serviceKeyAnswered(env, request, session);
}

type KeyRow = {
  id: string;
  user_id: string | null;
  actor: string | null;
  paths: string | null;
  provide: string | null;
  label: string;
  format: string;
  credential_id: string | null;
  added_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

/** A row of `/keys`: a key and the address of the member who added it. */
type ListedKey = KeyRow & { added_by: string; added_by_email: string | null };

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The agent where a new owner starts, in the Dash: `?agent=` opens its chat (the default config's
 *  `onboarding.md`). */
const ONBOARDING_AGENT_PATH = "/agents/onboarding";

/** Where a session that came to /keys only to add a passkey goes once it has one, when its request
 *  named no `next`: the owner's ticket to the onboarding agent, any other to the Dash. */
function onwardOf(env: Env, session: BrowserSession): string {
  const dash = dashOriginOf(iterateConfigOf(env).domain);
  return session.method === "first-owner-ticket"
    ? `${dash}/?agent=${ONBOARDING_AGENT_PATH}`
    : `${dash}/`;
}

async function keysPage(
  env: Env,
  session: BrowserSession,
  next: string | null,
  /** The session adds a passkey with no signature: it holds no key to sign with. */
  owed: boolean,
  /** The session opens /keys alone, so the page offers no way on. */
  held = owed,
): Promise<Response> {
  const issuer = issuerOf(env);
  const { domain } = iterateConfigOf(env);
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(`${CHALLENGE_KEY_PREFIX}${challenge}`, session.userId, {
    expirationTtl: CHALLENGE_SECONDS,
  });
  // A person's own keys and the services' keys that this person allowed, removed ones too; and
  // every live key of a service that another member allowed: any member may remove it, and sees
  // who allowed it.
  const { results } = await env.DB.prepare(
    `select keys.*, adder.email as added_by_email from keys
     left join users as adder on adder.id = keys.added_by
     where keys.user_id = ?1
        or (keys.actor is not null and (keys.added_by = ?1 or keys.revoked_at is null))
     order by keys.added_at`,
  )
    .bind(session.userId)
    .all<ListedKey>();
  // A session held here goes on by itself once its passkey is added: no page leaves it with
  // nothing to press.
  const onward = held ? next || onwardOf(env, session) : null;
  const nextField = next ? `<input type="hidden" name="next" value="${text(next)}">` : "";
  const item = (key: ListedKey) => {
    const scope = scopeInWords({
      paths: JSON.parse(key.paths || "[]") as string[],
      provide: key.provide || undefined,
    });
    const what = key.actor
      ? `a key for ${text(key.actor)}: it can ${text(scope)}`
      : key.format === "webauthn"
        ? "passkey"
        : text(key.format);
    // a key that lends asks for a token each hour it runs, so this says whether its service is alive
    const used = key.provide
      ? `, ${key.last_used_at ? `last used ${day(key.last_used_at)}` : "never used"}`
      : "";
    const by =
      key.actor && key.added_by !== session.userId
        ? `, allowed by ${text(key.added_by_email || "a member")}`
        : "";
    const when = `added ${day(key.added_at)}${by}${used}`;
    // a session that owes a passkey removes nothing, so the ticket's shows the lost keys bare
    const remove = key.revoked_at
      ? `<span class="muted">removed</span>`
      : owed
        ? ""
        : `<form method="post" action="${REMOVE_PATH}" class="inline" data-remove>
          <input type="hidden" name="key" value="${text(key.id)}">${nextField}
          <input type="hidden" name="signed">
          <button type="submit" class="link">Remove</button>
        </form>`;
    return `<li>${text(key.label)} <span class="muted">(${what}, ${when})</span> ${remove}</li>`;
  };
  const passkeys = results.filter(
    (key) => key.user_id && key.format === "webauthn" && !key.revoked_at,
  ).length;
  const formAttributes = `id="add" class="stack" data-challenge="${text(challenge)}" data-user="${text(session.userId)}" data-email="${text(session.email)}" data-rp="${text(new URL(issuer).hostname)}"${owed ? "" : " data-sign"}${onward ? ` data-next="${text(onward)}"` : ""}`;
  const script = `${signScript(domain)}${PASSKEY_SCRIPT}`;
  // THE FIRST SIGN-IN. A person who is held here and has no passkey came for one thing, so the
  // page is that one thing: why, what the browser asks next, and the button. The list of keys, the
  // services' keys and a second passkey are for a later visit.
  if (held && passkeys === 0)
    return page({
      // the heading of the page that spends an owner's ticket (./first-owner.ts), which sends the
      // browser here: the two read as one page
      title: `Add your passkey to ${domain}`,
      body: `<h1>Add your passkey to ${text(domain)}</h1>
      <p>${text(domain)} needs a passkey at your first sign-in. From then on it is how you sign in here, and how you approve what your agents ask for.</p>
      <p>Press the button, and your browser asks for your fingerprint, your face or a security key.</p>
      <form ${formAttributes}>
        <button type="submit">Add a passkey</button>
        <details><summary>Name it (optional)</summary><input name="label" maxlength="100" size="28" aria-label="Name" placeholder="such as YubiKey"></details>
        <p id="status" class="muted" role="status"></p>
      </form>`,
      script,
    });
  // No way on for a session that owes a passkey: every other page sends it back here.
  const goesOn = !held;
  // What the press does, for a person who has never made a passkey: nothing else on the page says
  // that the browser asks next.
  const browserAsks = "Your browser asks for your fingerprint, face or security key.";
  const ask = held
    ? `<p><strong>Add a passkey to go on.</strong> ${browserAsks} Only a passkey signs you in to ${text(domain)} after this.</p>`
    : owed
      ? `<p><strong>Add a passkey.</strong> ${browserAsks} It signs what you change here, such as a new member.</p>`
      : `${
          passkeys === 1
            ? `<p><strong>Add a second passkey</strong>, on another device or a security key. If you lose your only passkey you are locked out, until the mind's owner removes it, or, for an owner, until a new deploy.</p>`
            : ""
        }<p class="muted">A passkey you already have here signs each new one, so you use both: first the new one, then the one you have.</p>`;
  return page({
    title: `Your keys for ${domain}`,
    wide: true,
    body: `<h1>Your keys for ${text(domain)}</h1>
      <p>A key lets you sign in to ${text(domain)} and approve things in it: a passkey in your password manager, or a security key such as a YubiKey. The list also shows the keys that members allowed for services, and any member can remove one of those.</p>
      ${results.length ? `<ul>${results.map(item).join("")}</ul>` : `<p class="muted">You have no keys here yet.</p>`}
      <form ${formAttributes}>
        <label>Name, optional <input name="label" maxlength="100" size="28" placeholder="such as YubiKey"></label>
        <button type="submit">Add a passkey</button>
        <p id="status" class="muted" role="status"></p>
      </form>
      ${ask}
      <p id="removal" class="muted" role="status">${owed ? "" : "Removing a key takes a press of a passkey you have here."}</p>
      ${goesOn ? `<p class="muted">Where you are signed in, and the apps and tools that hold a sign-in as you: <a href="${SESSIONS_PATH}">Sessions</a>.</p>` : ""}
      ${next && goesOn ? `<p><a href="${text(next)}">Done</a></p>` : ""}`,
    script,
  });
}

// With `data-sign` the add takes two presses, since a browser asks for one passkey in one press:
// the first makes the new passkey, the second has a passkey the person holds sign its id.
// `excludeCredentials`: a device makes no second passkey for a person it holds one for. Without
// it a security key writes the new one over the old one, and the old one could then sign nothing.
const PASSKEY_SCRIPT = `
const form = document.getElementById("add");
const status = document.getElementById("status");
let made;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { challenge, user, email, rp } = form.dataset;
  try {
    if (!made) {
      status.textContent = "Waiting for your new passkey…";
      // With no name typed the passkey is named after the device, where the browser says which,
      // and the day: the press never waits for a name.
      const day = new Date().toISOString().slice(0, 10);
      const typed = form.label.value.trim();
      const device = navigator.userAgentData && navigator.userAgentData.platform ? navigator.userAgentData.platform + " passkey" : "Passkey";
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { id: rp, name: rp },
        // The name is what a password manager lists the passkey under: its name here, this host and
        // the day, so that a person's passkeys are told apart there. The address is the displayName.
        user: { id: enc.encode(user), name: [typed || device, rp, day].join(" · "), displayName: email },
        challenge: unb64u(challenge),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: (await passkeys).map((key) => ({ type: "public-key", id: unb64u(key.credentialId) })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        attestation: "none",
      } });
      const publicKey = credential.response.getPublicKey();
      made = {
        key: b64u(await sha256(publicKey)),
        body: { label: typed || device + ", " + day, publicKey: b64u(publicKey), credentialId: credential.id, clientDataJSON: b64u(credential.response.clientDataJSON) },
      };
      if ("sign" in form.dataset) {
        form.querySelector("button").textContent = "Confirm with a passkey you have";
        status.textContent = "The new passkey is made. Now confirm it with a passkey you already have here.";
        return;
      }
    }
    if ("sign" in form.dataset) {
      status.textContent = "Waiting for a passkey you already have…";
      made.body.signed = await signedStatement({ type: "${KEY_ADDED}", payload: { key: made.key } });
    }
    const response = await fetch("${KEYS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(made.body) });
    if (!response.ok) throw new Error((await response.json()).error);
    // said before the next page loads: "Waiting for your new passkey…" would stand there meanwhile
    if (form.dataset.next) {
      status.textContent = "Your passkey is added. One moment…";
      location.assign(form.dataset.next);
    } else location.reload();
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.name === "InvalidStateError" ? "This device holds a passkey of yours for this site already. Make the new one on another device or a security key." : error.message || "The passkey was not added.";
  }
});
// A key is removed by a statement one of the person's passkeys signs: the press is the consent.
for (const remove of document.querySelectorAll("form[data-remove]"))
  remove.addEventListener("submit", async (event) => {
    if (remove.signed.value) return;
    event.preventDefault();
    const said = document.getElementById("removal");
    try {
      said.textContent = "Waiting for your passkey…";
      remove.signed.value = JSON.stringify(await signedStatement({ type: "${KEY_REMOVED}", payload: { key: remove.key.value } }));
      remove.submit();
    } catch (error) {
      said.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.message || "The key was not removed.";
    }
  });`;

async function passkeyAdded(
  env: Env,
  request: Request,
  session: BrowserSession,
  { owed, first }: { owed: boolean; first: boolean },
): Promise<Response> {
  let input: {
    label?: unknown;
    publicKey?: unknown;
    credentialId?: unknown;
    clientDataJSON?: unknown;
    signed?: unknown;
  };
  let clientData: { type?: unknown; origin?: unknown; challenge?: unknown };
  try {
    input = await request.json();
    clientData = JSON.parse(new TextDecoder().decode(fromBase64url(String(input.clientDataJSON))));
  } catch {
    return json(
      { error: "Send the passkey's public key, credential id and client data as JSON." },
      400,
    );
  }
  const { publicKey, credentialId } = input;
  // A name is the person's to give or to leave out: with none, the key is named after the day.
  const label = input.label ?? "";
  if (
    typeof label !== "string" ||
    label.length > 100 ||
    typeof publicKey !== "string" ||
    typeof credentialId !== "string"
  )
    return json(
      {
        error:
          "Send the key's public key and credential id, and a name of at most 100 characters if you name it.",
      },
      400,
    );
  if (clientData.type !== "webauthn.create" || clientData.origin !== issuerOf(env))
    return json({ error: "This is not a passkey made on this page." }, 403);
  const challengeKey = `${CHALLENGE_KEY_PREFIX}${String(clientData.challenge)}`;
  if ((await env.OAUTH_KV.get(challengeKey)) !== session.userId)
    return json({ error: "This page expired. Reload it and try again." }, 403);
  await env.OAUTH_KV.delete(challengeKey);
  const key = await p256KeyIdOf(env, publicKey);
  if (!key) return json({ error: "This passkey's key is not a P-256 key." }, 400);
  // A further passkey lets one more key act as this person, so a key the person holds signs its
  // id. The two ways in sign nothing: a first passkey, and the one the owner's ticket adds.
  const change = owed ? null : await signedChange(env, input.signed, KEY_ADDED);
  if (change && "refused" in change)
    return json(
      {
        error: `The passkey was not added: ${change.refused}. A passkey you already have here signs each new one.`,
      },
      403,
    );
  const own = change && change.signer.principal.email.toLowerCase() === session.email.toLowerCase();
  if (change && (change.payload.key !== key || !own))
    return json(
      {
        error:
          "The passkey was not added: the signed statement is for another key or another person.",
      },
      403,
    );
  const at = Date.now();
  const name = label.trim() || `Passkey, ${new Date(at).toISOString().slice(0, 10)}`;
  const { meta } = await env.DB.prepare(
    `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
     select ?1, ?2, ?3, 'webauthn', ?4, ?5, 'keys-page', ?2, ?6
     where ?7 = 0 or not exists
       (select 1 from keys where user_id = ?2 and format = 'webauthn' and revoked_at is null)
     on conflict do nothing`,
  )
    .bind(key, session.userId, publicKey, credentialId, name, at, first ? 1 : 0)
    .run();
  if (!meta.changes)
    return json(
      { error: `This key was added before${first ? ", or you have a passkey now" : ""}.` },
      409,
    );
  const facts = new AccountFacts();
  facts.add(session.userId, {
    type: "events.iterate.com/account/key-added",
    payload: { key, label: name, format: "webauthn", at, ...(change && signerOf(change)) },
    idempotencyKey: `account/key-added:${key}`,
  });
  // The first passkey, made in this browser, makes the session that passkey's: a new one, and
  // the one it replaces ends.
  const headers = new Headers({ "cache-control": "no-store" });
  if (owed) {
    const user = { id: session.userId, email: session.email };
    const made = await sessionCookie(env, request, user, "passkey", key);
    await endSessions(env, session.userId, { session: session.id }, facts);
    facts.add(session.userId, {
      type: "events.iterate.com/account/signed-in",
      payload: { method: "passkey", key, session: made.session, at: Date.now() },
    });
    headers.set("set-cookie", made.setCookie);
  }
  return facts.on(Response.json({ key, label: name }, { headers }));
}

async function removed(env: Env, request: Request, session: BrowserSession): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("key") || "");
  // A session alone removes no key: whoever stole one could take a member's passkeys away.
  const change = await signedChangeBy(env, form.get("signed"), KEY_REMOVED, session.email);
  if ("refused" in change)
    return errorPage(
      `The key was not removed: ${change.refused}. Removing a key takes a press of a passkey you have here.`,
      403,
    );
  if (change.payload.key !== id)
    return errorPage("The key was not removed: the signed statement is for another key.", 403);
  const next = honouredNext(
    String(form.get("next") || ""),
    issuerOf(env),
    iterateConfigOf(env).trustedClients,
  );
  const at = Date.now();
  // A person's keys are that person's alone. Any member removes a service's key: a mind's
  // services are every member's to stop.
  const row = await env.DB.prepare(
    `update keys set revoked_at = ?1
     where id = ?2 and revoked_at is null
       and (user_id = ?3 or actor is not null)
     returning id, actor, label`,
  )
    .bind(at, id, session.userId)
    .first<{ id: string; actor: string | null; label: string }>();
  const facts = new AccountFacts();
  if (row) {
    const fact: AccountFact = {
      type: "events.iterate.com/account/key-removed",
      payload: {
        key: row.id,
        label: row.label,
        actor: row.actor || undefined,
        at,
        ...signerOf(change),
      },
      // with the time: a service's key can be added again and removed again
      idempotencyKey: `account/key-removed:${row.id}:${at}`,
    };
    facts.add(session.userId, fact);
    if (row.actor) facts.addToMind(fact);
  }
  const back = next ? `${KEYS_PATH}?${new URLSearchParams({ next })}` : KEYS_PATH;
  return facts.on(seeOther(back));
}

async function keysJson(env: Env, session: BrowserSession): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, credential_id, label, format from keys
     where user_id = ?1 and revoked_at is null order by added_at`,
  )
    .bind(session.userId)
    .all<{ id: string; credential_id: string | null; label: string; format: string }>();
  return json({
    user: session.userId,
    email: session.email,
    keys: results.map((key) => ({
      key: key.id,
      credentialId: key.credential_id,
      label: key.label,
      format: key.format,
    })),
  });
}

// The name a service asks for is its own choice, and a reader trusts the Cloud's by the name alone.
async function serviceKeyAsked(
  env: Env,
  fields: URLSearchParams | FormData,
): Promise<ServiceKeyRequest | { refused: string }> {
  const ask = serviceKeyRequestOf(fields);
  if ("refused" in ask || ask.actor !== CLOUD_ACTOR) return ask;
  const origin = env.CLOUD_ORIGIN;
  // a redirect is no answer: the key must be the one this origin itself gives
  const answer = origin
    ? await fetch(`${origin}/.well-known/iterate-cloud`, { redirect: "manual" }).catch(() => null)
    : null;
  const facts: unknown = answer?.ok ? await answer.json().catch(() => null) : null;
  const published =
    typeof facts === "object" &&
    facts &&
    "publicKey" in facts &&
    typeof facts.publicKey === "string"
      ? facts.publicKey
      : null;
  const refused = cloudNameRefusal(ask.publicKey, origin ? { origin, publicKey: published } : null);
  if (!refused) return ask;
  console.info({ event: "auth.cloud-name-refused", cloud: origin || null });
  return { refused };
}

async function enrolPage(env: Env, url: URL, session: BrowserSession): Promise<Response> {
  const { domain, trustedClients } = iterateConfigOf(env);
  const ask = await serviceKeyAsked(env, url.searchParams);
  if ("refused" in ask) return errorPage(ask.refused, 400);
  const key = await p256KeyIdOf(env, ask.publicKey);
  if (!key) return errorPage("The service's key is not one this mind can use.", 400);
  const held = await nameHeldByAnotherKey(env, key, ask);
  if (held) return held;
  const next = honouredNext(url.searchParams.get("next"), issuerOf(env), trustedClients);
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${text(value)}">`;
  const statement = statementHtml(statementInParts(ask, { domain, key, person: session.email }));
  const start = text(key.slice(0, 8));
  return page({
    title: "Sign this statement?",
    // The consent page's own look, over the plain page's stylesheet. A part may break across lines,
    // so a long path still fits a phone, and each line of it keeps its tint.
    style: `
.statement { padding: 0.75rem 0.875rem; border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.8125rem; line-height: 1.75; }
.part-checked, .part-link, .part-you { padding: 0.0625rem 0.3125rem; border-radius: calc(var(--radius) - 4px); overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.part-checked { background: color-mix(in oklab, var(--success) 14%, transparent); }
.part-link { border: 1px dashed color-mix(in oklab, var(--warning) 75%, transparent); background: color-mix(in oklab, var(--warning) 8%, transparent); }
.part-you { background: color-mix(in oklab, var(--foreground) 8%, transparent); }
.legend { font-size: 0.8125rem; line-height: 1.9; }
summary { cursor: pointer; }`,
    body: `<h1>Sign this statement?</h1>
      <p>${text(scopePlainly(ask, domain))}</p>
      <p class="statement">${statement}</p>
      <p class="muted legend"><span class="${PART_CLASS.checked}">checked</span> ${text(domain)} checked this. <span class="${PART_CLASS.link}">from the link</span> The link says this, and nobody checked it. Plain words are the same on every key page.</p>
      <p>Any member can remove the key on <a href="${KEYS_PATH}">Your keys</a>.</p>
      <details>
        <summary>What is a key?</summary>
        <p class="muted">A key has two halves. Its holder keeps the private half and signs with it; that half never comes to ${text(domain)}. ${text(domain)} keeps the public half and checks each signature with it. ${start} is the start of the public half's fingerprint.</p>
      </details>
      <form method="post" action="${ENROL_PATH}" class="actions" data-enrol="${text(JSON.stringify(enrolPayloadOf(key, ask)))}">
        ${hidden("actor", ask.actor)}${hidden("label", ask.label)}${hidden("publicKey", ask.publicKey)}${hidden("paths", ask.paths.join(","))}${ask.provide ? hidden("provide", ask.provide) : ""}${next ? hidden("next", next) : ""}
        ${hidden("decision", "cancel")}${hidden("signed", "")}
        <button type="submit" data-allow>Sign with your passkey</button>
        <button type="submit" class="link">Cancel</button>
      </form>
      <p id="status" class="muted" role="status"></p>`,
    script: `${signScript(domain)}${ENROL_SCRIPT}`,
  });
}

/** A class for each kind of part of the statement (./key-rules.ts `StatementPart`). */
const PART_CLASS = { checked: "part-checked", link: "part-link", you: "part-you" } as const;

/** The statement as HTML: each part's text escaped, and a part that is no plain word in a span of
 *  its kind. The label and the actor come from a link that anyone can write. */
export function statementHtml(sentences: StatementPart[][]): string {
  return sentences
    .map((sentence) =>
      sentence
        .map((part) =>
          part.from
            ? `<span class="${PART_CLASS[part.from]}">${text(part.text)}</span>`
            : text(part.text),
        )
        .join(""),
    )
    .join(" ");
}

// The press of "Sign with your passkey" is a statement one of the person's passkeys signs: the key,
// all it may do and its label, as the page says it. Cancel posts the form as it is.
const ENROL_SCRIPT = `
const form = document.querySelector("form[data-enrol]");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  if (!event.submitter?.hasAttribute("data-allow") || form.signed.value) return;
  event.preventDefault();
  try {
    status.textContent = "Waiting for your passkey…";
    form.signed.value = JSON.stringify(await signedStatement({ type: "${KEY_ADDED}", payload: JSON.parse(form.dataset.enrol) }));
    form.decision.value = "allow";
    form.submit();
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.message || "The key was not added.";
  }
});`;

// A service's key a member removed is added again by a member's new consent; a person's key never is.
async function serviceKeyAnswered(
  env: Env,
  request: Request,
  session: BrowserSession,
): Promise<Response> {
  const { domain, trustedClients } = iterateConfigOf(env);
  const form = await request.formData();
  const next = honouredNext(String(form.get("next") || ""), issuerOf(env), trustedClients);
  if (form.get("decision") !== "allow")
    return onward(
      next,
      new AccountFacts(),
      "Nothing was added",
      `<p>No key was added to ${text(domain)}.</p>`,
    );
  const ask = await serviceKeyAsked(env, form);
  if ("refused" in ask) return errorPage(ask.refused, 400);
  const key = await p256KeyIdOf(env, ask.publicKey);
  if (!key) return errorPage("The service's key is not one this mind can use.", 400);
  const held = await nameHeldByAnotherKey(env, key, ask);
  if (held) return held;
  // A service's key lets one more thing act, so the member's passkey signs it: a session alone, or
  // a page that posts this form for the member, allows nothing.
  const change = await signedChangeBy(env, form.get("signed"), KEY_ADDED, session.email);
  if ("refused" in change)
    return errorPage(
      `No key was added: ${change.refused}. Allowing a key takes a press of your passkey.`,
      403,
    );
  if (!allowsExactly(change.payload, key, ask))
    return errorPage(
      "No key was added: the signed statement is for another key, or for another reach.",
      403,
    );
  const at = Date.now();
  const { meta } = await env.DB.prepare(
    `insert into keys (id, actor, paths, public_key, format, label, added_via, added_by, added_at, provide)
     values (?1, ?2, ?3, ?4, 'p256', ?5, 'enrol-page', ?6, ?7, ?8)
     on conflict (id) do update set actor = excluded.actor, paths = excluded.paths,
       label = excluded.label, added_by = excluded.added_by, added_at = excluded.added_at,
       provide = excluded.provide, last_used_at = null, revoked_at = null
     where keys.revoked_at is not null and keys.user_id is null`,
  )
    .bind(
      key,
      ask.actor,
      JSON.stringify(ask.paths),
      ask.publicKey,
      ask.label,
      session.userId,
      at,
      ask.provide || null,
    )
    .run();
  const facts = new AccountFacts();
  if (meta.changes) {
    const fact: AccountFact = {
      type: "events.iterate.com/account/key-added",
      payload: {
        key,
        label: ask.label,
        format: "p256",
        at,
        actor: ask.actor,
        paths: ask.paths,
        provide: ask.provide,
        addedBy: session.userId,
        ...signerOf(change),
      },
      // with the time: the same key added again after a removal is a new fact
      idempotencyKey: `account/key-added:${key}:${at}`,
    };
    facts.add(session.userId, fact);
    facts.addToMind(fact);
  } else if (!(await liveFor(env, key, ask))) {
    return errorPage("This key is in use here for something else, so it cannot be added.", 409);
  }
  return onward(
    next,
    facts,
    "Added",
    `<p>${text(ask.label)} can now ${text(scopeInWords(ask))}.</p>`,
  );
}

/** The refusal for a key that asks to lend a name another live key lends (./key-rules.ts
 *  `otherKeyLending`), or null. A lend by a member's own session is in no table here, so the
 *  consent page says of every key that lends what it does to a name in use: it takes the name only
 *  when that lend ends. */
async function nameHeldByAnotherKey(
  env: Env,
  key: string,
  ask: ServiceKeyRequest,
): Promise<Response | null> {
  if (!ask.provide) return null;
  const { results } = await env.DB.prepare(
    `select id, label, provide, added_at from keys
     where provide is not null and actor is not null and revoked_at is null
     order by added_at`,
  ).all<LendingKey>();
  const held = otherKeyLending(results, key, ask.provide);
  if (!held) return null;
  return errorPage(
    `itx.${ask.provide} is lent to ${iterateConfigOf(env).domain} by another key: ${held.label} (key ${held.id.slice(0, 8)}, added ${day(held.added_at)}). A second key for that name would take it whenever that key's lend ends. If this key is to replace that one, a member removes it on Your keys first.`,
    409,
    undefined,
    [{ href: KEYS_PATH, label: "Your keys" }],
  );
}

async function liveFor(env: Env, key: string, ask: ServiceKeyRequest): Promise<boolean> {
  const row = await env.DB.prepare(
    `select 1 from keys where id = ?1 and actor = ?2 and paths = ?3
       and provide is ?4 and revoked_at is null`,
  )
    .bind(key, ask.actor, JSON.stringify(ask.paths), ask.provide || null)
    .first();
  return Boolean(row);
}

function onward(next: string | null, facts: AccountFacts, title: string, body: string): Response {
  if (next) return facts.on(seeOther(next));
  return facts.on(
    page({
      title,
      body: `<h1>${text(title)}</h1>${body}<p><a href="${KEYS_PATH}">Your keys</a></p>`,
    }),
  );
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

// null for the stack's own key too
async function p256KeyIdOf(env: Env, publicKey: string): Promise<string | null> {
  try {
    await crypto.subtle.importKey("spki", fromBase64url(publicKey), P256, false, ["verify"]);
  } catch {
    return null;
  }
  const key = await keyIdOf(publicKey);
  return key === (await stackKeyOf(env)).key ? null : key;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
