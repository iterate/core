import { base64url, fromBase64url, keyIdOf, STACK_KEY_PATH } from "iterate/signed";
import { type AccountFact, AccountFacts } from "./account-facts.ts";
import { isOwner } from "./config.ts";
import { type Session, sessionOf } from "./cookies.ts";
import { cloudKeyRefusal } from "./cloud-key.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import {
  allowsExactly,
  CLOUD_ACTOR,
  cloudPlainly,
  enrolPayloadOf,
  honouredNext,
  type LendingKey,
  otherKeyLending,
  scopeInWords,
  scopePlainly,
  type ServiceKeyRequest,
  serviceKeyRequestOf,
  type StatementPart,
  statementRows,
} from "./key-rules.ts";
import { isMember } from "./members.ts";
import { errorPage, factsTable, notMemberPage, page, text } from "./pages.ts";
import { MINDS_PATH } from "./minds-page.ts";
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
import { stackKeyOf, stackKeyResponse } from "./stack-key.ts";

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
  const known =
    (pathname === KEYS_PATH && (get || post)) ||
    (pathname === KEYS_JSON_PATH && get) ||
    (pathname === REMOVE_PATH && post) ||
    (pathname === ENROL_PATH && (get || post));
  if (!known) return null;
  const issuer = issuerOf(env);
  const config = configOf(env);
  const session = await sessionOf(env, request);
  const member = session ? await isMember(env, session.email) : false;
  if (pathname === KEYS_JSON_PATH) {
    if (!session) return json({ error: "signed out" }, 401);
    if (!member) return json({ error: "not a member" }, 403);
    return keysJson(env, session);
  }
  if (post) {
    // the page's own form or script alone
    if (request.headers.get("origin") !== issuer)
      return json({ error: "use this site's own page" }, 403);
    if (!session) return json({ error: "sign in first" }, 401);
  }
  if (!session) return Response.redirect(`${issuer}${signInHref(pathname + url.search)}`, 302);
  if (!member)
    return post
      ? json({ error: "not a member" }, 403)
      : notMemberPage({ mind: config.controlPlaneHostname, email: session.email });
  if (pathname === REMOVE_PATH) return removed(env, request, session);
  if (pathname === KEYS_PATH)
    return post
      ? passkeyAdded(env, request, session)
      : keysPage(env, session, honouredNext(url.searchParams.get("next"), config));
  if (get) return enrolPage(env, url, session);
  return serviceKeyAnswered(env, request, session);
}

