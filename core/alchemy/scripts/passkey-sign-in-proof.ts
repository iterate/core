//   node --env-file-if-exists=.secrets scripts/passkey-sign-in-proof.ts <domain>
// Signs in to https://iterate.<domain> with a passkey, in headless Chromium with a virtual
// authenticator. It adds passkeys and a member for the member it is given, and removes them.
// ITERATE_PROOF_FIRST_OWNER_TICKET  a first owner's ticket: the session comes from /keys/first
// ITERATE_PROOF_SESSION_COOKIE      else a member's session cookie's value: of a member with no
//                                   passkey from a mailed code, or of one a passkey signed in
// ITERATE_PROOF_PASSKEY             with the session of a software passkey: that passkey's file,
//                                   { credentialId, privateKey }, which signs each new passkey
// ITERATE_PROOF_SHOTS               the folder for screenshots (default: a new temp folder)
// ITERATE_PROTOTYPE_TOKEN           with it, the step of two people who are no members runs: it
//                                   reads their mailed codes in the mind's mail. The stack's
//                                   sign-in must be open to anyone (`login.methods.email.anyone`)
// ITERATE_PROOF_RESOLVE             host:port of a stack that DNS does not name, such as a local
//                                   one; its certificate is then not checked
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { mindMcpUrlOf, platformOriginOf } from "iterate/mind-api";
import { base64url, challengeOf, STATEMENTS_PATH, statementText } from "iterate/signed";
import { z } from "zod";
import { addPasskey, authenticator, lendPasskey, touched } from "./proof-passkeys.ts";
import { mindRoot } from "./smoke/lib.ts";

/** core/auth-worker/src/cookies.ts `SESSION_COOKIE`, which the package does not export. */
const SESSION_COOKIE = "__Host-iterate-auth-session";

const domain = process.argv[2];
const env = process.env;
const ticket = env.ITERATE_PROOF_FIRST_OWNER_TICKET;
if (!domain || process.argv.length > 3 || !(ticket || env.ITERATE_PROOF_SESSION_COOKIE)) {
  console.error(
    "usage: passkey-sign-in-proof.ts <domain>, with ITERATE_PROOF_FIRST_OWNER_TICKET or ITERATE_PROOF_SESSION_COOKIE",
  );
  process.exit(2);
}
const issuer = platformOriginOf(domain);
const shots = env.ITERATE_PROOF_SHOTS || mkdtempSync(join(tmpdir(), "passkey-proof-"));
mkdirSync(shots, { recursive: true });
const label = `proof ${new Date().toISOString().slice(0, 19)}`;

const resolve = env.ITERATE_PROOF_RESOLVE;
const browser = await chromium.launch({
  headless: true,
  args: resolve
    ? [
        `--host-resolver-rules=MAP ${new URL(issuer).hostname}:443 ${resolve}`,
        "--ignore-certificate-errors",
      ]
    : [],
});
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const authenticatorId = await authenticator(cdp, "internal", true);
// the software passkey that opened the given session, on a key of its own: it signs each new passkey
const lent = env.ITERATE_PROOF_PASSKEY ? await authenticator(cdp, "usb", false) : null;
if (lent) await lendPasskey(cdp, lent, issuer, env.ITERATE_PROOF_PASSKEY!);

