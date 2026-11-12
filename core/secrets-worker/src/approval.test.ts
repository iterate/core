import { expect, test } from "vitest";
import {
  ApprovalRule,
  bodyTextOf,
  HELD_BODY_LIMIT,
  isTightening,
  methodsOf,
  requestOfText,
  requestText,
  ruleMatches,
} from "./approval.ts";

const gmailPost = ApprovalRule.parse({ methods: ["post"], hosts: ["Gmail.googleapis.com"] });

test.for([
  {
    name: "a POST to the host waits",
    method: "POST",
    url: "https://gmail.googleapis.com/x",
    held: true,
  },
  {
    name: "a method in lower case is the same",
    method: "post",
    url: "https://gmail.googleapis.com/",
    held: true,
  },
  {
    name: "a GET to the host does not wait",
    method: "GET",
    url: "https://gmail.googleapis.com/x",
    held: false,
  },
  {
    name: "a POST to another host does not wait",
    method: "POST",
    url: "https://www.googleapis.com/x",
    held: false,
  },
  {
    name: "a subdomain is another host",
    method: "POST",
    url: "https://x.gmail.googleapis.com/",
    held: false,
  },
])("a rule: $name", ({ method, url, held }) => {
  expect(ruleMatches(gmailPost, method, url, null)).toEqual(held);
});

test.for([
  { name: "a read goes", body: jmap("Email/query", "Email/get"), held: false },
  { name: "a send waits", body: jmap("Email/set", "EmailSubmission/set"), held: true },
  {
    name: "a send written with an escape waits",
    body: jmap("EmailSubmission/set").replace("EmailSubmission", "\\u0045mailSubmission"),
    held: true,
  },
  { name: "a send in another letter case waits", body: jmap("EMAILSUBMISSION/SET"), held: true },
  {
    name: "a send with a mark that is not seen inside its name waits",
    body: jmap("Email\u200bSubmission/set"),
    held: true,
  },
  {
    name: "a key written twice waits when either holds a send: a parser keeps one of them",
    body: `{"methodCalls":[["EmailSubmission/set",{},"c0"]],"methodCalls":[["Email/get",{},"c0"]]}`,
    held: true,
  },
  {
    name: "a send named as a key waits",
    body: JSON.stringify({ "EmailSubmission/set": {} }),
    held: true,
  },
  {
    name: "a read whose own text holds the name waits: more is held, never less",
    body: JSON.stringify({ methodCalls: [["Email/query", { text: "about EmailSubmission/set" }]] }),
    held: true,
  },
  {
    name: "a body that is not JSON waits",
    body: `${jmap("Email/get").slice(0, -1)},}`,
    held: true,
  },
  { name: "a body with a byte order mark waits", body: `\ufeff${jmap("Email/get")}`, held: true },
  {
    // V8 compares such a string as any other: nothing here throws on it
    name: "a read with half a surrogate pair in its text goes",
    body: '{"methodCalls":[["Email/query",{"text":"\\ud83d"},"c0"]]}',
    held: false,
  },
  {
    name: "a send with half a surrogate pair in its text waits",
    body: '{"methodCalls":[["EmailSubmission/set",{"text":"\\ud83d"},"c0"]]}',
    held: true,
  },
  { name: "an empty body waits", body: "", held: true },
  { name: "a body that is not text, or is too large to read, waits", body: null, held: true },
])("a rule with strings of the body: $name", ({ body, held }) => {
  expect(ruleMatches(fastmailSend, "POST", "https://api.fastmail.com/jmap/api/", body)).toEqual(
    held,
  );
});

