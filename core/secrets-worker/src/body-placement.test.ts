// A secret's body fields on their own (./body-placement.ts): which requests fill, which fields
// of a body are filled, and what a request leaves as. The secret's object, with its pin and its
// approval rule, is in ./secret/body-placement.test.ts.
import { expect, test } from "vitest";
import { HELD_BODY_LIMIT } from "./approval.ts";
import { bodyToFill, fieldsToFill, withBodyFilled } from "./body-placement.ts";

const TOKEN = "real-token-aaaa";
const SINKS = "https://api.example.com/v1/sinks";
/** The headers of a request that says that its body is JSON. */
const JSON_TYPE = new Headers({ "content-type": "application/json" });
/** The placeholder as a JSON text writes it, quotes and all. */
const WRITTEN = `"getSecret(\\"/secrets/sink\\")"`;

test.for([
  { name: "the method and the URL of a body field", method: "POST", url: SINKS, fields: ["a.b"] },
  { name: "another method", method: "PUT", url: SINKS, fields: [] },
  { name: "another path", method: "POST", url: `${SINKS}/1`, fields: [] },
  { name: "a query", method: "POST", url: `${SINKS}?dry=1`, fields: [] },
  // a fragment is not sent: the request that leaves has that URL
  { name: "that URL with a fragment", method: "POST", url: `${SINKS}#part`, fields: ["a.b"] },
  {
    name: "a path with an escaped slash, which a host may read as that one",
    method: "POST",
    url: `${SINKS}%2F`,
    fields: [],
  },
  {
    // the URL parser takes `%2e%2e` for `..`: the request's URL is that URL, on the wire too
    name: "a path whose dots the URL parser itself resolves to that one",
    method: "POST",
    url: "https://api.example.com/v1/x/%2e%2e/sinks",
    fields: ["a.b"],
  },
  { name: "another origin", method: "POST", url: "https://other.example.com/v1/sinks", fields: [] },
  {
    name: "a header that makes a host take the request for another method",
    method: "POST",
    url: SINKS,
    override: "DELETE",
    fields: [],
  },
])("the fields that a request fills: $name", ({ method, url, override, fields }) => {
  const bound = [
    { method: "POST", url: SINKS, field: "a.b" },
    { method: "POST", url: "https://api.example.com/v1/catalog/enable", field: "c" },
  ];
  const headers = new Headers(override ? { "x-http-method-override": override } : {});
  expect(fieldsToFill(bound, new Request(url, { method, headers }))).toEqual(fields);
  expect(fieldsToFill(undefined, new Request(url, { method, headers }))).toEqual([]);
});

test.for([
  {
    name: "the whole value of the field",
    body: `{"name":"events","config":{"token":${WRITTEN}}}`,
    filled: ["config.token"],
  },
  {
    name: "one field of a JSON secret",
    body: `{"config":{"token":"getSecret(\\"/secrets/sink\\", { field: \\"a.b\\" })"}}`,
    filled: ["config.token"],
  },
  {
    name: "a placeholder that the text spells with an escape and slashes with a backslash",
    body: `{"config":{"token":"\\u0067etSecret(\\"\\/secrets\\/sink\\")"}}`,
    filled: ["config.token"],
  },
  {
    name: "the last of a key that is written twice, which is the one that leaves",
    body: `{"config":{"token":"x"},"config":{"token":${WRITTEN}}}`,
    filled: ["config.token"],
  },
  {
    name: "those of two fields that hold one",
    body: `{"config":{"token":${WRITTEN},"other":"x"},"key":${WRITTEN}}`,
    fields: ["config.token", "config.other", "key"],
    filled: ["config.token", "key"],
  },
])("a placeholder is filled as $name", ({ body, fields = ["config.token"], filled }) => {
  expect(bodyToFill(JSON_TYPE, body, fields).places.map(({ field }) => field)).toEqual(filled);
});

