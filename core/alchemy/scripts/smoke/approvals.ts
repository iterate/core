// ITERATE_SMOKE_APPROVER_KEY (a member's) and ITERATE_SMOKE_SERVICE_KEY (a service's): P-256 PKCS#8
// keys, base64url, whose public keys the stack's `auth.keys` names.
import {
  base64url,
  fromBase64url,
  keyIdOf,
  signedP256,
  type Statement,
  statementText,
} from "iterate/signed";
import { platformOriginOf } from "iterate/mind-api";
import { z } from "zod";
import { attempt, mindRoot, type Check } from "./lib.ts";

const PATH = "/secrets/smoke-approval";
const APPROVED = "events.iterate.com/secret/request-approved";
const RULE_CONFIGURED = "events.iterate.com/secret/approval-rule-configured";

export async function approvalChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  const origin = process.env.ITERATE_SMOKE_PETSHOP_ORIGIN;
  const memberKey = process.env.ITERATE_SMOKE_APPROVER_KEY;
  const serviceKey = process.env.ITERATE_SMOKE_SERVICE_KEY;
  if (!token || !origin || !memberKey || !serviceKey)
    return [
      skipped(
        "set ITERATE_PROTOTYPE_TOKEN, ITERATE_SMOKE_PETSHOP_ORIGIN, ITERATE_SMOKE_APPROVER_KEY and ITERATE_SMOKE_SERVICE_KEY",
      ),
    ];
  const root = () => mindRoot(domain, token);
  const member = await signerOf(domain, memberKey);
  const service = await signerOf(domain, serviceKey);
  const team = `TSMOKE${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const url = `${origin}/api/chat.postMessage`;
  const recorded = async () =>
    z
      .object({ messages: z.array(z.object({ text: z.string() }).loose()) })
      .parse(await (await fetch(`${origin}/__test-controls/slack/messages?team=${team}`)).json())
      .messages.map((message) => message.text);
  const post = (body: string) =>
    root()
      .run(
        `async (itx) => { const response = await itx.fetch(new Request(${JSON.stringify(url)}, { method: "POST", headers: { authorization: 'Bearer getSecret("${PATH}")', "content-type": "application/json" }, body: ${JSON.stringify(body)} })); const body = await response.json().catch(() => null); return { status: response.status, kind: response.headers.get("x-iterate-vault-answer"), ok: body?.ok ?? null }; }`,
      )
      .then((answer) =>
        z
          .object({ status: z.number(), kind: z.string().nullable(), ok: z.boolean().nullable() })
          .parse(answer),
      );
  const send = (text: string) => post(JSON.stringify({ channel: "smoke", text }));
  /** A held call is rejected, and its answer is the rejection. */
  const rejected = async (call: ReturnType<typeof post>, held: string | null) => {
    const signed = await member.post({
      path: PATH,
      type: "events.iterate.com/secret/request-rejected",
      about: [held || ""],
      payload: { reason: "the smoke check rejects it" },
    });
    const answer = await call;
    return {
      pass: !signed.error && answer.status === 403 && answer.kind === "rejected",
      detail: `${signed.error || "rejected"}; ${answer.status} ${answer.kind}`,
    };
  };
  const waiting = async (text: string) => {
    for (let tries = 0; tries < 20; tries += 1) {
      const fact = (await logOf()).findLast(
        (event) =>
          event.type === "events.iterate.com/secret/approval-requested" &&
          String((event.payload as { bodyStart?: unknown } | undefined)?.bodyStart).includes(text),
      );
      if (fact) return String((fact.payload as { digest: unknown }).digest);
      await new Promise((settle) => setTimeout(settle, 1000));
    }
    return null;
  };

  const ruled = await member
    .post({
      path: PATH,
      type: RULE_CONFIGURED,
      payload: { rule: { methods: ["POST"], hosts: [new URL(origin).hostname] } },
    })
    .catch((error: unknown) => ({ error: String(error) }));
  if (ruled.error === "the key is not one this mind knows")
    return [skipped(`the stack's auth.keys does not name the member's key ${member.key}`)];
  const first = `smoke ${crypto.randomUUID()}`;
  const second = `smoke ${crypto.randomUUID()}`;
  const third = `smoke ${crypto.randomUUID()}`;
  const named = `SMOKEHOLD${crypto.randomUUID().slice(0, 8)}`;
  let held: ReturnType<typeof send> | undefined;
  let settled = false;
  let digest: string | null = null;
  return [
    await attempt(`approvals: a rule on ${PATH}, signed by the member's key`, async () => {
      // the token first: the API's session is one round trip, and ends at the first await after it is made
      const tokenOfFake = await slackToken(origin, team);
      await root().secrets.set(PATH, tokenOfFake, { urls: [origin] });
      return { pass: !ruled.error, detail: ruled.error || `signed by ${member.key}` };
    }),
    await attempt(
      "approvals: a POST with the secret waits, its fact on the log at once",
      async () => {
        held = send(first);
        void held.then(() => (settled = true));
        digest = await waiting(first);
        const sent = await recorded();
        return {
          pass: Boolean(digest) && !settled && sent.length === 0,
          detail: `approval-requested: ${Boolean(digest)}; the call returned: ${settled}; the upstream saw ${sent.length}`,
        };
      },
    ),
    await attempt(
      "approvals: the member's signed approval sends it, once, with the real token",
      async () => {
        const approved = await member.post({ path: PATH, type: APPROVED, about: [digest || ""] });
        const answer = await held!;
        const sent = await recorded();
        return {
          pass:
            !approved.error && answer.status === 200 && answer.ok === true && sent.join() === first,
          detail: `${approved.error || "approved"}; ${answer.status}, ok ${answer.ok}; the upstream saw ${sent.length}`,
        };
      },
    ),
    await attempt("approvals: the same bytes again are refused, 409", async () => {
      const answer = await send(first);
      return {
        pass:
          answer.status === 409 && answer.kind === "sent-before" && (await recorded()).length === 1,
        detail: `${answer.status} ${answer.kind}`,
      };
    }),
    await attempt(
      "approvals: another body waits, and a service's key cannot approve it",
      async () => {
        held = send(second);
        digest = await waiting(second);
        const refused = await service.post({ path: PATH, type: APPROVED, about: [digest || ""] });
        return {
          pass: Boolean(digest) && Boolean(refused.error?.includes("member")),
          detail: `waits: ${Boolean(digest)}; the service's approval: ${refused.error || "accepted"}`,
        };
      },
    ),
    await attempt("approvals: a rejection answers 403, and nothing more is sent", async () => {
      const ended = await rejected(held!, digest);
      return { pass: ended.pass && (await recorded()).length === 1, detail: ended.detail };
    }),
    // A RULE THAT NAMES A STRING OF THE BODY: for an API that reads and acts through one address.
    await attempt(
      "approvals: a rule that names a string of the body lets a POST without it go at once",
      async () => {
        const signed = await member.post({
          path: PATH,
          type: RULE_CONFIGURED,
          payload: {
            rule: { methods: ["POST"], hosts: [new URL(origin).hostname], jsonStrings: [named] },
          },
        });
        const answer = await send(third);
        const sent = await recorded();
        return {
          pass:
            !signed.error && answer.status === 200 && answer.ok === true && sent.includes(third),
          detail: `${signed.error || `the rule names ${named}`}; ${answer.status}, ok ${answer.ok}; the upstream saw ${sent.length}`,
        };
      },
    ),
    await attempt("approvals: a POST whose body holds the string waits", async () => {
      const text = `smoke ${crypto.randomUUID()} with ${named.toLowerCase()} inside`;
      const call = send(text);
      const ended = await rejected(call, await waiting(text));
      return { pass: ended.pass && (await recorded()).length === 2, detail: ended.detail };
    }),
    await attempt("approvals: a POST whose body is not JSON waits too", async () => {
      const body = `not JSON ${crypto.randomUUID()}`;
      const call = post(body);
      const ended = await rejected(call, await waiting(body));
      return { pass: ended.pass && (await recorded()).length === 2, detail: ended.detail };
    }),
  ];

  async function logOf() {
    const events: { type: string; payload?: unknown }[] = [];
    for (let after = 0; ;) {
      const page = await root().cd(PATH).readEvents(after, 500);
      events.push(...page.events);
      if (page.atHead || page.scannedThroughOffset <= after) return events;
      after = page.scannedThroughOffset;
    }
  }
}