// JMAP takes a file at an address of its own, with a body that is no JSON.
test.for([
  { name: "an upload goes, whatever its body", path: "/jmap/upload/u1234abcd/", held: false },
  { name: "a file under the upload's folder goes", path: "/jmap/upload/u1234abcd", held: false },
  { name: "the API's own address waits", path: "/jmap/api/", held: true },
  {
    name: "a folder that only begins with the same letters waits",
    path: "/jmap/uploads/u1/",
    held: true,
  },
  {
    name: "a path that climbs out of the folder is read as where it ends, and waits",
    path: "/jmap/upload/../api/",
    held: true,
  },
  {
    name: "a path that climbs out with escapes waits: the host may read %2F as a slash",
    path: "/jmap/upload/x%2F..%2F..%2Fapi/",
    held: true,
  },
  { name: "a path with any escape waits", path: "/jmap/upload/u%31/", held: true },
  { name: "a path with a query waits", path: "/jmap/upload/u1/?to=/jmap/api/", held: true },
  { name: "a path with an empty part waits", path: "//jmap/upload/u1/", held: true },
  {
    name: "a path with a backslash is read as a slash",
    path: "/jmap/upload\\..\\api/",
    held: true,
  },
])("a rule with a path that never waits: $name", ({ path, held }) => {
  const rule = ApprovalRule.parse({
    methods: ["POST"],
    hosts: ["api.fastmail.com"],
    jsonStrings: ["EmailSubmission/set"],
    freePaths: ["/jmap/upload/"],
  });
  // no body that this can read: bytes of a file
  expect(ruleMatches(rule, "POST", `https://api.fastmail.com${path}`, null)).toEqual(held);
});

test.for([
  ["the whole host", "/"],
  ["a path with no slash at its end", "/jmap/upload"],
  ["a path that climbs", "/jmap/../upload/"],
  ["a path with an escape", "/jmap/up%6Coad/"],
])("a path that never waits may not be %s", ([, path]) => {
  expect(
    ApprovalRule.safeParse({ methods: ["POST"], hosts: ["a.com"], freePaths: [path] }),
  ).toMatchObject({ success: false });
});

test("a request counts as every method it names: a POST that a header makes a DELETE is held by a rule for DELETE", () => {
  const deletes = ApprovalRule.parse({ methods: ["DELETE"], hosts: ["gmail.googleapis.com"] });
  const post = (headers: Record<string, string>) =>
    methodsOf(new Request("https://gmail.googleapis.com/x", { method: "POST", headers }));
  expect([
    post({}),
    post({ "X-HTTP-Method-Override": "delete" }),
    post({ "x-http-method": "PATCH", "X-Method-Override": " Delete " }),
  ]).toEqual([["POST"], ["POST", "DELETE"], ["POST", "PATCH", "DELETE"]]);
  const url = "https://gmail.googleapis.com/x";
  expect([
    ruleMatches(deletes, post({}), url, null),
    ruleMatches(deletes, post({ "X-HTTP-Method-Override": "delete" }), url, null),
    ruleMatches(deletes, post({ "X-Method-Override": "DELETE" }), url, null),
  ]).toEqual([false, true, true]);
});

test("a letter written as an escape once more, inside a string that its host reads again, is that letter", () => {
  const rule = ApprovalRule.parse({
    methods: ["POST"],
    hosts: ["api.github.com"],
    jsonStrings: ["deleteRepo"],
  });
  // GraphQL in JSON: JSON reads \\u0064 as the six characters \u0064, and GraphQL reads those as d
  const body = (query: string) => JSON.stringify({ query });
  const url = "https://api.github.com/graphql";
  expect([
    ruleMatches(rule, "POST", url, body("mutation { deleteRepo }")),
    ruleMatches(rule, "POST", url, body("mutation { \\u0064eleteRepo }")),
    ruleMatches(rule, "POST", url, body("mutation { \\u{64}eleteRepo }")),
    // an escape may have any count of leading zeros
    ruleMatches(rule, "POST", url, body("mutation { \\u{0000064}eleteRepo }")),
    ruleMatches(rule, "POST", url, body("query { viewer { login } }")),
    // an escape for no character at all is left as it is written, and nothing throws
    ruleMatches(rule, "POST", url, body("query { \\u{FFFFFF} }")),
  ]).toEqual([true, true, true, true, false, false]);
});