type KeyRow = {
  id: string;
  user_id: string | null;
  actor: string | null;
  paths: string | null;
  provide: string | null;
  /** The iterate Cloud that published the key, for `CLOUD_ACTOR`'s key (../migrations/0019). */
  origin: string | null;
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

async function keysPage(env: Env, session: Session, next: string | null): Promise<Response> {
  const issuer = issuerOf(env);
  const mind = configOf(env).controlPlaneHostname;
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(`${CHALLENGE_KEY_PREFIX}${challenge}`, session.userId, {
    expirationTtl: CHALLENGE_SECONDS,
  });
  // A person's own keys and the services' keys that this person allowed, removed ones too; and
  // every live key of a service that another member allowed: any member may remove it, and sees
  // who allowed it. A passkey from before the person was a member is not theirs as a member: it
  // is left out, and the member's first passkey revokes it (`passkeyAdded`).
  const { results } = await env.DB.prepare(
    `select keys.*, adder.email as added_by_email from keys
     left join users as adder on adder.id = keys.added_by
     where (keys.user_id = ?1 and keys.outsider = 0)
        or (keys.actor is not null and (keys.added_by = ?1 or keys.revoked_at is null))
     order by keys.added_at`,
  )
    .bind(session.userId)
    .all<ListedKey>();
  const passkeys = results.filter(
    (key) => key.user_id && key.format === "webauthn" && !key.revoked_at,
  ).length;
  const nextField = next ? `<input type="hidden" name="next" value="${text(next)}">` : "";
  const item = (key: ListedKey) => {
    const scope = scopeInWords({
      paths: JSON.parse(key.paths || "[]") as string[],
      provide: key.provide || undefined,
    });
    const published = key.origin ? `, published by ${text(new URL(key.origin).host)}` : "";
    const what = key.actor
      ? `service key for ${text(key.actor)}${published}: can ${text(scope)}`
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
    // nobody removes their own last passkey (`removed`): the one that is left has no button
    const last = Boolean(key.user_id) && key.format === "webauthn" && passkeys === 1;
    const remove = key.revoked_at
      ? `<span class="muted">removed</span>`
      : last
        ? `<span class="muted">your only passkey: add another to remove it</span>`
        : `<form method="post" action="${REMOVE_PATH}" class="inline" data-remove>
          <input type="hidden" name="key" value="${text(key.id)}">${nextField}
          <input type="hidden" name="signed">
          <button type="submit" class="link">Remove</button>
        </form>`;
    return `<li>${text(key.label)} <span class="muted">(${what}, ${when})</span> ${remove}</li>`;
  };
  const formAttributes = `id="add" class="stack" data-challenge="${text(challenge)}" data-user="${text(session.userId)}" data-email="${text(session.email)}" data-rp="${text(new URL(issuer).hostname)}"`;
  // what the loss of the only passkey means, and who then lets the person in again
  const locked = isOwner(configOf(env), session.email)
    ? "until whoever holds this mind's Cloudflare account runs the recovery command"
    : "until an owner gives you a sign-in link";
  const second =
    passkeys === 1
      ? `<p><strong>Add a second passkey</strong> on another device or a security key. Lose your only one and you are locked out ${locked}.</p>`
      : "";
  return page({
    title: `Your keys for ${mind}`,
    wide: true,
    body: `<h1>Your keys for ${text(mind)}</h1>
      <p>Your passkeys sign you in and approve changes. Service keys let a service act in this mind, and any member can remove one.</p>
      ${results.length ? `<ul>${results.map(item).join("")}</ul>` : `<p class="muted">No keys yet.</p>`}
      <p id="removal" class="muted" role="status"></p>
      <form ${formAttributes}>
        <label>Name (optional) <input name="label" maxlength="100" size="28" placeholder="such as YubiKey"></label>
        <button type="submit">Add a passkey</button>
        <p id="status" class="muted" role="status"></p>
      </form>
      ${second}<p class="muted">Adding asks for two passkeys: the new one, then one you already have. Removing asks for one.</p>
      <p class="muted"><a href="${SESSIONS_PATH}">Where you are signed in</a> &middot; <a href="${MINDS_PATH}">Minds let in</a></p>
      ${next ? `<p><a href="${text(next)}">Done</a></p>` : ""}`,
    script: `${signScript(mind)}${PASSKEY_SCRIPT}`,
  });
}

// The add takes two presses, since a browser asks for one passkey in one press: the first makes
// the new passkey, the second has a passkey the person holds sign its id.
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
      statusSay(status, "Waiting for your new passkey…");
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
      form.querySelector("button").textContent = "Confirm with a passkey you have";
      statusSay(status, "New passkey made. Now confirm with one you already have.");
      return;
    }
    statusSay(status, "Waiting for a passkey you already have…");
    made.body.signed = await signedStatement({ type: "${KEY_ADDED}", payload: { key: made.key } });
    const response = await fetch("${KEYS_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(made.body) });
    if (!response.ok) throw new Error((await response.json()).error);
    location.reload();
  } catch (error) {
    if (error.name === "InvalidStateError") statusRefused(status, "This device already has a passkey of yours for this site. Use another device or a security key.");
    else statusFailed(status, error, "The passkey was not added.");
  }
});
// A key is removed by a statement one of the person's passkeys signs: the press is the consent.
for (const remove of document.querySelectorAll("form[data-remove]"))
  remove.addEventListener("submit", async (event) => {
    if (remove.signed.value) return;
    event.preventDefault();
    const said = document.getElementById("removal");
    try {
      statusSay(said, "Waiting for your passkey…");
      remove.signed.value = JSON.stringify(await signedStatement({ type: "${KEY_REMOVED}", payload: { key: remove.key.value } }));
      remove.submit();
    } catch (error) {
      statusFailed(said, error, "The key was not removed.");
    }
  });`;

/** A FURTHER PASSKEY of a member who signed in with one. A person's first passkey is
 *  ./enrolment.ts's. */
async function passkeyAdded(env: Env, request: Request, session: Session): Promise<Response> {
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
  // id.
  const change = await signedChange(env, input.signed, KEY_ADDED);
  if ("refused" in change)
    return json(
      {
        error: `The passkey was not added: ${change.refused}. Confirm with a passkey you already have.`,
      },
      403,
    );
  const own = change.signer.principal.email.toLowerCase() === session.email.toLowerCase();
  if (change.payload.key !== key || !own)
    return json(
      {
        error:
          "The passkey was not added: the signed statement is for another key or another person.",
      },
      403,
    );
  const at = Date.now();
  const name = label.trim() || `Passkey, ${new Date(at).toISOString().slice(0, 10)}`;
  // one transaction: the new passkey, and the end of the ones from before the address was a
  // member's, which no failure between two writes leaves live
  const [inserted, revoked] = await env.DB.batch<{ id: string; label: string }>([
    env.DB.prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values (?1, ?2, ?3, 'webauthn', ?4, ?5, 'keys-page', ?2, ?6)
       on conflict do nothing`,
    ).bind(key, session.userId, publicKey, credentialId, name, at),
    outsiderKeysRevoked(env, session.userId, key, at),
  ]);
  if (!inserted?.meta.changes) return json({ error: "This key was added before." }, 409);
  const facts = new AccountFacts();
  outsiderKeysRevokedFacts(facts, session.userId, at, revoked?.results || []);
  facts.add(session.userId, {
    type: "events.iterate.com/account/key-added",
    payload: { key, label: name, format: "webauthn", at, ...signerOf(change) },
    idempotencyKey: `account/key-added:${key}`,
  });
  return facts.on(
    Response.json({ key, label: name }, { headers: { "cache-control": "no-store" } }),
  );
}

