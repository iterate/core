import { withFacts } from "iterate/facts";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { SecretAnswer } from "iterate/workers";
import {
  admitted,
  callbackPage,
  escaped,
  plainPage,
  useLines,
  type PageCaller,
} from "./callback-page.ts";
import { markdownHtml } from "./markdown.ts";
import type { CollectionForm } from "./secret/durable-object.ts";

// The form is on the platform's origin, so the value never passes through the mind.
export const SECRET_COLLECT_PATH = "/secrets/collect";

type CollectionObject = {
  collectionForm(path: string, input: { nonce: string }): Promise<CollectionForm | null>;
  collect(
    path: string,
    input: { nonce: string; values: Record<string, string>; by: PageCaller },
  ): Promise<SecretAnswer<{ redirectUrl: string | null }>>;
};

export async function secretCollect(
  request: Request,
  objectOf: (path: string) => CollectionObject,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!SECRET_PATH.test(path) || !nonce)
    return callbackPage(request, 400, "This link is not one the platform issued.");
  const secret = objectOf(path);
  if (request.method !== "GET" && request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const form = await secret.collectionForm(path, { nonce });
  if (!form)
    return callbackPage(
      request,
      400,
      "This link was used already, or it lapsed. Ask for a new one.",
    );
  const admission = admitted(request, form.anyoneWithLink);
  if (admission instanceof Response) return admission;
  if (request.method === "POST") {
    const values: Record<string, string> = {};
    for (const [name, value] of await request.formData())
      if (typeof value === "string") values[name] = value;
    let answer: Awaited<ReturnType<CollectionObject["collect"]>>;
    try {
      answer = await secret.collect(path, { nonce, values, by: admission.by });
    } catch (error) {
      return callbackPage(request, 400, error instanceof Error ? error.message : String(error));
    }
    const page = answer.result.redirectUrl
      ? new Response(null, {
          status: 303,
          headers: { location: answer.result.redirectUrl, "cache-control": "no-store" },
        })
      : callbackPage(request, 200, `Saved: ${path} holds the value. You can close this tab.`);
    return withFacts(page, answer.facts);
  }
  return formPage(request, path, form);
}

// The page's one script, by its nonce: the eye shows or hides a field's value, and the form is sent
// once. The browser checks the fields first; a press or an Enter while it is sent does nothing.
export const SCRIPT = `
for (const button of document.querySelectorAll("button.reveal")) {
  // with scripts off the eye is hidden: it would do nothing
  button.hidden = false;
  button.addEventListener("click", () => {
    const input = document.getElementById(button.getAttribute("aria-controls"));
    const shown = input.type === "password";
    input.type = shown ? "text" : "password";
    button.setAttribute("aria-pressed", String(shown));
  });
}
// one form: a field named like a property of the form (dataset, querySelector) would shadow
// it, so the flag is a variable and the listener is the document's
const save = document.querySelector("#collect button[type=submit]");
let sent = false;
document.addEventListener("submit", (event) => {
  if (sent) return event.preventDefault();
  sent = true;
  save.setAttribute("aria-disabled", "true");
  save.textContent = "Saving…";
});
// a page that the browser keeps and shows again on Back is a form to send again
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  sent = false;
  save.removeAttribute("aria-disabled");
  save.textContent = "Save";
});
`;

function formPage(request: Request, path: string, form: CollectionForm): Response {
  const fields = form.fields || [{ name: "value", label: "Value" }];
  const inputs = fields
    .map((field) => {
      const id = `field-${escaped(field.name)}`;
      const attributes = [
        `name="${escaped(field.name)}"`,
        `id="${id}"`,
        "required",
        `autocomplete="off"`,
        `spellcheck="false"`,
        ...(field.placeholder ? [`placeholder="${escaped(field.placeholder)}"`] : []),
        ...(field.pattern ? [`pattern="${escaped(field.pattern)}"`] : []),
      ].join(" ");
      const control = field.multiline
        ? `<textarea ${attributes} rows="6"></textarea>`
        : field.public
          ? `<input type="text" ${attributes}>`
          : // Lucide's eye and eye-off, in the text's colour
            `<div class="reveal-field"><input type="password" ${attributes}><button type="button" class="reveal" hidden aria-label="Show ${escaped(field.label)}" aria-pressed="false" aria-controls="${id}"><svg class="shows" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg><svg class="hides" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg></button></div>`;
      const note = field.public
        ? "<small>Not a secret: the mind reads it from its list of secrets.</small>"
        : "";
      // one field with no words of the agent's own: "Value" says nothing a person can see
      const label = form.fields
        ? `<label for="${id}">${escaped(field.label)}</label>`
        : `<label for="${id}" class="sr-only">${escaped(field.label)}</label>`;
      return `<div class="stack">${label}${control}${note}</div>`;
    })
    .join("");
  const mind = new URL(request.url).hostname;
  const body = [
    `<h1>${escaped(path)}</h1>`,
    `<p>The mind ${escaped(mind)} keeps what you type here, and only ever sends it to ${form.urls.map(escaped).join(", ")}.</p>`,
    // after the page's own line, and marked as the words of the mind's code, which may say anything
    form.description
      ? `<div class="stack"><p class="muted">The mind's code says:</p><blockquote class="prose">${markdownHtml(form.description)}</blockquote></div>`
      : "",
    useLines(form.use, form.anyoneWithLink),
    form.redirectOrigin ? `<p>Then opens ${escaped(new URL(form.redirectOrigin).host)}.</p>` : "",
    `<form method="post" id="collect" class="stack">${inputs}<button type="submit">Save</button></form>`,
  ].join("");
  const nonce = crypto.randomUUID();
  return plainPage(request, 200, `${body}<script nonce="${nonce}">${SCRIPT}</script>`, {
    formAction: `'self'${form.redirectOrigin ? ` ${form.redirectOrigin}` : ""}`,
    scriptNonce: nonce,
  });
}
