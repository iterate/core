// open-cloud.ts — "OPEN ITERATE CLOUD": the route `GET /open-cloud` of the onboarding app, for
// members (worker.ts guards the host). Each load signs one `POST /secret-proxy/open` as the mind
// (cloud-credit.ts `open`) and answers a page that posts the answer's token to iterate Cloud's
// `/open` at once. The token is for one use and lives 5 minutes: it is in this one answer's body
// alone, never in a URL, a log or an event of the mind.
import { ITERATE_CLOUD } from "../../cloud-deliveries.ts";
import type { CloudCredit } from "./cloud-credit.ts";
import { failureWords } from "./steps/connect-iterate-cloud.ts";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

export async function openCloud(credit: Pick<CloudCredit, "open">): Promise<Response> {
  const answer = await credit.open();
  if (!answer.ok)
    return page(
      `<p>${escape(
        (answer.reason !== "cloud-unreachable" && failureWords(answer.reason)) ||
          "iterate Cloud did not answer. Try again.",
      )}</p>`,
      502,
    );
  return page(
    `<form method="post" action="${ITERATE_CLOUD}/open">` +
      `<input type="hidden" name="token" value="${escape(answer.token)}">` +
      `<p>Opening iterate Cloud…</p><button type="submit">Continue</button></form>` +
      `<script>document.forms[0].submit()</script>`,
    200,
  );
}

function page(body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>iterate Cloud</title></head><body>${body}</body></html>`,
    { status, headers: HEADERS },
  );
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
