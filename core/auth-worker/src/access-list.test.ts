import { expect, test, vi } from "vitest";
import { clientsWithAccess, type Ends, endFields, endsOf, logoOriginsOf } from "./access-list.ts";
import type { Env } from "./env.ts";
import { configVars } from "./test-support.ts";
import type { ClientWithAccess, SignIn } from "./oauth.ts";

test("a client is drawn once, with a summary, an all-N control, and each sign-in collapsed in details", () => {
  const html = render([clientOf([codex, older])]);
  const drawn = words(html);
  expect(drawn.match(/Codex/g)).toHaveLength(1);
  expect(drawn).toContain("Whole mind MCP goes to 127.0.0.1:53013 Latest 1 d ago");
  // one visible button ends all that the client holds, and the single sign-ins sit inside details
  expect(drawn).toContain("[Revoke all 2 client=client-1]");
  expect(html).toContain(`<details class="access-details">`);
  expect(drawn).toContain("2 sign-ins");
  expect(drawn).toContain("Used 1 d ago since 1 Nov ends 17 Nov if idle [Revoke signIn=grant-1]");
  expect(drawn).toContain("Used 1 d ago since 20 Oct ends 17 Nov if idle [Revoke signIn=grant-0]");
  expect(html).toContain(
    `<time datetime="2026-11-10T12:00:00Z" title="2026-11-10 12:00 UTC">1 d ago</time>`,
  );
});

test("a client with one sign-in has that sign-in's button alone and no details disclosure", () => {
  const html = render([clientOf([codex])]);
  const drawn = words(html);
  expect(html).toContain(`data-client="client-1" data-access="grant-1"`);
  expect(html).not.toContain("<details");
  expect(drawn).toContain("[Revoke signIn=grant-1]");
  expect(drawn).not.toContain("Revoke all");
});

test("each action control gets a full accessible label naming what it ends", () => {
  const labels: string[] = [];
  render(
    [clientOf([codex, older])],
    (ends, button, label) => {
      labels.push(`${button} -> ${label}`);
      return end(ends, button);
    },
    "jo@example.net",
  );
  expect(labels).toEqual([
    "Revoke -> Revoke Codex sign-in from 1 Nov of jo@example.net",
    "Revoke -> Revoke Codex sign-in from 20 Oct of jo@example.net",
    "Revoke all 2 -> Revoke all 2 sign-ins of Codex of jo@example.net",
  ]);
});

test("a device's sign-in, a let-in and one of the mind's own pages each say what they are", () => {
  const device = words(render([{ ...clientOf([codex]), name: "iterate CLI", device: true }]));
  expect(device).toContain("Device sign-in");
  // where a device's code went is this stack's own page, which says nothing
  expect(device).not.toContain("goes to");

  const letInSoon = {
    ...codex,
    renews: false,
    renewedAt: undefined,
    until: Date.UTC(2026, 10, 11, 15, 0),
  };
  const letInHtml = render([clientOf([letInSoon])]);
  expect(words(letInHtml)).toContain("until in 3 h no renewal");
  expect(letInHtml).toContain(`title="2026-11-11 15:00 UTC"`);

  const letInLater = { ...letInSoon, until: Date.UTC(2026, 10, 15, 14, 30) };
  expect(words(render([clientOf([letInLater])]))).toContain("until 15 Nov, 14:30 UTC no renewal");

  const browser: SignIn = {
    ...codex,
    clientName: "",
    host: "https://guestbook.example.com",
    resource: "https://guestbook.example.com",
    scopes: ["identity"],
    renews: false,
    renewedAt: undefined,
    endsAt: at("2026-11-12"),
  };
  const page = words(render([{ ...clientOf([browser]), name: "Guestbook", host: browser.host }]));
  expect(page).toContain("Guestbook Identity only guestbook.example.com This mind's page");
  expect(page).toContain("Signed in 1 Nov ends 12 Nov [Sign out signIn=grant-1]");
});

test("an owner's list names the member, and a name that a client gave is written as text", () => {
  const drawn = render(
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

const NOW = Date.parse("2026-11-11T12:00:00Z");
const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

function render(
  clients: ClientWithAccess[],
  endControl: (ends: Ends, button: string, label: string) => string = end,
  whose?: string,
) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    return clientsWithAccess(env, clients, endControl, whose);
  } finally {
    vi.useRealTimers();
  }
}
/** A form as the test reads it: its button's word and what it names. */
const end = (ends: { signIn: string } | { client: string }, button: string) =>
  `[${button} ${"signIn" in ends ? `signIn=${ends.signIn}` : `client=${ends.client}`}]`;
/** The list's words, with its tags taken out and the numbered entities written as characters. */
const words = (html: string) =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replaceAll(/\s+/g, " ")
    .trim();

// the cast: the list reads the mind's config and no binding
const env = configVars() as unknown as Env;

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
