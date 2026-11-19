import { Script, createContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { ITX_PERSON_HEADER, ITX_PRINCIPAL_HEADER } from "iterate/principal";
import { SCRIPT, secretCollect } from "./secret-collect.ts";

test("the form names its mind, renders the description's Markdown safely, hides the one field's label from sight alone, and runs its script by the policy's nonce", async () => {
  const page = await open();
  const html = await page.text();
  const policy = page.headers.get("content-security-policy")!;
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(html).toContain('<span class="mind">iterate.ada.example</span>');
  // the page's own line first, in the body's type; the description after it, as the code's words
  const own = html.indexOf("<p>The mind iterate.ada.example keeps what you type here");
  const quoted = html.indexOf(
    `<p class="muted">The mind's code says:</p><blockquote class="prose"><p>Make one at`,
  );
  expect([own > -1, quoted > own]).toEqual([true, true]);
  // its script fetches nothing
  expect(policy).not.toContain("connect-src");
  expect(html).toContain(
    '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">the keys page</a> <span class="muted">(platform.openai.com)</span>',
  );
  expect(html).toContain("&#60;b&#62;bold?&#60;/b&#62;");
  // the lines that name the mind are the page's own: no link of the agent's is in them
  const lines = [
    /<div class="masthead">.*?<\/div>/.exec(html)?.[0],
    /<p>The mind .*?<\/p>/.exec(html)?.[0],
  ];
  expect(lines.map((line) => !!line && !line.includes("<a "))).toEqual([true, true]);
  // the eye is hidden until the script runs: with scripts off it would do nothing
  expect(html).toContain('<label for="field-value" class="sr-only">Value</label>');
  expect(html).toContain(
    '<button type="button" class="reveal" hidden aria-label="Show Value" aria-pressed="false" aria-controls="field-value">',
  );
  // a form of the agent's own fields shows their labels; a field that is not a secret has no eye
  const fields = await (
    await open([
      { name: "clientId", label: "Client ID", public: true },
      { name: "clientSecret", label: "Client secret" },
    ])
  ).text();
  expect(fields).toContain('<label for="field-clientId">Client ID</label>');
  expect(fields).not.toContain('aria-controls="field-clientId"');
  expect(fields).toContain('aria-controls="field-clientSecret"');
});

test("the eye shows and hides the value, and the form is sent once: a second Enter or press while it goes does nothing, even with a field named like a form's property", () => {
  const listeners = new Map<object, Map<string, (event: object) => void>>();
  const on = (target: object) => (type: string, listener: (event: object) => void) =>
    (listeners.get(target) ?? listeners.set(target, new Map()).get(target)!).set(type, listener);
  // what the script touches of an element
  class Element {
    type = "";
    textContent = "";
    hidden = true;
    attributes: Record<string, string> = {};
    addEventListener = on(this);
    setAttribute = (name: string, value: string) => (this.attributes[name] = value);
    getAttribute = (name: string) => this.attributes[name] ?? null;
    removeAttribute = (name: string) => delete this.attributes[name];
  }
  const element = (fields: Partial<Element>) => Object.assign(new Element(), fields);
  const input = element({ type: "password" });
  const eye = element({});
  eye.setAttribute("aria-controls", "field-value");
  const save = element({ textContent: "Save" });
  const window = {};
  const page = {};
  const document = {
    addEventListener: on(page),
    querySelectorAll: () => [eye],
    querySelector: (selector: string) =>
      selector === "#collect button[type=submit]" ? save : null,
    getElementById: (id: string) => ({ "field-value": input })[id],
  };
  new Script(SCRIPT).runInContext(
    createContext({ document, addEventListener: on(window), String }),
  );
  const fire = (target: object, type: string, event: object = {}) =>
    listeners.get(target)!.get(type)!(event);

  expect(eye).toMatchObject({ hidden: false });
  fire(eye, "click");
  expect([input.type, eye.getAttribute("aria-pressed")]).toEqual(["text", "true"]);
  fire(eye, "click");
  expect([input.type, eye.getAttribute("aria-pressed")]).toEqual(["password", "false"]);

  const first = { preventDefault: vi.fn() };
  fire(page, "submit", first);
  expect(first.preventDefault).not.toHaveBeenCalled();
  expect([save.textContent, save.getAttribute("aria-disabled")]).toEqual(["Saving…", "true"]);
  // an Enter in the field and a press of Save are both a submit of the form
  const again = [{ preventDefault: vi.fn() }, { preventDefault: vi.fn() }];
  for (const event of again) fire(page, "submit", event);
  expect(again.map((event) => event.preventDefault.mock.calls.length)).toEqual([1, 1]);
  // Back shows the kept page again: it is a form to send once more
  fire(window, "pageshow", { persisted: true });
  const afterBack = { preventDefault: vi.fn() };
  fire(page, "submit", afterBack);
  expect(afterBack.preventDefault).not.toHaveBeenCalled();
});

function member() {
  return {
    [ITX_PERSON_HEADER]: JSON.stringify({
      userId: "user_1",
      email: "jo@example.net",
      name: "jo",
      method: "passkey",
    }),
    [ITX_PRINCIPAL_HEADER]: JSON.stringify({ actor: "user_1", email: "jo@example.net" }),
  };
}
function formOf(fields?: object[]) {
  return () => ({
    collectionForm: async () => ({
      urls: ["https://api.openai.com"],
      description:
        "Make one at [the keys page](https://platform.openai.com/api-keys). <b>bold?</b>",
      fields,
      use: { placement: "header" as const, operations: [], lendTo: [] },
      anyoneWithLink: false,
    }),
    collect: async () => ({ result: { redirectUrl: null }, facts: [] }),
  });
}
function open(fields?: object[]) {
  return secretCollect(
    new Request("https://iterate.ada.example/secrets/collect?path=/secrets/openai&nonce=n", {
      headers: member(),
    }),
    // a stand-in of the two methods that the page calls, not the whole object
    formOf(fields) as never,
  );
}