let step = 0;
async function run(title: string, body: () => Promise<string>) {
  step += 1;
  try {
    console.log(`pass  ${step}. ${title}  (${await body()})`);
    await page.screenshot({ path: join(shots, `${step}.png`) });
  } catch (error) {
    console.log(
      `FAIL  ${step}. ${title}  (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
    await page.screenshot({ path: join(shots, `${step}-failed.png`) }).catch(() => undefined);
    await leftRemoved().catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
/** A run that stops leaves the proof member no passkey of its own: the next run starts clean.
 *  The passkey signs its own removal. */
async function leftRemoved() {
  await touched(cdp, authenticatorId, true);
  await page.goto(`${issuer}/keys`);
  const left = page
    .locator("li", { hasText: label.replace("proof ", "") })
    .filter({ has: page.getByRole("button", { name: "Remove" }) });
  for (let rows = await left.count(); rows > 0; rows--) {
    await left.last().getByRole("button", { name: "Remove" }).click();
    await left.nth(rows - 1).waitFor({ state: "detached", timeout: 10_000 });
  }
}
function must(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

/** What the page's script does, with choices the page never makes: the same answer sent twice. A
 *  string, since this package's types have no DOM. */
const answersOf = async (userVerification: "required" | "discouraged") =>
  z.array(z.object({ status: z.number(), error: z.string().optional() })).parse(
    await page.evaluate(`(async () => {
      const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const { statement, challenge } = await (await post("/sign-in/passkey/challenge", {})).json();
      const assertion = await navigator.credentials.get({ publicKey: {
        challenge: Uint8Array.from(atob(challenge.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
        rpId: location.hostname,
        userVerification: ${JSON.stringify(userVerification)},
      } });
      const { signature, authenticatorData, clientDataJSON } = assertion.response;
      const body = { statement, credentialId: assertion.id, sig: b64(signature), authenticatorData: b64(authenticatorData), clientDataJSON: b64(clientDataJSON) };
      const answers = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await post("/sign-in/passkey", body);
        answers.push({ status: answer.status, error: (await answer.json()).error });
      }
      return answers;
    })()`),
  );

console.log(`proving the passkey sign-in on ${issuer}; screenshots in ${shots}`);

await run("a session on the issuer", async () => {
  if (ticket) {
    await page.goto(`${issuer}/keys/first#${ticket}`);
    await page.waitForURL(`${issuer}/keys`);
    const again = await context.newPage();
    await again.goto(`${issuer}/keys/first#${ticket}`);
    await again.waitForURL(`${issuer}/keys`);
    await again.close();
    const other = await browser.newContext();
    const elsewhere = await other.newPage();
    await elsewhere.goto(`${issuer}/keys/first#${ticket}`);
    await elsewhere.getByText("This link was used before").waitFor();
    await other.close();
    return "the first owner's ticket signed in once; again in that browser it goes on to /keys, in another it is refused";
  }
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: env.ITERATE_PROOF_SESSION_COOKIE!,
      url: issuer,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`${issuer}/keys`);
  must(page.url() === `${issuer}/keys`, `the cookie is no session: at ${page.url()}`);
  return "the given session cookie";
});

await run("a passkey added on /keys, by the virtual authenticator", async () => {
  const how = await addPasskey(page, issuer, label, {
    theOld: async () => lent && touched(cdp, lent, true),
  });
  if (lent) await touched(cdp, lent, false);
  const second = await page.getByText("Add a second passkey").count();
  return `${label}: ${how}; the page ${second ? "asks for a second passkey" : "asks for no other: the member holds more"}`;
});

/** A JSON POST from the page with the session's cookie, as a script that stole the session sends. */
const posted = async (path: string, body: string) =>
  z.object({ status: z.number(), error: z.string().optional() }).parse(
    await page.evaluate(`(async () => {
      const answer = await fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${body} });
      return { status: answer.status, error: (await answer.json().catch(() => ({}))).error };
    })()`),
  );

await run(
  "a further passkey: a session alone adds none, a passkey the member holds signs it",
  async () => {
    // what the page's script sends, without the signed statement; not discoverable, so no sign-in offers it
    await page.goto(`${issuer}/keys`);
    const bare = await posted(
      "/keys",
      `JSON.stringify(await (async () => {
      const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const { challenge, user, email, rp } = document.getElementById("add").dataset;
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { id: rp, name: rp },
        user: { id: new TextEncoder().encode(user), name: email, displayName: email },
        challenge: Uint8Array.from(atob(challenge.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "discouraged" },
      } });
      return { label: "no signature", publicKey: b64(credential.response.getPublicKey()), credentialId: credential.id, clientDataJSON: b64(credential.response.clientDataJSON) };
    })())`,
    );
    must(bare.status === 403, `with no signature it answered ${bare.status}: ${bare.error}`);
    // no part of the first one's name, so a row is found by one name alone
    const second = label.replace("proof ", "proof 2 ");
    // on a second key, as a person does: the first one makes no second passkey for its holder
    const other = await authenticator(cdp, "usb", false);
    const how = await addPasskey(page, issuer, second, {
      theNew: () => Promise.all([touched(cdp, authenticatorId, false), touched(cdp, other, true)]),
      theOld: () => Promise.all([touched(cdp, other, false), touched(cdp, authenticatorId, true)]),
    });
    must(how.includes("signed"), `the second passkey was added with no signature: ${how}`);
    const { keys } = z
      .object({
        keys: z.array(z.object({ label: z.string(), credentialId: z.string().nullable() })),
      })
      .parse(await page.evaluate(`fetch("/keys.json").then((answer) => answer.json())`));
    must(!keys.some((key) => key.label === "no signature"), "the unsigned passkey is listed");
    // gone from the stack, and its key from the browser, so one passkey signs in below
    must(
      keys.some((key) => key.label === second),
      "GET /keys.json does not name the second passkey",
    );
    await page.locator("li", { hasText: second }).getByRole("button", { name: "Remove" }).click();
    await page.locator("li", { hasText: second }).getByText("removed").waitFor();
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: other });
    return `with no signature: 403, ${bare.error}; "${second}": ${how}, then removed`;
  },
);