test.for([
  {
    name: "a placeholder at another field alone",
    body: `{"name":${WRITTEN},"config":{"token":"x"}}`,
    refused: "this body has no placeholder there",
  },
  {
    name: "a placeholder inside a longer string",
    body: `{"config":{"token":"Bearer getSecret(\\"/secrets/sink\\")"}}`,
    refused: "this body has no placeholder there",
  },
  {
    name: "two placeholders in the field",
    body: `{"config":{"token":"getSecret(\\"/secrets/sink\\")getSecret(\\"/secrets/sink\\")"}}`,
    refused: "this body has no placeholder there",
  },
  {
    name: "a placeholder behind a key that is written again after it",
    body: `{"config":{"token":${WRITTEN}},"config":{"token":"x"}}`,
    refused: "this body has no placeholder there",
  },
  {
    name: "a placeholder in a list at the field",
    body: `{"config":{"token":[${WRITTEN}]}}`,
    refused: "this body has no placeholder there",
  },
  {
    // a key of digits is a key of an object: a field names no place in a list
    name: "a placeholder in a list, for a field that counts into it",
    body: `{"items":[{"token":${WRITTEN}}]}`,
    fields: ["items.0.token"],
    refused: "this body has no placeholder there",
  },
  {
    name: "a body whose top level is a list",
    body: `[{"config":{"token":${WRITTEN}}}]`,
    refused: "this body has no placeholder there",
  },
  {
    // the walk reads own keys: what an object inherits (`__proto__`, `constructor`) is no place
    name: "a field named for what every object inherits, in a body with no such key of its own",
    body: `{"config":{"token":"x"}}`,
    fields: ["__proto__.token", "constructor.name", "config.constructor.name"],
    refused: "this body has no placeholder there",
  },
  { name: "a text that is no JSON", body: `config.token=x`, refused: "this body is no JSON" },
  { name: "a body of no bytes", body: "", refused: "this request has no body" },
  {
    name: "a body that was not read: one that is too large, or is no UTF-8",
    body: null,
    refused: "this body is too large, or is no UTF-8 text",
  },
  {
    name: "a body that does not say that it is JSON, which is what a string body is without a content type",
    body: `{"config":{"token":${WRITTEN}}}`,
    type: "text/plain;charset=UTF-8",
    refused: "the content type of this body is not JSON",
  },
  {
    name: "a content type that only ends as a JSON type does",
    body: `{"config":{"token":${WRITTEN}}}`,
    type: "text/plain, x+json",
    refused: "the content type of this body is not JSON",
  },
])(
  "a request that fills is refused with $name",
  ({ body, fields = ["config.token"], type, refused }) => {
    const headers = type ? new Headers({ "content-type": type }) : JSON_TYPE;
    expect(() => bodyToFill(headers, body, fields)).toThrow(refused);
  },
);

test("a refusal says what is wrong and what such a request is, and never the content type it was given", () => {
  expect(() =>
    bodyToFill(new Headers({ "content-type": `text/${TOKEN}` }), "{}", ["config.token", "a.b"]),
  ).toThrow(
    "itx.fetch: the content type of this body is not JSON. A request with this method to this URL puts the secret into its body: the body is JSON (content-type: application/json, UTF-8, at most 1 MiB) with the placeholder as the whole string value of config.token or a.b.",
  );
});

test("the body leaves as it was parsed, with the field set: the last of a key written twice, a number beyond a double's range as null, no value at any other place, and no key that the caller did not write", async () => {
  const sent = await withBodyFilled(
    post(
      // a placeholder at another field, and inside a longer string: text, as in every body
      `{ "a": 1, "a": 2, "big": 1e400, "note": ${WRITTEN}, "config": { "token": "x" },\n "config": { "auth": "Bearer getSecret(\\"/secrets/sink\\")", "token": "getSecret(\\"/secrets/sink\\", { field: \\"token\\" })" } }`,
    ),
    ["config.token"],
    holding({ token: TOKEN }),
  );
  expect({
    body: await sent.text(),
    length: sent.headers.get("content-length"),
    type: sent.headers.get("content-type"),
  }).toEqual({
    body: `{"a":2,"big":null,"note":"getSecret(\\"/secrets/sink\\")","config":{"auth":"Bearer getSecret(\\"/secrets/sink\\")","token":"${TOKEN}"}}`,
    length: null,
    type: "application/json",
  });
});

test("a value with quotes, a backslash and a line break stays one string: it adds no key and ends no object", async () => {
  const value = `x","admin":true,"y":"\\ \n é`;
  const sent = await withBodyFilled(
    post(`{"config":{"token":${WRITTEN}}}`),
    ["config.token"],
    holding(value),
  );
  // exact: one key more would be the fault
  expect(JSON.parse(await sent.text())).toEqual({ config: { token: value } });
});

