import { expect, test } from "vitest";
import { ApprovalRule, isTightening, requestOfText, requestText, ruleMatches } from "./approval.ts";

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
  expect(ruleMatches(gmailPost, method, url)).toEqual(held);
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
])("$name", ({ input }) => {
  expect(ApprovalRule.safeParse(input)).toMatchObject({ success: false });
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

function rule(methods: string[], hosts: string[]) {
  return ApprovalRule.parse({ methods, hosts });
}

function text(headers: Record<string, string>) {
  return requestText({
    method: "post",
    url: "https://gmail.googleapis.com/send",
    headers: new Headers(headers),
    body: '{"raw":"x"}',
  });
}
