import { expect, test } from "vitest";
import {
  canonicalPath,
  honouredNext,
  otherKeyLending,
  scopeInWords,
  scopePlainly,
  allowsExactly,
  enrolPayloadOf,
  serviceKeyRequestOf,
  type StatementPart,
  type StatementRow,
  statementRows,
  underPaths,
} from "./key-rules.ts";

const CONFIG = {
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com", "second.example"],
};

test.each([
  // the answer is the whole address that was checked, never a path cut out of it
  ["/keys?x=1", "https://iterate.example.com/keys?x=1"],
  [
    "https://iterate.example.com/keys/enrol?actor=cloud",
    "https://iterate.example.com/keys/enrol?actor=cloud",
  ],
  ["https://iterate.example.com//evil.example/", "https://iterate.example.com//evil.example/"],
  // a network-path reference is the host it names
  ["//shop.second.example/a", "https://shop.second.example/a"],
  ["blob:https://iterate.example.com/a-page", null],
  ["https://user@example.com/", null],
  ["https://example.com:8443/", null],
  ["https://onboarding.example.com/", "https://onboarding.example.com/"],
  ["https://example.com/welcome", "https://example.com/welcome"],
  // every zone of the mind is the owner's own site
  ["https://second.example/welcome", "https://second.example/welcome"],
  ["https://shop.second.example/?a=1", "https://shop.second.example/?a=1"],
  ["http://onboarding.example.com/", null],
  ["http://second.example/", null],
  ["https://onboarding.example.com.evil.example/", null],
  ["https://evilexample.com/", null],
  ["https://notsecond.example/", null],
  ["https://cloud.example.net/connected", null],
  ["https://evil.example/", null],
  ["//evil.example/", null],
  ["/\\evil.example/", null],
  ["javascript:alert(1)", null],
  ["", null],
  [null, null],
])("next %s is honoured as %s", (next, honoured) => {
  expect(honouredNext(next, CONFIG)).toBe(honoured);
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
    "lend its functions to this mind as itx.x, and add events at /integrations/x/ and below",
  );
  expect(scopeInWords({ paths: ["/integrations/"] })).toBe(
    "add events at /integrations/ and below",
  );
});