await run("a member: a session alone adds none, the passkey signs the add", async () => {
  const member = `proof-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${issuer}/members`);
  const bare = await posted("/members", JSON.stringify(JSON.stringify({ email: member })));
  must(bare.status === 403, `with no signature it answered ${bare.status}: ${bare.error}`);
  await page.getByLabel("Email", { exact: true }).fill(member);
  await page.getByRole("button", { name: "Add a member" }).click();
  const row = page.locator("li", { hasText: member });
  await row.waitFor().catch(async () => {
    throw new Error(`not listed; the page says: ${await page.locator("#status").textContent()}`);
  });
  await row.getByRole("button", { name: "Remove" }).click();
  await row.waitFor({ state: "detached" });
  return `with no signature: 403; ${member} added by the passkey's signature, then removed`;
});

await run(
  "an owner's link and a member's keys: the link signs in a member who holds no passkey, a link made before is worth nothing once the member holds one, each takes the owner's passkey, and a removed member's key adds no event",
  async () => {
    const member = `proof-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const row = page.locator("li", { hasText: member });
    const form = (type: string) => page.locator(`form[data-signed$="${type}"]`);
    /** An owner's act on the member, by the page's own form and the owner's passkey: the page
     *  that comes back, as text. */
    const pressed = async (type: string, button: string) => {
      await page.goto(`${issuer}/members`);
      await form(type).getByLabel("The member's email").fill(member);
      // the page's script asks the passkey first, and posts the form when it has the statement
      const posted = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/members",
      );
      await form(type).getByRole("button", { name: button }).click();
      await posted;
      await page.waitForLoadState("load");
      return page.locator("body").innerText();
    };
    await page.goto(`${issuer}/members`);
    // a run that stopped in this step left its member: such a row goes first
    const left = page.locator("li", { hasText: /proof-[0-9a-f]{8}@example\.test/ });
    while (await left.count()) {
      const one = left.first();
      const address = /proof-[0-9a-f]{8}@example\.test/.exec(await one.innerText())![0];
      await one.getByRole("button", { name: "Remove" }).click();
      await page.locator("li", { hasText: address }).waitFor({ state: "detached" });
    }
    await page.getByLabel("Email", { exact: true }).fill(member);
    await page.getByRole("button", { name: "Add a member" }).click();
    await row.waitFor();
    // The session alone, as a script that stole it posts the page's own forms: no statement.
    for (const action of ["link", "remove-keys"]) {
      const bare = z
        .string()
        .parse(
          await page.evaluate(
            `fetch("/members", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: ${JSON.stringify(action)}, email: ${JSON.stringify(member)}, signed: "" }) }).then((answer) => answer.text())`,
          ),
        );
      must(
        bare.includes("This takes a press of your passkey"),
        `with the session alone, "${action}" was not refused`,
      );
    }
    // Two links while the member holds no passkey. The owner's passkey signs each.
    const linkOf = async () => {
      const said = await pressed("member-link-made", "Make a sign-in link");
      const link = /https:\/\/\S+\/keys\/first#[\w-]+/.exec(said)?.[0];
      must(link, `the page shows no link: ${said.slice(0, 200)}`);
      return link;
    };
    const [first, second] = [await linkOf(), await linkOf()];
    // The member, in a browser of their own with a key of their own: the first link signs in.
    const theirs = await browser.newContext();
    const theirPage = await theirs.newPage();
    theirPage.setDefaultTimeout(15_000);
    const theirCdp = await theirs.newCDPSession(theirPage);
    await theirCdp.send("WebAuthn.enable");
    await authenticator(theirCdp, "internal", true);
    await theirPage.goto(first);
    await theirPage.waitForURL(`${issuer}/keys`);
    const how = await addPasskey(theirPage, issuer, `proof member ${label.slice(6)}`);
    // The second link was never used. It was made for a member with no passkey, and this member
    // holds one now: in a third browser it signs nobody in.
    const elsewhere = await browser.newContext();
    const late = await elsewhere.newPage();
    await late.goto(second);
    await late.getByText("This link was used before").waitFor();
    await late.goto(`${issuer}/keys`);
    must(
      new URL(late.url()).pathname.startsWith("/sign-in"),
      `the link made before signed somebody in: at ${late.url()}`,
    );
    await elsewhere.close();
    // THE MEMBER'S PASSKEY ADDS AN EVENT WHILE THE ADDRESS IS A MEMBER, AND NONE ONCE THE OWNER
    // REMOVED THE MEMBER. Removal takes the member's row and leaves the passkey: a session removes
    // no key. So the key is live then, and its address is no member.
    const theirKey = z
      .object({ keys: z.array(z.object({ key: z.string(), credentialId: z.string().nullable() })) })
      .parse(await theirPage.evaluate(`fetch("/keys.json").then((answer) => answer.json())`))
      .keys.find((key) => key.credentialId);
    must(theirKey?.credentialId, "the member's passkey is not in /keys.json");
    /** A statement at a context of the proof, signed by the member's passkey in the member's
     *  browser, as the pages' own script signs one, and sent to the intake. */
    const stated = async (word: string) => {
      const now = Date.now();
      const statement = statementText({
        mind: domain,
        path: "/proof/statements",
        type: "events.iterate.com/test/said",
        payload: { word, member },
        at: now,
        expires: now + 60_000,
      });
      const signing = `(async () => {
        const b64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        const unb64u = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
        const assertion = await navigator.credentials.get({ publicKey: {
          challenge: unb64u(${JSON.stringify(await challengeOf(statement))}),
          rpId: location.hostname,
          userVerification: "required",
          allowCredentials: [{ type: "public-key", id: unb64u(${JSON.stringify(theirKey.credentialId)}) }],
        } });
        const { signature, authenticatorData, clientDataJSON } = assertion.response;
        const envelope = { statement: ${JSON.stringify(statement)}, signature: { format: "webauthn", key: ${JSON.stringify(theirKey.key)}, sig: b64u(signature), authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON) } };
        const answer = await fetch(${JSON.stringify(STATEMENTS_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
        return { status: answer.status, body: await answer.text() };
      })()`;
      return z
        .object({ status: z.number(), body: z.string() })
        .parse(await theirPage.evaluate(signing));
    };
    const asMember = await stated("as a member");
    must(asMember.status === 200, `a member's statement ended with ${JSON.stringify(asMember)}`);
    await page.goto(`${issuer}/members`);
    await row.getByRole("button", { name: "Remove" }).click();
    await row.waitFor({ state: "detached" });
    const removedMember = await stated("after the removal");
    // the owner adds the member again whatever came of it: the rest of the step needs the member
    await page.getByLabel("Email", { exact: true }).fill(member);
    await page.getByRole("button", { name: "Add a member" }).click();
    await row.waitFor();
    must(
      removedMember.status === 403 && removedMember.body.includes("is not a member here"),
      `a removed member's statement ended with ${JSON.stringify(removedMember).slice(0, 300)}`,
    );
    // And the owner makes no new one for this member.
    const refused = await pressed("member-link-made", "Make a sign-in link");
    must(
      refused.includes(`${member} has a passkey here`),
      `a link was made: ${refused.slice(0, 200)}`,
    );
    // The owner's passkey removes the member's keys: the member's session ends with them.
    const removed = await pressed("member-keys-removed", "Remove this member's keys");
    must(removed.includes(`${member} has no keys now`), `the keys stay: ${removed.slice(0, 200)}`);
    await theirPage.goto(`${issuer}/keys`);
    must(
      new URL(theirPage.url()).pathname.startsWith("/sign-in"),
      `the member is still signed in after the keys were removed: at ${theirPage.url()}`,
    );
    await theirs.close();
    await page.goto(`${issuer}/members`);
    await row.getByRole("button", { name: "Remove" }).click();
    await row.waitFor({ state: "detached" });
    return `with the session alone neither is done; the first link signed ${member} in and a passkey was added (${how}); the second link, made before, then signed nobody in; the member's passkey added an event, and none once the owner removed the member (${removedMember.body.slice(0, 90)}); no new link for a member with a passkey; the owner's passkey removed the member's keys and ended the member's session; the member is removed`;
  },
);