test("a string of the body that is only marks which are not seen is refused: it would compare as nothing", () => {
  const rule = (jsonStrings: string[]) =>
    ApprovalRule.safeParse({ methods: ["POST"], hosts: ["a.com"], jsonStrings }).success;
  expect([rule(["Send"]), rule(["\u200b"]), rule(["Send", "\u200b\u00ad"])]).toEqual([
    true,
    false,
    false,
  ]);
});

test("a rule with strings of the body still asks for its method and host first", () => {
  const send = jmap("EmailSubmission/set");
  expect([
    ruleMatches(fastmailSend, "GET", "https://api.fastmail.com/jmap/api/", send),
    ruleMatches(fastmailSend, "POST", "https://example.com/jmap/api/", send),
  ]).toEqual([false, false]);
});

test("a body is read from a copy as text, and is null when it is not UTF-8 or is too large", async () => {
  const request = new Request("https://api.fastmail.com/jmap/api/", { method: "POST", body: "{}" });
  expect(await bodyTextOf(request)).toEqual("{}");
  // the request itself is still whole
  expect(await request.text()).toEqual("{}");
  const bytes = (body: Uint8Array<ArrayBuffer>) =>
    bodyTextOf(new Request("https://api.fastmail.com/jmap/upload/", { method: "POST", body }));
  expect([
    await bytes(new Uint8Array([0xff, 0xd8, 0xff])),
    await bytes(new Uint8Array(HELD_BODY_LIMIT + 1).fill(0x20)),
  ]).toEqual([null, null]);
});

test.for([
  {
    name: "a rule with no methods matches nothing, so it is refused",
    input: { methods: [], hosts: ["a.com"] },
  },
  { name: "a rule with no hosts is refused", input: { methods: ["POST"] } },
  {
    name: "a field it does not know is refused",
    input: { methods: ["POST"], hosts: ["a.com"], paths: ["/"] },
  },
  {
    name: "a host with a scheme is refused",
    input: { methods: ["POST"], hosts: ["https://a.com"] },
  },
  {
    name: "a string of the body with a space is refused: the form could not write it",
    input: { methods: ["POST"], hosts: ["a.com"], jsonStrings: ["Email Submission"] },
  },
])("$name", ({ input }) => {
  expect(ApprovalRule.safeParse(input)).toMatchObject({ success: false });
});

test("a rule's strings of the body are kept as written, each once, and an empty list is no list", () => {
  expect([
    ApprovalRule.parse({ methods: ["POST"], hosts: ["a.com"], jsonStrings: ["B/set", "A", "A"] }),
    ApprovalRule.parse({ methods: ["POST"], hosts: ["a.com"], jsonStrings: [] }),
  ]).toEqual([
    { methods: ["POST"], hosts: ["a.com"], jsonStrings: ["A", "B/set"] },
    { methods: ["POST"], hosts: ["a.com"] },
  ]);
});

test("a rule's methods are upper case and its hosts lower case, each once and sorted", () => {
  expect(
    ApprovalRule.parse({ methods: ["put", "POST", "post"], hosts: ["B.com", "a.com", "b.com"] }),
  ).toEqual({ methods: ["POST", "PUT"], hosts: ["a.com", "b.com"] });
});

