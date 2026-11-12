import { expect, test } from "vitest";
import { clientsWithAccess, endFields, endsOf, logoOriginsOf } from "./access-list.ts";
import type { Env } from "./env.ts";
import type { ClientWithAccess, SignIn } from "./oauth.ts";

test("a client is drawn once, with each sign-in it holds under it: what it reaches, since when, when it was last used and when it ends", () => {
  const drawn = words(clientsWithAccess(env, [clientOf([codex, older])], end));
  expect(drawn.match(/Codex/g)).toHaveLength(1);
  expect(drawn).toContain("access went to 127.0.0.1:53013.");
  expect(drawn).toContain(
    "Reaches the mind's MCP server: everything in this mind, as the member, since 2026-11-01, last used 2026-11-10, renews by use: it ends 2026-11-17 if it is not used. [Revoke signIn=grant-1]",
  );
  expect(drawn).toContain("since 2026-10-20, last used 2026-11-10, renews by use");
  expect(drawn).toContain("[Revoke signIn=grant-0]");
  // one button ends all that the client holds
  expect(drawn).toContain("[Revoke all 2 client=client-1]");
});

test("a client with one sign-in has that sign-in's button alone", () => {
  const drawn = words(clientsWithAccess(env, [clientOf([codex])], end));
  expect(drawn).toContain("[Revoke signIn=grant-1]");
  expect(drawn).not.toContain("Revoke all");
});

test("a device's sign-in, a let-in and one of the mind's own pages each say what they are", () => {
  const device = words(
    clientsWithAccess(env, [{ ...clientOf([codex]), name: "iterate CLI", device: true }], end),
  );
  expect(device).toContain("a device or a CLI, signed in by a code.");
  // where a device's code went is this stack's own page, which says nothing
  expect(device).not.toContain("access went to");

  const letIn = {
    ...codex,
    renews: false,
    renewedAt: undefined,
    until: Date.UTC(2026, 10, 1, 14, 30),
  };
  expect(words(clientsWithAccess(env, [clientOf([letIn])], end))).toContain(
    "let in until 2026-11-01 14:30 UTC: it cannot renew this.",
  );

  const browser: SignIn = {
    ...codex,
    clientName: "",
    host: "https://guestbook.example.com",
    resource: "https://guestbook.example.com",
    scopes: ["identity"],
    renews: false,
    renewedAt: undefined,
    endsAt: at("2026-11-02"),
  };
  const page = words(
    clientsWithAccess(
      env,
      [{ ...clientOf([browser]), name: "guestbook.example.com", host: browser.host }],
      end,
    ),
  );
  expect(page).toContain("guestbook.example.com one of this mind's own pages");
  expect(page).toContain(
    "Reaches guestbook.example.com: who the person is, and no more, since 2026-11-01, ends 2026-11-02. [Sign out signIn=grant-1]",
  );
});

test("an owner's list names the member, and a name that a client gave is written as text", () => {
  const drawn = clientsWithAccess(
    env,
    [{ ...clientOf([codex]), name: '<img src=x onerror="alert(1)">' }],
    end,
    "jo@example.net",
  );
  expect(drawn).not.toContain("<img src=x");
  expect(words(drawn)).toContain("of jo@example.net");
});

test("a page allows a picture from a verified client's own domain alone", () => {
  const verified = {
    ...clientOf([codex]),
    clientDomain: "app.example.org",
    logoUri: "https://app.example.org/logo.png",
  };
  // a logo with no verified domain, and one on another domain, are not shown
  const claimed = { ...clientOf([codex]), logoUri: "https://app.example.org/logo.png" };
  const elsewhere = { ...verified, logoUri: "https://cdn.example.net/logo.png" };
  expect(logoOriginsOf([verified, claimed, elsewhere])).toBe("https://app.example.org");
  expect(logoOriginsOf([claimed, elsewhere])).toBeUndefined();
});

test("one of the mind's own apps has its own name and icon, from its own host alone, and never a brand's mark", () => {
  const app = {
    ...clientOf([codex]),
    name: "Guestbook",
    host: "https://guestbook.example.com",
    logoUri: "https://guestbook.example.com/icon.svg",
  };
  const drawn = clientsWithAccess(env, [app], end);
  expect(drawn).toContain(
    `<div class="tile small" data-app-mark="icon"><img src="https://guestbook.example.com/icon.svg" alt="" referrerpolicy="no-referrer"></div>`,
  );
  expect(words(drawn)).toContain("Guestbook");
  expect(logoOriginsOf([app])).toBe("https://guestbook.example.com");
  // an icon elsewhere is not the app's own: its initials, and no origin for the page to allow
  const elsewhere = { ...app, logoUri: "https://cdn.example.net/icon.svg" };
  expect(clientsWithAccess(env, [elsewhere], end)).toContain(
    `<div class="tile small" data-app-mark="initials">GU</div>`,
  );
  expect(logoOriginsOf([elsewhere])).toBeUndefined();
  // an app of the mind that calls itself Codex is not OpenAI's
  expect(clientsWithAccess(env, [{ ...app, name: "Codex", logoUri: undefined }], end)).toContain(
    `<div class="tile small" data-app-mark="initials">CO</div>`,
  );
});

test("a form names one sign-in or all of one client, and a form that names neither ends nothing", () => {
  const posted = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return endsOf(form);
  };
  expect(posted({ signIn: "g1" })).toEqual({ signIn: "g1" });
  expect(posted({ client: "c1" })).toEqual({ client: "c1" });
  expect(posted({ other: "x" })).toBeNull();
  expect(endsOf(null)).toBeNull();
  expect(endFields({ client: 'c"1' })).toBe('<input type="hidden" name="client" value="c&#34;1">');
});

const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
/** A form as the test reads it: its button's word and what it names. */
const end = (ends: { signIn: string } | { client: string }, button: string) =>
  `[${button} ${"signIn" in ends ? `signIn=${ends.signIn}` : `client=${ends.client}`}]`;
/** The list's words, with its tags taken out and the numbered entities written as characters. */
const words = (html: string) =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replaceAll(/\s+/g, " ")
    .replaceAll(" ,", ",")
    .replaceAll(" .", ".");

// the cast: the list reads the mind's domain and no binding
const env = {
  DOMAIN: "example.com",
  AUTH_SETTINGS: JSON.stringify({ login: { allow: [{ email: "owner@example.net" }] } }),
} as unknown as Env;

/** A Codex CLI's sign-in to the mind's MCP server, renewed nine days after it was made. */
const codex: SignIn = {
  id: "grant-1",
  userId: "user_1",
  clientId: "client-1",
  clientName: "Codex",
  resource: "https://iterate.example.com/mcp",
  redirectUri: "http://127.0.0.1:53013/callback",
  goesTo: "127.0.0.1:53013",
  device: false,
  scopes: ["iterate"],
  createdAt: at("2026-11-01"),
  endsAt: at("2026-11-17"),
  renews: true,
  renewedAt: at("2026-11-10"),
};
const older: SignIn = { ...codex, id: "grant-0", createdAt: at("2026-10-20") };

/** The client that holds these sign-ins, as `sessionsByClientOf` groups them. */
function clientOf(signIns: SignIn[]): ClientWithAccess {
  const [newest] = signIns;
  return {
    clientId: newest!.clientId,
    name: newest!.clientName,
    redirectUri: newest!.redirectUri,
    goesTo: newest!.goesTo,
    device: newest!.device,
    signIns,
  };
}
