import { expect, test } from "vitest";
import {
  canonicalPath,
  cloudNameRefusal,
  honouredNext,
  otherKeyLending,
  scopeInWords,
  scopePlainly,
  allowsExactly,
  enrolPayloadOf,
  serviceKeyRequestOf,
  type StatementPart,
  statementInParts,
  underPaths,
} from "./key-rules.ts";

const ISSUER = "https://iterate.example.com";
const TRUSTED = ["https://cloud.example.net"];

test.each([
  ["/keys?x=1", "/keys?x=1"],
  [`${ISSUER}/keys/enrol?actor=cloud`, "/keys/enrol?actor=cloud"],
  [
    "https://cloud.example.net/connected?d=example.com",
    "https://cloud.example.net/connected?d=example.com",
  ],
  ["https://onboarding.example.com/", "https://onboarding.example.com/"],
  ["https://example.com/welcome", "https://example.com/welcome"],
  ["http://onboarding.example.com/", null],
  ["https://onboarding.example.com.evil.example/", null],
  ["https://evilexample.com/", null],
  ["https://evil.example/", null],
  ["//evil.example/", null],
  ["/\\evil.example/", null],
  ["javascript:alert(1)", null],
  ["http://cloud.example.net/", null],
  ["", null],
  [null, null],
])("next %s is honoured as %s", (next, honoured) => {
  expect(honouredNext(next, ISSUER, TRUSTED)).toBe(honoured);
});

test("a key confined to paths reaches only under them; an unconfined key reaches every path", () => {
  expect(underPaths("/integrations/github", ["/integrations/"])).toBe(true);
  expect(underPaths("/agents/x", ["/integrations/"])).toBe(false);
  expect(underPaths("/agents/x", undefined)).toBe(true);
  expect(underPaths("/smokey/x", ["/smoke"])).toBe(false);
  expect(underPaths("/smoke", ["/smoke/"])).toBe(true);
  expect(underPaths("/anything", ["/"])).toBe(true);
});

test("a service's request names a plain actor, a label, a key and at least one path", () => {
  const ask = (query: Record<string, string>) => serviceKeyRequestOf(new URLSearchParams(query));
  const good = {
    actor: "cloud",
    label: "iterate Cloud",
    publicKey: "abc_-1",
    paths: "/integrations/, /integrations/x",
  };
  expect(ask(good)).toEqual({
    actor: "cloud",
    label: "iterate Cloud",
    publicKey: "abc_-1",
    paths: ["/integrations/", "/integrations/x"],
  });
  expect(ask({ ...good, actor: "user_abc" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "integrations/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/integrations/, /agents/" })).toHaveProperty("refused");
  expect(ask({ ...good, paths: "/integrations/../secrets/" })).toHaveProperty("refused");
  expect(ask({ ...good, label: "" })).toHaveProperty("refused");
  expect(ask({ ...good, publicKey: "not base64url!" })).toHaveProperty("refused");
});

test("a service's key may lend one capability, with or without paths, and must ask for something", () => {
  const ask = (query: Record<string, string>) => serviceKeyRequestOf(new URLSearchParams(query));
  const bridge = { actor: "bridge-whatsapp", label: "whatsapp on beelink", publicKey: "abc_-1" };
  expect(ask({ ...bridge, provide: "whatsapp.jonas" })).toEqual({
    ...bridge,
    paths: [],
    provide: "whatsapp.jonas",
  });
  expect(ask({ ...bridge, provide: "whatsapp", paths: "/integrations/whatsapp/" })).toEqual({
    ...bridge,
    paths: ["/integrations/whatsapp/"],
    provide: "whatsapp",
  });
  expect(ask(bridge)).toHaveProperty("refused");
  for (const provide of ["secrets.get()", "whats app", "a..b", ".a", "9lives", "a/b"])
    expect(ask({ ...bridge, provide })).toHaveProperty("refused");
  // the paths rule holds beside a capability too
  expect(ask({ ...bridge, provide: "whatsapp", paths: "/agents/" })).toHaveProperty("refused");
  // a name of the platform's own: a lent stub there would get what the mind sends to it
  for (const provide of ["secrets", "secrets.set", "fetch", "email", "repos", "run", "config.x"])
    expect(ask({ ...bridge, provide })).toMatchObject({
      refused: expect.stringContaining("that name is this mind's own"),
    });
});

test("a key's scope reads as what its service can do", () => {
  expect(scopeInWords({ paths: [], provide: "whatsapp" })).toBe(
    "lend its functions to this mind as itx.whatsapp",
  );
  expect(scopeInWords({ paths: ["/integrations/x/"], provide: "x" })).toBe(
    "lend its functions to this mind as itx.x, and add events under /integrations/x/",
  );
  expect(scopeInWords({ paths: ["/integrations/"] })).toBe("add events under /integrations/");
});