/** A MEMBER'S OWN PASSKEY ENDS THE ONES FROM BEFORE THE ADDRESS WAS A MEMBER (../migrations/0016):
 *  whoever added one then holds nothing of this person's now. The statement goes in the same batch
 *  as the new passkey's insert, and ends them only when that insert made the passkey `key` at
 *  `at`. ./enrolment.ts uses it for the first passkey, and `passkeyAdded` for each further one;
 *  `outsiderKeysRevokedFacts` writes a fact for each key it ended. */
export const outsiderKeysRevoked = (env: Env, userId: string, key: string, at: number) =>
  env.DB.prepare(
    `update keys set revoked_at = ?1
     where user_id = ?2 and outsider = 1 and revoked_at is null
       and exists (select 1 from keys new where new.id = ?3 and new.user_id = ?2
         and new.added_at = ?1)
     returning id, label`,
  ).bind(at, userId, key);

export function outsiderKeysRevokedFacts(
  facts: AccountFacts,
  userId: string,
  at: number,
  results: { id: string; label: string }[],
) {
  for (const old of results)
    facts.add(userId, {
      type: "events.iterate.com/account/key-removed",
      payload: { key: old.id, label: old.label, at, removedBy: userId },
      idempotencyKey: `account/key-removed:${old.id}:${at}`,
    });
}