test("a key named __proto__ or constructor is a key of the body like any other: a field with such a name sets the body's own key, and nothing that every object inherits", async () => {
  // no name is refused for a field: the walk reads own keys and sets an own key
  const sent = await withBodyFilled(
    post(
      `{"__proto__":{"token":${WRITTEN},"polluted":"yes"},"constructor":{"prototype":${WRITTEN}},"config":{"__proto__":{"x":1},"token":${WRITTEN}}}`,
    ),
    ["__proto__.token", "constructor.prototype", "config.token"],
    holding(TOKEN),
  );
  // the cast: the properties that a write through a prototype would have made on every object
  const other = {} as { polluted?: string; token?: string; prototype?: string };
  expect({
    body: await sent.text(),
    inherited: [other.polluted, other.token, other.prototype, Object.prototype.constructor],
  }).toEqual({
    body: `{"__proto__":{"token":"${TOKEN}","polluted":"yes"},"constructor":{"prototype":"${TOKEN}"},"config":{"__proto__":{"x":1},"token":"${TOKEN}"}}`,
    inherited: [undefined, undefined, undefined, Object],
  });
});

test.for([
  {
    name: "no body",
    request: () => new Request(SINKS, { method: "POST", headers: JSON_TYPE }),
    refused: "this request has no body",
  },
  {
    name: "a body over the limit",
    request: () => post(`{"pad":"${"x".repeat(HELD_BODY_LIMIT)}"}`),
    refused: "this body is too large, or is no UTF-8 text",
  },
  {
    name: "bytes that are no UTF-8",
    request: () => post(new Uint8Array([0x22, 0xff, 0x22])),
    refused: "this body is too large, or is no UTF-8 text",
  },
  {
    name: "a GitHub App's JWT, which goes in the Authorization header alone",
    request: () => post(`{"config":{"token":"getSecret(\\"/secrets/sink\\", { appJwt: true })"}}`),
    refused: "goes in the Authorization header of a request to https://api.github.com alone",
  },
  {
    name: "a field of a secret that is one string",
    request: () =>
      post(`{"config":{"token":"getSecret(\\"/secrets/sink\\", { field: \\"missing\\" })"}}`),
    refused: "in the request body names a field, but the secret is one string",
  },
  {
    name: "another secret's placeholder at the field",
    request: () => post(`{"config":{"token":"getSecret(\\"/secrets/other\\")"}}`),
    refused: `no stored mind secret for getSecret("/secrets/other") in the request body`,
  },
])(
  "a request that fills is refused with $name, and nothing is left to send",
  async ({ request, refused }) => {
    await expect(withBodyFilled(request(), ["config.token"], holding(TOKEN))).rejects.toThrow(
      refused,
    );
  },
);

test.for([
  { name: "a suffix", written: "Application/Vnd.Api+JSON", sent: "Application/Vnd.Api+JSON" },
  { name: "a parameter", written: "application/json; charset=utf-8", sent: "application/json" },
  {
    // a host that reads the charset would read the same bytes as other letters
    name: "another charset",
    written: "application/json; charset=ibm037",
    sent: "application/json",
  },
  {
    // two headers arrive as one, with a comma: a host that takes the last would read a form
    name: "a second type behind a parameter",
    written: "application/json; x=1, application/x-www-form-urlencoded",
    sent: "application/json",
  },
])(
  "the body that leaves is this Worker's text, so its type is this Worker's word: a JSON type with $name leaves as that one type",
  async ({ written, sent }) => {
    const filled = await withBodyFilled(
      post(`{"config":{"token":${WRITTEN}}}`, written),
      ["config.token"],
      holding(TOKEN),
    );
    expect([filled.headers.get("content-type"), await filled.text()]).toEqual([
      sent,
      `{"config":{"token":"${TOKEN}"}}`,
    ]);
  },
);

test("a body with no end is given up at the limit: no more of it is read than a held request may be", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const read = { bytes: 0, cancelled: false };
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      read.bytes += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      read.cancelled = true;
    },
  });
  await expect(withBodyFilled(post(endless), ["config.token"], holding(TOKEN))).rejects.toThrow(
    "this body is too large",
  );
  // the stream's own queue holds a chunk or two beyond what was read
  expect(read).toMatchObject({ cancelled: true });
  expect(read.bytes).toBeLessThanOrEqual(HELD_BODY_LIMIT + 4 * chunk.length);
});

/** A resolver for the one secret of these tests, which holds `material`. */
function holding(material: string | Record<string, string>) {
  return (path: string) => (path === "/secrets/sink" ? material : null);
}

/** A POST to the bound URL with `body`, as JSON unless `type` says otherwise. */
function post(body: string | Uint8Array | ReadableStream<Uint8Array>, type = "application/json") {
  return new Request(SINKS, {
    method: "POST",
    headers: { "content-type": type },
    body,
    // the cast: a stream as a body needs `duplex`, which workers-types' RequestInit does not declare
    ...({ duplex: "half" } as object),
  });
}
