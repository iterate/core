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
    return callbackPage(400, "This link is not one the platform issued.");
  const secret = objectOf(path);
  if (request.method !== "GET" && request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const form = await secret.collectionForm(path, { nonce });
  if (!form)
    return callbackPage(400, "This link was used already, or it lapsed. Ask for a new one.");
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
      return callbackPage(400, error instanceof Error ? error.message : String(error));
    }
    const page = answer.result.redirectUrl
      ? new Response(null, {
          status: 303,
          headers: { location: answer.result.redirectUrl, "cache-control": "no-store" },
        })
      : callbackPage(200, `Saved: ${path} holds the value. You can close this tab.`);
    return withFacts(page, answer.facts);
  }
  return formPage(path, form);
}

function formPage(path: string, form: CollectionForm): Response {
  const fields = form.fields || [{ name: "value", label: "Value" }];
  const inputs = fields
    .map((field) => {
      const attributes = [
        `name="${escaped(field.name)}"`,
        `id="${escaped(field.name)}"`,
        "required",
        `autocomplete="off"`,
        ...("placeholder" in field && field.placeholder
          ? [`placeholder="${escaped(field.placeholder)}"`]
          : []),
        ...("pattern" in field && field.pattern ? [`pattern="${escaped(field.pattern)}"`] : []),
      ].join(" ");
      const control =
        "multiline" in field && field.multiline
          ? `<textarea ${attributes} rows="6"></textarea>`
          : `<input type="${"public" in field && field.public ? "text" : "password"}" ${attributes}>`;
      const note =
        "public" in field && field.public
          ? "<br><small>Not a secret: the mind reads it from its list of secrets.</small>"
          : "";
      return `<p><label for="${escaped(field.name)}">${escaped(field.label)}</label><br>${control}${note}</p>`;
    })
    .join("");
  const body = [
    `<h1>${escaped(path)}</h1>`,
    form.description ? `<p>${escaped(form.description)}</p>` : "",
    `<p>A secret typed here is only ever sent to ${form.urls.map(escaped).join(", ")}.</p>`,
    useLines(form.use, form.anyoneWithLink),
    form.redirectOrigin ? `<p>Then opens ${escaped(new URL(form.redirectOrigin).host)}.</p>` : "",
    `<form method="post">${inputs}<p><button type="submit">Save</button></p></form>`,
  ].join("");
  return plainPage(200, body, `'self'${form.redirectOrigin ? ` ${form.redirectOrigin}` : ""}`);
}