async function removed(env: Env, request: Request, session: Session): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("key") || "");
  // A session alone removes no key: whoever stole one could take a member's passkeys away.
  const change = await signedChangeBy(env, form.get("signed"), KEY_REMOVED, session.email);
  if ("refused" in change)
    return errorPage(
      `The key was not removed: ${change.refused}. Confirm with one of your passkeys.`,
      403,
    );
  if (change.payload.key !== id)
    return errorPage("The key was not removed: the signed statement is for another key.", 403);
  const next = honouredNext(String(form.get("next") || ""), configOf(env));
  const at = Date.now();
  // A person's keys are that person's alone. Any member removes a service's key: a mind's
  // services are every member's to stop. NOBODY REMOVES THEIR OWN LAST PASSKEY: with none,
  // nothing of the person's own signs them in again. The way back would be the recovery command
  // for an owner, and an owner's link for an added member (./enrolment.ts). The statement holds
  // it, so of two removals at once one passkey stays.
  const row = await env.DB.prepare(
    `update keys set revoked_at = ?1
     where id = ?2 and revoked_at is null
       and (actor is not null or (user_id = ?3 and exists (select 1 from keys other
         where other.user_id = ?3 and other.format = 'webauthn' and other.revoked_at is null
           and other.outsider = 0 and other.id != ?2)))
     returning id, actor, label`,
  )
    .bind(at, id, session.userId)
    .first<{ id: string; actor: string | null; label: string }>();
  if (!row) {
    const own = await env.DB.prepare(
      "select 1 from keys where id = ?1 and user_id = ?2 and revoked_at is null",
    )
      .bind(id, session.userId)
      .first();
    if (own)
      return errorPage(
        "This is your only passkey, so it was not removed. Add another first.",
        409,
        undefined,
        [{ href: KEYS_PATH, label: "Your keys" }],
      );
  }
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

async function keysJson(env: Env, session: Session): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, credential_id, label, format from keys
     where user_id = ?1 and revoked_at is null and outsider = 0 order by added_at`,
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

async function enrolPage(env: Env, url: URL, session: Session): Promise<Response> {
  const config = configOf(env);
  const mind = config.controlPlaneHostname;
  const ask = serviceKeyRequestOf(url.searchParams);
  if ("refused" in ask) return errorPage(ask.refused, 400);
  const key = await p256KeyIdOf(env, ask.publicKey);
  if (!key) return errorPage("The service's key is not one this mind can use.", 400);
  const held = await nameHeldByAnotherKey(env, key, ask);
  if (held) return held;
  const notPublished = ask.cloud && (await cloudKeyRefusal(ask.cloud, ask.publicKey));
  if (notPublished) return errorPage(notPublished, 400);
  const next = honouredNext(url.searchParams.get("next"), config);
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${text(value)}">`;
  const rows = statementRows(ask, { mind, key, person: session.email }).map((row) => ({
    label: row.label,
    value: statementHtml(row.value),
    note: row.note && statementHtml(row.note),
    help: row.help,
  }));
  // iterate Cloud's page names the Cloud's host, which the member must recognise, and not the
  // link's label
  const cloud = ask.cloud ? cloudPlainly(ask.cloud, mind) : null;
  const opening = cloud
    ? `<h1>${text(cloud.heading)}</h1>
      <p>${text(cloud.can)}</p>
      <p><strong>${text(cloud.recognise)}</strong></p>`
    : `<h1>Add a service key</h1>
      <p>${text(scopePlainly(ask))}</p>`;
  // every part of the Cloud's statement is checked or plain
  const fromLink = cloud
    ? ""
    : ` &middot; <span class="${PART_CLASS.link}">from the link</span> not checked by anyone`;
  return page({
    title: cloud ? cloud.heading : "Add a service key",
    wide: true,
    // The consent page's own look, over the plain page's stylesheet. A part may break across lines,
    // so a long path still fits a phone, and each line of it keeps its tint.
    style: `
.part-checked, .part-link, .part-you { padding: 0.0625rem 0.3125rem; border-radius: calc(var(--radius) - 4px); overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.part-checked { background: color-mix(in oklab, var(--success) 14%, transparent); }
.part-link { border: 1px dashed color-mix(in oklab, var(--warning) 75%, transparent); background: color-mix(in oklab, var(--warning) 8%, transparent); }
.part-you { background: color-mix(in oklab, var(--foreground) 8%, transparent); }
.legend { font-size: 0.8125rem; line-height: 1.9; }`,
    body: `${opening}
      ${factsTable(rows)}
      <p class="muted legend"><span class="${PART_CLASS.checked}">checked</span> checked by this mind${fromLink}</p>
      <form method="post" action="${ENROL_PATH}" class="actions" data-enrol="${text(JSON.stringify(enrolPayloadOf(key, ask)))}">
        ${hidden("actor", ask.actor)}${hidden("label", ask.label)}${hidden("publicKey", ask.publicKey)}${hidden("paths", ask.paths.join(","))}${ask.provide ? hidden("provide", ask.provide) : ""}${ask.cloud ? hidden("cloud", ask.cloud) : ""}${next ? hidden("next", next) : ""}
        ${hidden("decision", "cancel")}${hidden("signed", "")}
        <button type="submit" data-allow>Sign with passkey</button>
        <button type="submit" class="link">Cancel</button>
      </form>
      <p id="status" class="muted" role="status"></p>`,
    script: `${signScript(mind)}${ENROL_SCRIPT}`,
  });
}