test("the consent page's first words say what the key's holder can and cannot do, and name nobody", () => {
  expect(scopePlainly({ paths: ["/integrations/minds/iterate.com/"] })).toBe(
    "Whoever holds this key can send messages to one place in this mind. It cannot read anything, approve requests or reach an agent.",
  );
  expect(scopePlainly({ paths: ["/integrations/a/", "/integrations/b/"] })).toBe(
    "Whoever holds this key can send messages to 2 places in this mind. It cannot read anything, approve requests or reach an agent.",
  );
  expect(scopePlainly({ paths: [], provide: "whatsapp" })).toBe(
    "Whoever holds this key can offer its functions to this mind's agents. It cannot approve requests, and it reads only what the agents send it.",
  );
  expect(scopePlainly({ paths: ["/integrations/x/"], provide: "x" })).toBe(
    "Whoever holds this key can offer its functions to this mind's agents, and send messages to one place in this mind. It cannot approve requests, and it reads only what the agents send it.",
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

test("the name iterate-cloud goes only with an iterate Cloud's https origin, and that origin goes with that name alone, under /integrations/", () => {
  const ask = (fields: Record<string, string>) =>
    serviceKeyRequestOf(
      new URLSearchParams({
        actor: "iterate-cloud",
        label: "iterate Cloud",
        publicKey: "abc_-1",
        paths: "/integrations/",
        ...fields,
      }),
    );
  expect(ask({ cloud: "https://cloud.example.com" })).toEqual({
    actor: "iterate-cloud",
    label: "iterate Cloud",
    publicKey: "abc_-1",
    paths: ["/integrations/"],
    cloud: "https://cloud.example.com",
  });
  const refusals = {
    noCloud: ask({}),
    anotherActor: ask({ actor: "a-service", cloud: "https://cloud.example.com" }),
    plainHttp: ask({ cloud: "http://cloud.example.com" }),
    aPath: ask({ cloud: "https://cloud.example.com/x" }),
    aSlash: ask({ cloud: "https://cloud.example.com/" }),
    aUser: ask({ cloud: "https://a@cloud.example.com" }),
    aLend: ask({ cloud: "https://cloud.example.com", provide: "whatsapp" }),
    outsideIntegrations: ask({ cloud: "https://cloud.example.com", paths: "/secrets/" }),
  };
  expect(refusals).toEqual({
    noCloud: { refused: expect.stringContaining("names no address (cloud)") },
    anotherActor: { refused: "The field cloud goes only with the name iterate-cloud." },
    plainHttp: { refused: expect.stringContaining("must be an https address with no path") },
    aPath: { refused: expect.stringContaining("must be an https address with no path") },
    aSlash: { refused: expect.stringContaining("must be an https address with no path") },
    aUser: { refused: expect.stringContaining("must be an https address with no path") },
    aLend: { refused: "iterate Cloud's key adds events: it lends no capability." },
    outsideIntegrations: { refused: "The service may add events under /integrations/ alone." },
  });
});

test("a member's signature for iterate Cloud's key names the Cloud's origin, and allows that origin alone; another service's payload is what it was", () => {
  const cloud = {
    actor: "iterate-cloud",
    label: "iterate Cloud",
    publicKey: "pk",
    paths: ["/integrations/"],
    cloud: "https://cloud.example.com",
  };
  const signed = enrolPayloadOf("key-a", cloud);
  expect(signed).toMatchObject({ cloud: "https://cloud.example.com" });
  expect(allowsExactly(signed, "key-a", cloud)).toBe(true);
  expect(allowsExactly(signed, "key-a", { ...cloud, cloud: "https://other.example.com" })).toBe(
    false,
  );
  const { cloud: _, ...withoutCloud } = signed;
  expect(allowsExactly(withoutCloud, "key-a", cloud)).toBe(false);
  const service = { actor: "a-service", label: "A", publicKey: "pk", paths: ["/integrations/a/"] };
  expect(enrolPayloadOf("key-b", service)).toEqual({
    key: "key-b",
    actor: "a-service",
    label: "A",
    paths: ["/integrations/a/"],
    provide: null,
  });
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

const FACTS = { mind: "example.com", key: "keyaaaaabbbbbccccc", person: "member@example.net" };
const ASK = { actor: "bridge-github", label: "GitHub", publicKey: "MFkw", paths: [] };

/** The rows that every key's statement ends with: the mind, the member who allows it, and until when. */
const LAST_ROWS = [
  "In the mind: {checked:example.com}",
  "Allowed by: {you:member@example.net}",
  "Until: a member removes it",
];

test("the statement for a key that adds events names its one context, and where the link speaks", () => {
  expect(marked(statementRows({ ...ASK, paths: ["/integrations/github/"] }, FACTS))).toEqual([
    "Key: {checked:keyaaaaa}",
    "Belongs to: {link:“GitHub”} / The link says so.",
    "Adds events at: {checked:/integrations/github/} and below / Its events show the name {link:bridge-github} and this key.",
    ...LAST_ROWS,
  ]);
});

test("the statement for a key that adds events to two contexts names both", () => {
  const ask = { ...ASK, paths: ["/integrations/github/", "/integrations/linear/"] };
  const adds = (rows: StatementRow[]) =>
    marked(rows).find((row) => row.startsWith("Adds events at: "));
  expect(adds(statementRows(ask, FACTS))).toBe(
    "Adds events at: {checked:/integrations/github/} and {checked:/integrations/linear/} and below / Its events show the name {link:bridge-github} and this key.",
  );
  const three = { ...ask, paths: [...ask.paths, "/integrations/slack/"] };
  expect(adds(statementRows(three, FACTS))).toContain(
    "Adds events at: {checked:/integrations/github/}, {checked:/integrations/linear/} and {checked:/integrations/slack/} and below / ",
  );
});

test("the statement for a key that lends says that its holder sees what the agents send, and takes the name when its lend ends", () => {
  expect(marked(statementRows({ ...ASK, provide: "github" }, FACTS))).toEqual([
    "Key: {checked:keyaaaaa}",
    "Belongs to: {link:“GitHub”} / The link says so.",
    "Lends its functions as: {checked:itx.github} / This mind's agents call them, so the key's holder sees what they send. If {checked:itx.github} is lent now, the key's holder takes it when that lend ends.",
    ...LAST_ROWS,
  ]);
});

test("the statement for a key that lends and adds events has a row for each", () => {
  const ask = { ...ASK, paths: ["/integrations/github/"], provide: "github" };
  expect(marked(statementRows(ask, FACTS))).toEqual([
    "Key: {checked:keyaaaaa}",
    "Belongs to: {link:“GitHub”} / The link says so.",
    "Lends its functions as: {checked:itx.github} / This mind's agents call them, so the key's holder sees what they send. If {checked:itx.github} is lent now, the key's holder takes it when that lend ends.",
    "Adds events at: {checked:/integrations/github/} and below / Its events show the name {link:bridge-github} and this key.",
    ...LAST_ROWS,
  ]);
});

test("the label and the actor are the link's words; the key, the contexts, the lent name and the mind are checked", () => {
  const ask = { ...ASK, paths: ["/integrations/github/"], provide: "github" };
  const from = fromOf(statementRows(ask, FACTS));
  expect(from("link")).toEqual(new Set(["bridge-github", "“GitHub”"]));
  expect(from("checked")).toEqual(
    new Set(["keyaaaaa", "/integrations/github/", "itx.github", "example.com"]),
  );
  expect(from("you")).toEqual(new Set(["member@example.net"]));
});

test("iterate Cloud's key is published by the Cloud's origin, which is checked, as is its name; no row is the link's word", () => {
  const cloud = {
    actor: "iterate-cloud",
    label: "iterate Cloud",
    publicKey: "MFkw",
    paths: ["/integrations/"],
    cloud: "https://cloud.example.com",
  };
  const rows = statementRows(cloud, FACTS);
  expect(marked(rows)).toEqual([
    "Key: {checked:keyaaaaa}",
    "Published by: {checked:https://cloud.example.com}, as iterate Cloud's key",
    "Adds events at: {checked:/integrations/} and below / Its events show the name {checked:iterate-cloud} and this key.",
    ...LAST_ROWS,
  ]);
  expect(rows.map((row) => row.label)).not.toContain("Belongs to");
  const from = fromOf(rows);
  expect(from("link")).toEqual(new Set());
  expect(from("checked")).toEqual(
    new Set([
      "keyaaaaa",
      "https://cloud.example.com",
      "/integrations/",
      "iterate-cloud",
      "example.com",
    ]),
  );
});

/** The rows as text, `label: value`, then ` / note` when the row has one, each part that is not
 *  plain words marked `{from:text}`. A row's help is left out: it only explains. */
function marked(rows: StatementRow[]) {
  const words = (parts: StatementPart[]) =>
    parts.map((part) => (part.from ? `{${part.from}:${part.text}}` : part.text)).join("");
  return rows.map(
    (row) => `${row.label}: ${words(row.value)}${row.note ? ` / ${words(row.note)}` : ""}`,
  );
}

/** The texts of the rows' parts (values and notes) that came from `kind`. */
function fromOf(rows: StatementRow[]) {
  const parts = rows.flatMap((row) => [...row.value, ...(row.note || [])]);
  return (kind: StatementPart["from"]) =>
    new Set(parts.filter((part) => part.from === kind).map((part) => part.text));
}