await run(
  "an app with access is listed on /keys with its mark and what it reaches, an owner sees it on the members page, and Revoke ends it: its refresh is refused",
  async () => {
    // A Codex CLI's sign-in to the mind's MCP server, as `codex mcp add` makes one: a client that
    // registers itself, a code that goes to a port of this computer, and PKCE.
    const goesTo = `127.0.0.1:${53_000 + Math.floor(Math.random() * 900)}`;
    const redirect = `http://${goesTo}/callback`;
    const resource = mindMcpUrlOf(domain);
    const answerOf = async (path: string, init: RequestInit) => {
      const answer = await fetch(`${issuer}${path}`, init);
      return { status: answer.status, body: (await answer.json().catch(() => ({}))) as unknown };
    };
    const registered = await answerOf("/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = z.object({ client_id: z.string() }).safeParse(registered.body).data?.client_id;
    must(client, `the client was not registered: ${JSON.stringify(registered).slice(0, 200)}`);
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    // Allow sends the browser to the port, where nothing listens: the proof reads the address.
    const sent = page.waitForRequest((request) => request.url().startsWith(redirect));
    await page.goto(
      `${issuer}/oauth2/auth?${new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
        scope: "iterate",
        state: crypto.randomUUID(),
      })}`,
    );
    await page
      .getByRole("button", { name: "Allow" })
      .click()
      .catch(() => undefined);
    const code = new URL((await sent).url()).searchParams.get("code");
    must(code, "the consent sent no code to the client");
    const Tokens = z.object({ access_token: z.string(), refresh_token: z.string() });
    const token = (fields: Record<string, string>) =>
      answerOf("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client, resource, ...fields }),
      });
    const first = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    const held = Tokens.safeParse(first.body).data;
    must(held, `the code gave no tokens: ${JSON.stringify(first).slice(0, 200)}`);
    // a call of the mind's MCP server with the token: what the app does with its access
    const reaches = async (accessToken: string) =>
      (
        await fetch(resource, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "passkey-sign-in-proof", version: "0" },
            },
          }),
        })
      ).status;
    const before = await reaches(held.access_token);
    must(before === 200, `the app's token did not reach the mind's MCP server: ${before}`);

    // /keys lists the client once: its mark and name, where its access went, and under it the
    // sign-in with what it reaches and Revoke. The list is read from a store that shows a new
    // entry within a minute, not at once.
    const row = page.locator("li.access", { hasText: goesTo });
    const listed = async (path: string, there: boolean) => {
      const from = Date.now();
      for (;;) {
        await page.goto(`${issuer}${path}`);
        if (Boolean(await row.count()) === there) return Math.round((Date.now() - from) / 1000);
        must(
          Date.now() - from < 90_000,
          `${path} ${there ? "does not list" : "still lists"} the app after 90 s`,
        );
        await page.waitForTimeout(3_000);
      }
    };
    const shownAfter = await listed("/keys", true);
    const words = (await row.innerText()).replace(/\s+/g, " ");
    for (const part of [
      "Codex",
      `access went to ${goesTo}.`,
      "Reaches the mind's MCP server: everything in this mind, as the member, since",
      "renews by use",
      "Revoke",
    ])
      must(words.includes(part), `the client does not say "${part}": ${words.slice(0, 300)}`);
    const mark = await row.locator(".tile").getAttribute("data-client-mark");
    must(mark === "known", `the mark for Codex is "${mark}", not a mark this stack knows`);
    const pictured = async (name: string) => {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await row.scrollIntoViewIfNeeded();
        const wider = z
          .number()
          .parse(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"));
        must(wider <= 0, `${name} is ${wider} px wider than ${width} px`);
        await page.screenshot({ path: join(shots, `${name}-${width}.png`) });
      }
    };
    await pictured("keys-access");
    // An owner sees it on the members page, with the member's address.
    await listed("/members", true);
    const theirs = (await row.innerText()).replace(/\s+/g, " ");
    must(/Codex of \S+@\S+/.test(theirs), `the members page says: ${theirs.slice(0, 200)}`);
    await pictured("members-access");
    // Revoke, on /keys: the grant and every token of it end.
    await listed("/keys", true);
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("heading", { name: "Apps and devices with access" }).waitFor();
    const revokedAt = Date.now();
    const refresh = await token({ grant_type: "refresh_token", refresh_token: held.refresh_token });
    must(
      refresh.status >= 400 && !Tokens.safeParse(refresh.body).success,
      `a refresh after Revoke ended with ${JSON.stringify(refresh).slice(0, 200)}`,
    );
    // how long the token it holds still reaches the mind: read once a second
    let after = await reaches(held.access_token);
    while (after !== 401 && Date.now() - revokedAt < 90_000) {
      await page.waitForTimeout(1_000);
      after = await reaches(held.access_token);
    }
    const tokenEnded = Math.round((Date.now() - revokedAt) / 1000);
    must(after === 401, `the app's token still reached the mind 90 s after Revoke: ${after}`);
    const goneAfter = await listed("/keys", false);
    return `"Codex", registered as codex mcp add does, was let in to the mind's MCP server; /keys listed the client ${shownAfter} s later with a known mark, where its access went and what its sign-in reaches, and the members page listed it with the member's address; no sideways scroll at 390 and 1280 px; after Revoke its refresh was refused at once (${refresh.status} ${JSON.stringify(refresh.body).slice(0, 80)}), its token, which reached the MCP server before, got 401 within ${tokenEnded} s, and the client was gone from the list ${goneAfter} s later`;
  },
);