test.for([
  {
    name: "a rule where there was none",
    before: null,
    after: rule(["POST"], ["a.com"]),
    tighter: true,
  },
  {
    name: "the same rule",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST"], ["a.com"]),
    tighter: true,
  },
  {
    name: "a method added",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST", "PUT"], ["a.com"]),
    tighter: true,
  },
  {
    name: "a host added",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST"], ["a.com", "b.com"]),
    tighter: true,
  },
  {
    name: "a method removed",
    before: rule(["POST", "PUT"], ["a.com"]),
    after: rule(["POST"], ["a.com"]),
    tighter: false,
  },
  {
    name: "a host swapped",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST"], ["b.com"]),
    tighter: false,
  },
  { name: "the rule removed", before: rule(["POST"], ["a.com"]), after: null, tighter: false },
  {
    name: "strings of the body added to a rule that held every request",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST"], ["a.com"], ["Send"]),
    tighter: false,
  },
  {
    name: "the strings of the body removed",
    before: rule(["POST"], ["a.com"], ["Send"]),
    after: rule(["POST"], ["a.com"]),
    tighter: true,
  },
  {
    name: "one more string of the body",
    before: rule(["POST"], ["a.com"], ["Send"]),
    after: rule(["POST"], ["a.com"], ["Send", "Delete"]),
    tighter: true,
  },
  {
    name: "a string of the body made shorter, which holds more",
    before: rule(["POST"], ["a.com"], ["Submission/set"]),
    after: rule(["POST"], ["a.com"], ["submission"]),
    tighter: true,
  },
  {
    name: "a string of the body made longer, which holds less",
    before: rule(["POST"], ["a.com"], ["Submission"]),
    after: rule(["POST"], ["a.com"], ["Submission/set"]),
    tighter: false,
  },
  {
    name: "a path that never waits added",
    before: rule(["POST"], ["a.com"]),
    after: rule(["POST"], ["a.com"], undefined, ["/upload/"]),
    tighter: false,
  },
  {
    name: "the paths that never wait removed",
    before: rule(["POST"], ["a.com"], undefined, ["/upload/"]),
    after: rule(["POST"], ["a.com"]),
    tighter: true,
  },
  {
    name: "a path that never waits made longer, which frees less",
    before: rule(["POST"], ["a.com"], undefined, ["/upload/"]),
    after: rule(["POST"], ["a.com"], undefined, ["/upload/files/"]),
    tighter: true,
  },
  {
    name: "a path that never waits made shorter, which frees more",
    before: rule(["POST"], ["a.com"], undefined, ["/upload/files/"]),
    after: rule(["POST"], ["a.com"], undefined, ["/upload/"]),
    tighter: false,
  },
])("tightening: $name", ({ before, after, tighter }) => {
  expect(isTightening(before, after)).toEqual(tighter);
});

test("a request's text sorts its headers, the hop headers left out, and the placeholder kept", () => {
  // exact: this text is what an approver hashes
  expect(
    text({
      "content-type": "application/json",
      authorization: 'Bearer getSecret("/secrets/gmail")',
      traceparent: "00-aaaa-bbbb-01",
      "cf-connecting-ip": "192.0.2.1",
      "x-iterate-cause": "/agents/one",
      "x-itx-secret-use": "/secrets/gmail",
      "content-length": "11",
    }),
  ).toEqual(
    '{"method":"POST","url":"https://gmail.googleapis.com/send","headers":[["authorization","Bearer getSecret(\\"/secrets/gmail\\")"],["content-type","application/json"]],"body":"{\\"raw\\":\\"x\\"}"}',
  );
});

test("two tries that differ only in hop headers are one text", () => {
  expect(text({ traceparent: "00-aaaa-01", "x-iterate-cause": "/a" })).toEqual(
    text({ traceparent: "00-cccc-01", "x-iterate-cause": "/b" }),
  );
});

test("the request a text holds is the request it was made of", async () => {
  const request = requestOfText(text({ "content-type": "application/json" }));
  expect({
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body: await request.text(),
  }).toEqual({
    method: "POST",
    url: "https://gmail.googleapis.com/send",
    headers: [["content-type", "application/json"]],
    body: '{"raw":"x"}',
  });
});

// JMAP reads and sends through one address, with a POST each: the method's name is in the body.
const fastmailSend = ApprovalRule.parse({
  methods: ["POST"],
  hosts: ["api.fastmail.com"],
  jsonStrings: ["EmailSubmission/set"],
});
function jmap(...calls: string[]) {
  return JSON.stringify({ methodCalls: calls.map((name, index) => [name, {}, `c${index}`]) });
}

function rule(methods: string[], hosts: string[], jsonStrings?: string[], freePaths?: string[]) {
  return ApprovalRule.parse({ methods, hosts, jsonStrings, freePaths });
}

function text(headers: Record<string, string>) {
  return requestText({
    method: "post",
    url: "https://gmail.googleapis.com/send",
    headers: new Headers(headers),
    body: '{"raw":"x"}',
  });
}