test("the consent page's first words say what the key's holder can and cannot do, and name nobody", () => {
  expect(scopePlainly({ paths: ["/integrations/minds/iterate.com/"] }, "example.com")).toBe(
    "This lets whoever holds this key send messages to one place in example.com. It cannot read anything, approve requests or reach an agent.",
  );
  expect(scopePlainly({ paths: ["/integrations/a/", "/integrations/b/"] }, "example.com")).toBe(
    "This lets whoever holds this key send messages to 2 places in example.com. It cannot read anything, approve requests or reach an agent.",
  );
  expect(scopePlainly({ paths: [], provide: "whatsapp" }, "example.com")).toBe(
    "This lets whoever holds this key offer its functions to the agents of example.com. It cannot approve requests, and it reads nothing but what the agents send it.",
  );
  expect(scopePlainly({ paths: ["/integrations/x/"], provide: "x" }, "example.com")).toBe(
    "This lets whoever holds this key offer its functions to the agents of example.com, and send messages to one place in example.com. It cannot approve requests, and it reads nothing but what the agents send it.",
  );
});

test("a name another live key lends is held; the same key, another name and no name are not", () => {
  const whatsapp = { id: "key-a", label: "WhatsApp on a server", provide: "whatsapp", added_at: 1 };
  const jonas = { id: "key-b", label: "A phone", provide: "whatsapp.jonas", added_at: 2 };
  const lending = [whatsapp, jonas];
  expect(otherKeyLending(lending, "key-c", "whatsapp")).toBe(whatsapp);
  expect(otherKeyLending(lending, "key-c", "whatsapp.jonas")).toBe(jonas);
  // the key that holds a name asks again: a member allows it anew after a removal
  expect(otherKeyLending(lending, "key-a", "whatsapp")).toBeNull();
  expect(otherKeyLending(lending, "key-c", "whatsapp.leah")).toBeNull();
  expect(otherKeyLending(lending, "key-c", "herdr")).toBeNull();
  // a key that only adds events asks for no name
  expect(otherKeyLending(lending, "key-c", undefined)).toBeNull();
});

test("the Cloud's name goes to the key the stack's own Cloud publishes, and to no other", () => {
  const cloud = { origin: "https://cloud.example.net", publicKey: "cloud-key" };
  expect(cloudNameRefusal("cloud-key", cloud)).toBeNull();
  expect(cloudNameRefusal("a-stranger's-key", cloud)).toMatch(/not the key of https:\/\/cloud/);
  expect(cloudNameRefusal("cloud-key", { ...cloud, publicKey: null })).toMatch(/gave no key/);
  expect(cloudNameRefusal("cloud-key", null)).toMatch(/names none/);
});

test("a statement names a context by its own path, with no segment the mind would resolve", () => {
  for (const path of ["/", "/integrations/github", "/integrations/github/88001101", "/a.b/c..d"])
    expect(canonicalPath(path)).toBe(true);
  for (const path of [
    "/integrations/../secrets/x",
    "/integrations/./github",
    "/integrations//github",
    "/integrations/github/",
    "/integrations/github/..",
    "integrations/github",
    "",
  ])
    expect(canonicalPath(path)).toBe(false);
});

test("a member's signature allows a service's key only for that key, that reach and that label", () => {
  const ask = {
    actor: "bridge-whatsapp",
    label: "WhatsApp",
    publicKey: "MFkw",
    paths: ["/integrations/whatsapp/"],
    provide: "whatsapp",
  };
  const signed = enrolPayloadOf("key-1", ask);
  expect(signed).toEqual({
    key: "key-1",
    actor: "bridge-whatsapp",
    label: "WhatsApp",
    paths: ["/integrations/whatsapp/"],
    provide: "whatsapp",
  });
  expect([
    allowsExactly(signed, "key-1", ask),
    // signed for a key that only adds events: it lends nothing
    allowsExactly(enrolPayloadOf("key-1", { ...ask, provide: undefined }), "key-1", ask),
    allowsExactly(signed, "key-2", ask),
    allowsExactly(signed, "key-1", { ...ask, actor: "bridge-other" }),
    allowsExactly(signed, "key-1", { ...ask, paths: ["/integrations/"] }),
    allowsExactly(signed, "key-1", { ...ask, provide: "whatsapp.jonas" }),
    // the page showed another label than the one the link now gives
    allowsExactly(signed, "key-1", { ...ask, label: "WhatsApp for Jonas" }),
    // the statement that adds a person's passkey names a key and nothing more
    allowsExactly({ key: "key-1" }, "key-1", ask),
  ]).toEqual([true, false, false, false, false, false, false, false]);
});

