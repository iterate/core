// cloud-key.ts — WHETHER AN iterate Cloud PUBLISHES A KEY: the one check behind the name
// `iterate-cloud` on `/keys/enrol` (./key-rules.ts `CLOUD_ACTOR`). The link names the Cloud's
// origin, and this Worker reads `<origin>/.well-known/iterate-cloud` itself, at the consent page
// and again at the member's press. The secrets Worker reads the same document for the Cloud's
// clients (core/secrets-worker cloud-client.ts); this reads its two other fields, `actor` and
// `publicKey`, and nothing else of it.
import { deadlineIn, jsonOf, textWithin } from "iterate/mind-identity-log";
import { z } from "zod";
import { CLOUD_ACTOR } from "./key-rules.ts";

const CLOUD_DOCUMENT_PATH = "/.well-known/iterate-cloud";
/** The Cloud's whole document, its clients' facts with it, is a few KiB. */
const DOCUMENT_MAX_BYTES = 256 * 1024;
/** A consent page waits this long for the Cloud, at most. */
const DOCUMENT_READ_MS = 5000;

const CloudDocument = z.object({ actor: z.literal(CLOUD_ACTOR), publicKey: z.string().min(1) });

/** WHY `publicKey` IS NOT THE KEY THAT THE CLOUD AT `cloud` PUBLISHES, in a member's words, or
 *  null when it is. `cloud` is an `https:` origin (./key-rules.ts `cloudOriginOf`). A redirect is
 *  no answer: the key must be the one that this origin itself gives. */
export async function cloudKeyRefusal(cloud: string, publicKey: string): Promise<string | null> {
  const host = new URL(cloud).host;
  const deadline = deadlineIn(DOCUMENT_READ_MS);
  const body = await fetch(`${cloud}${CLOUD_DOCUMENT_PATH}`, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(DOCUMENT_READ_MS),
  })
    .then((answer) =>
      answer.status === 200 ? textWithin(answer, DOCUMENT_MAX_BYTES, deadline.expiry) : null,
    )
    .catch(() => null)
    .finally(deadline.clear);
  const document = body ? CloudDocument.safeParse(jsonOf(body)) : null;
  if (!document?.success) {
    console.info({ event: "auth.cloud-key-refused", cloud, answered: false });
    return `${host} did not answer with an iterate Cloud's key at ${cloud}${CLOUD_DOCUMENT_PATH}, so this mind cannot check the key in this link. Nothing was added. Try again later.`;
  }
  if (document.data.publicKey !== publicKey) {
    console.info({ event: "auth.cloud-key-refused", cloud, answered: true });
    return `${host} publishes another key than the one in this link, so this is not its key. Nothing was added.`;
  }
  return null;
}