/** A class for each kind of part of the statement (./key-rules.ts `StatementPart`). */
const PART_CLASS = { checked: "part-checked", link: "part-link", you: "part-you" } as const;

/** A row's parts as HTML: each part's text escaped, and a part that is no plain word in a span of
 *  its kind. The label and the actor come from a link that anyone can write. */
export function statementHtml(parts: StatementPart[]): string {
  return parts
    .map((part) =>
      part.from
        ? `<span class="${PART_CLASS[part.from]}">${text(part.text)}</span>`
        : text(part.text),
    )
    .join("");
}

// The press of "Sign with passkey" is a statement one of the person's passkeys signs: the key,
// all it may do and its label, as the page says it. Cancel posts the form as it is.
const ENROL_SCRIPT = `
const form = document.querySelector("form[data-enrol]");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  if (!event.submitter?.hasAttribute("data-allow") || form.signed.value) return;
  event.preventDefault();
  try {
    statusSay(status, "Waiting for your passkey…");
    form.signed.value = JSON.stringify(await signedStatement({ type: "${KEY_ADDED}", payload: JSON.parse(form.dataset.enrol) }));
    form.decision.value = "allow";
    form.submit();
  } catch (error) {
    statusFailed(status, error, "The key was not added.");
  }
});`;

// A service's key a member removed is added again by a member's new consent; a person's key never is.
async function serviceKeyAnswered(env: Env, request: Request, session: Session): Promise<Response> {
  const config = configOf(env);
  const form = await request.formData();
  const next = honouredNext(String(form.get("next") || ""), config);
  if (form.get("decision") !== "allow")
    return onward(next, new AccountFacts(), "Nothing was added", "<p>No key was added.</p>");
  const ask = serviceKeyRequestOf(form);
  if ("refused" in ask) return errorPage(ask.refused, 400);
  const key = await p256KeyIdOf(env, ask.publicKey);
  if (!key) return errorPage("The service's key is not one this mind can use.", 400);
  const held = await nameHeldByAnotherKey(env, key, ask);
  if (held) return held;
  // A service's key lets one more thing act, so the member's passkey signs it: a session alone, or
  // a page that posts this form for the member, allows nothing.
  const change = await signedChangeBy(env, form.get("signed"), KEY_ADDED, session.email);
  if ("refused" in change)
    return errorPage(`No key was added: ${change.refused}. Sign with one of your passkeys.`, 403);
  if (!allowsExactly(change.payload, key, ask))
    return errorPage(
      "No key was added: the signed statement is for another key, or for another reach.",
      403,
    );
  // read again at the press: the Cloud may have changed its key since the page was shown
  const notPublished = ask.cloud && (await cloudKeyRefusal(ask.cloud, ask.publicKey));
  if (notPublished) return errorPage(notPublished, 400);
  const at = Date.now();
  const { meta } = await env.DB.prepare(
    `insert into keys (id, actor, paths, public_key, format, label, added_via, added_by, added_at, provide, origin)
     values (?1, ?2, ?3, ?4, 'p256', ?5, 'enrol-page', ?6, ?7, ?8, ?9)
     on conflict (id) do update set actor = excluded.actor, paths = excluded.paths,
       label = excluded.label, added_by = excluded.added_by, added_at = excluded.added_at,
       provide = excluded.provide, origin = excluded.origin, last_used_at = null, revoked_at = null
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
      ask.cloud || null,
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
        cloud: ask.cloud,
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
 *  `otherKeyLending`), or for iterate Cloud's name while another live key holds it, or null. A lend
 *  by a member's own session is in no table here, so the consent page says of every key that lends
 *  what it does to a name in use: it takes the name only when that lend ends. */
async function nameHeldByAnotherKey(
  env: Env,
  key: string,
  ask: ServiceKeyRequest,
): Promise<Response | null> {
  if (ask.actor === CLOUD_ACTOR) return cloudNameHeld(env, key);
  if (!ask.provide) return null;
  const { results } = await env.DB.prepare(
    `select id, label, provide, added_at from keys
     where provide is not null and actor is not null and revoked_at is null
     order by added_at`,
  ).all<LendingKey>();
  const held = otherKeyLending(results, key, ask.provide);
  if (!held) return null;
  return errorPage(
    `itx.${ask.provide} is lent to ${configOf(env).controlPlaneHostname} by another key: ${held.label} (key ${held.id.slice(0, 8)}, added ${day(held.added_at)}). A second key for that name would take it whenever that key's lend ends. If this key is to replace that one, a member removes it on Your keys first.`,
    409,
    undefined,
    [{ href: KEYS_PATH, label: "Your keys" }],
  );
}