if (env.ITERATE_PROTOTYPE_TOKEN)
  await run(
    "a person who is no member sees their own sign-ins at /sign-ins and ends one, and sees and ends nothing of another person's",
    async () => {
      // An app of the mind has users of its own on a stack whose sign-in is open to anyone
      // (`login.methods.email.anyone`). Each stranger has an address at the mind's own domain,
      // so the proof reads the mailed code in the mind's mail.
      const token = env.ITERATE_PROTOTYPE_TOKEN!;
      const app = `dash.${domain}`;
      const mailedCode = async (address: string) => {
        for (const from = Date.now(); Date.now() - from < 90_000;) {
          let after = 0;
          for (;;) {
            const read = await mindRoot(domain, token)
              .cd("/integrations/email")
              .readEvents(after, 500);
            const mail = (read.events as { type: string; payload: Record<string, unknown> }[]).find(
              (event) =>
                event.type === "events.iterate.com/email/received" &&
                JSON.stringify(event.payload.to).includes(address),
            );
            const code = /\b\d{6}\b/.exec(String(mail?.payload.text || ""))?.[0];
            if (code) return code;
            if (read.atHead || read.scannedThroughOffset <= after) break;
            after = read.scannedThroughOffset;
          }
          await page.waitForTimeout(3_000);
        }
        throw new Error(`no code arrived for ${address} within 90 s`);
      };
      const stranger = async (name: string) => {
        const address = `stranger-${name}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
        const theirs = await browser.newContext();
        const theirPage = await theirs.newPage();
        theirPage.setDefaultTimeout(20_000);
        // the app asks who the person is: the sign-in page, a mailed code, and back to the app
        await theirPage.goto(`https://${app}/`);
        await theirPage.getByLabel("Email").fill(address);
        await theirPage.getByRole("button", { name: "Send a code" }).click();
        await theirPage.getByLabel("Code").fill(await mailedCode(address));
        await theirPage.getByRole("button", { name: "Sign in" }).click();
        await theirPage.waitForURL((url) => url.host === app);
        const rows = theirPage.locator("li.access");
        /** Opens /sign-ins until it lists `count` clients: the list shows a new entry or an
         *  ended one within a minute. */
        const lists = async (count: number) => {
          for (const from = Date.now(); ; await theirPage.waitForTimeout(3_000)) {
            await theirPage.goto(`${issuer}/sign-ins`);
            if ((await rows.count()) === count) return;
            must(
              Date.now() - from < 90_000,
              `/sign-ins lists ${await rows.count()} clients for ${address}, not ${count}, after 90 s`,
            );
          }
        };
        return { address, theirs, theirPage, rows, lists };
      };
      const [first, second] = [await stranger("a"), await stranger("b")];
      // Each sees one client, the app, with one sign-in, and nothing else of /keys.
      await first.lists(1);
      await second.lists(1);
      const said = (await first.theirPage.locator("main").innerText()).replace(/\s+/g, " ");
      must(
        said.includes(first.address) && said.includes(app) && !said.includes(second.address),
        `/sign-ins says: ${said.slice(0, 300)}`,
      );
      must(!/passkey|Members/i.test(said), `/sign-ins shows more than sign-ins: ${said}`);
      for (const width of [390, 1280]) {
        await first.theirPage.setViewportSize({ width, height: 900 });
        await first.theirPage.screenshot({ path: join(shots, `sign-ins-${width}.png`) });
      }
      // /keys stays a member's page.
      await first.theirPage.goto(`${issuer}/keys`);
      const keys = (await first.theirPage.locator("main").innerText()).replace(/\s+/g, " ");
      must(keys.includes("not a member"), `/keys says to a stranger: ${keys.slice(0, 200)}`);
      // The second stranger names the first one's sign-in, as the page's own form would: it
      // ends nothing of another person's.
      await first.lists(1);
      const theirSignIn = await first.rows.locator("li[data-access]").getAttribute("data-access");
      must(theirSignIn, "the first stranger's sign-in has no id on the page");
      // with the second stranger's own session, and the page's origin as a form of it sends
      const posted = (
        await second.theirs.request.post(`${issuer}/sign-ins`, {
          form: { signIn: theirSignIn },
          headers: { origin: issuer },
          maxRedirects: 0,
        })
      ).status();
      await first.lists(1);
      // The first stranger signs out of the app: the list is empty, and the other's is whole.
      await first.rows.getByRole("button", { name: "Sign out", exact: true }).click();
      await first.lists(0);
      await second.lists(1);
      await first.theirs.close();
      await second.theirs.close();
      return `two strangers signed in to ${app} by a mailed code; each saw one client with one sign-in at /sign-ins and nothing else (no key, no member, not the other's address); /keys told a stranger that the address is not a member; the second stranger's post of the first one's sign-in (answer ${posted}) ended nothing; the first signed out and saw none, and the second still saw one`;
    },
  );