function skipped(why: string): Check {
  return {
    check: "approvals: a POST waits for a signed approval",
    pass: true,
    detail: `skipped: ${why}`,
  };
}

/** A software key of the stack's `auth.keys`: `sign` makes a statement's envelope, `post` sends one
 *  to the vault. */
export async function signerOf(domain: string, pkcs8: string) {
  const curve = { name: "ECDSA", namedCurve: "P-256" } as const;
  const privateKey = await crypto.subtle.importKey("pkcs8", fromBase64url(pkcs8), curve, true, [
    "sign",
  ]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, curve, true, [
    "verify",
  ]);
  const key = await keyIdOf(
    base64url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey))),
  );
  type Fields = Pick<Statement, "path" | "type" | "about" | "payload">;
  const sign = (fields: Fields) => {
    const now = Date.now();
    const statement = statementText({
      mind: domain,
      ...fields,
      at: now,
      expires: now + 300_000,
    });
    return signedP256(statement, privateKey, key);
  };
  return {
    key,
    sign,
    post: async (fields: Fields) => {
      const answer = await fetch(`${platformOriginOf(domain)}/secrets/approvals/statements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await sign(fields)),
      });
      return z
        .object({ error: z.string().optional() })
        .parse(await answer.json().catch(() => ({ error: `answered ${answer.status}` })));
    },
  };
}

export async function slackToken(origin: string, team: string): Promise<string> {
  const redirectUri = "https://smoke.invalid/callback";
  const client = z.object({ client_id: z.string(), client_secret: z.string() }).parse(
    await (
      await fetch(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      })
    ).json(),
  );
  const authorize = new URL(`${origin}/oauth/v2/authorize`);
  authorize.searchParams.set("client_id", client.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("team", team);
  authorize.searchParams.set("state", "smoke");
  const code = new URL(
    (await fetch(authorize, { redirect: "manual" })).headers.get("location") || "",
  ).searchParams.get("code");
  const answer = z.object({ access_token: z.string() }).parse(
    await (
      await fetch(`${origin}/api/oauth.v2.access`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          client_secret: client.client_secret,
          code: code || "",
          redirect_uri: redirectUri,
        }),
      })
    ).json(),
  );
  return answer.access_token;
}