/** ONE KEY OF iterate Cloud AT A TIME: a reader trusts the name `CLOUD_ACTOR` alone, so a Cloud
 *  at another origin, or a new key of the same Cloud, gets it only once a member removed the key
 *  that holds it now. Allowing a key replaces no other by itself. */
async function cloudNameHeld(env: Env, key: string): Promise<Response | null> {
  const held = await env.DB.prepare(
    `select id, label, origin, added_at from keys
     where actor = ?1 and revoked_at is null and id != ?2 order by added_at limit 1`,
  )
    .bind(CLOUD_ACTOR, key)
    .first<{ id: string; label: string; origin: string | null; added_at: number }>();
  if (!held) return null;
  const by = held.origin ? new URL(held.origin).host : "an address that this mind did not keep";
  return errorPage(
    `The name ${CLOUD_ACTOR} is held now by the key that ${by} publishes (key ${held.id.slice(0, 8)}, added ${day(held.added_at)}). This mind trusts one key of iterate Cloud at a time, and allowing this one replaces nothing by itself. If this key is to replace that one, a member removes that key on Your keys first.`,
    409,
    undefined,
    [{ href: KEYS_PATH, label: "Your keys" }],
  );
}

async function liveFor(env: Env, key: string, ask: ServiceKeyRequest): Promise<boolean> {
  const row = await env.DB.prepare(
    `select 1 from keys where id = ?1 and actor = ?2 and paths = ?3
       and provide is ?4 and origin is ?5 and revoked_at is null`,
  )
    .bind(key, ask.actor, JSON.stringify(ask.paths), ask.provide || null, ask.cloud || null)
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