const FACTS = { domain: "example.com", key: "keyaaaaabbbbbccccc", person: "member@example.net" };
const ASK = { actor: "bridge-github", label: "GitHub", publicKey: "MFkw", paths: [] };

test("the statement for a key that adds events names its one context, and where the link speaks", () => {
  expect(marked(statementInParts({ ...ASK, paths: ["/integrations/github/"] }, FACTS))).toEqual([
    "I, {you:member@example.net}, let key {checked:keyaaaaa} add events to the context {checked:/integrations/github/} and the contexts under it, in {checked:example.com}, until a member removes it.",
    "Each event that it adds shows the name {link:bridge-github} and this key.",
    "The link says that the key belongs to {link:“GitHub”}.",
  ]);
});

test("the statement for a key that adds events to two contexts names both", () => {
  const ask = { ...ASK, paths: ["/integrations/github/", "/integrations/linear/"] };
  expect(marked(statementInParts(ask, FACTS))[0]).toBe(
    "I, {you:member@example.net}, let key {checked:keyaaaaa} add events to the contexts {checked:/integrations/github/} and {checked:/integrations/linear/} and the contexts under them, in {checked:example.com}, until a member removes it.",
  );
  const three = { ...ask, paths: [...ask.paths, "/integrations/slack/"] };
  expect(marked(statementInParts(three, FACTS))[0]).toContain(
    "{checked:/integrations/github/}, {checked:/integrations/linear/} and {checked:/integrations/slack/} and the contexts under them",
  );
});

test("the statement for a key that lends says that its holder sees what the agents send, and takes the name when its lend ends", () => {
  expect(marked(statementInParts({ ...ASK, provide: "github" }, FACTS))).toEqual([
    "I, {you:member@example.net}, let key {checked:keyaaaaa} lend its functions to {checked:example.com} as {checked:itx.github}, until a member removes it.",
    "The agents of {checked:example.com} call them, so the key's holder sees what they send.",
    "If {checked:itx.github} is lent to {checked:example.com} now, the key's holder takes it when that lend ends.",
    "The link says that the key belongs to {link:“GitHub”}.",
  ]);
});

test("the statement for a key that lends and adds events says both in its first sentence", () => {
  const ask = { ...ASK, paths: ["/integrations/github/"], provide: "github" };
  expect(marked(statementInParts(ask, FACTS))).toEqual([
    "I, {you:member@example.net}, let key {checked:keyaaaaa} lend its functions to {checked:example.com} as {checked:itx.github}, and add events to the context {checked:/integrations/github/} and the contexts under it, until a member removes it.",
    "The agents of {checked:example.com} call them, so the key's holder sees what they send.",
    "If {checked:itx.github} is lent to {checked:example.com} now, the key's holder takes it when that lend ends.",
    "Each event that it adds shows the name {link:bridge-github} and this key.",
    "The link says that the key belongs to {link:“GitHub”}.",
  ]);
});

test("the statement for the iterate Cloud's key says that the mind checked the key", () => {
  const ask = { ...ASK, actor: "iterate-cloud", label: "iterate Cloud", paths: ["/integrations/"] };
  expect(marked(statementInParts(ask, FACTS)).slice(-2)).toEqual([
    "{checked:example.com} checked that this is the key of its iterate Cloud.",
    "The link says that the key belongs to {link:“iterate Cloud”}.",
  ]);
});

test("the label and the actor are the link's words; the key, the contexts, the lent name and the domain are checked", () => {
  const ask = { ...ASK, paths: ["/integrations/github/"], provide: "github" };
  const parts = statementInParts(ask, FACTS).flat();
  const from = (kind: StatementPart["from"]) =>
    new Set(parts.filter((part) => part.from === kind).map((part) => part.text));
  expect(from("link")).toEqual(new Set(["bridge-github", "“GitHub”"]));
  expect(from("checked")).toEqual(
    new Set(["keyaaaaa", "/integrations/github/", "itx.github", "example.com"]),
  );
  expect(from("you")).toEqual(new Set(["member@example.net"]));
});

/** The statement as text, each part that is not plain words marked `{from:text}`. */
function marked(sentences: StatementPart[][]) {
  return sentences.map((sentence) =>
    sentence.map((part) => (part.from ? `{${part.from}:${part.text}}` : part.text)).join(""),
  );
}