await run("signed out, the passkey signs in from the sign-in page", async () => {
  await context.clearCookies();
  await page.goto(`${issuer}/keys`);
  const signIn = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL(`${issuer}/keys`);
  await page.locator("li", { hasText: label }).waitFor();
  return `at /keys as the key's member, through ${signIn}`;
});

await run("an answer counts once", async () => {
  await context.clearCookies();
  await page.goto(`${issuer}/sign-in`);
  const [first, second] = await answersOf("required");
  must(first!.status === 200, `the first use answered ${first!.status}: ${first!.error}`);
  must(second!.status === 403, `the same answer again answered ${second!.status}`);
  return `200, then 403: ${second!.error}`;
});

await run("a passkey that did not verify its user signs nobody in", async () => {
  await context.clearCookies();
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const [answer] = await answersOf("discouraged");
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  must(answer!.status === 403, `it answered ${answer!.status}`);
  const cookies = await context.cookies(issuer);
  must(!cookies.some((cookie) => cookie.name === SESSION_COOKIE), "a session cookie was set");
  return `403: ${answer!.error}`;
});

await run("the passkey removed, its session ends and it signs nobody in", async () => {
  await context.clearCookies();
  await page.goto(`${issuer}/keys`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL(`${issuer}/keys`);
  await page.locator("li", { hasText: label }).getByRole("button", { name: "Remove" }).click();
  // the session was this passkey's, so it ends with it
  await page.waitForURL((url) => url.pathname.startsWith("/sign-in"));
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const refusal =
    (await page.locator("#passkey-status").filter({ hasText: /\./ }).textContent()) || "";
  must(refusal.includes("not one this mind knows"), `the page says ${refusal}`);
  // `/sign-in` on a stack with two ways to sign in, `/sign-in/email` with the mailed code alone
  must(new URL(page.url()).pathname.startsWith("/sign-in"), `at ${page.url()}`);
  return `its session ends, and ${refusal}`;
});

await browser.close();
console.log(`proven: ${step} of ${step}; the passkey "${label}" is removed`);
