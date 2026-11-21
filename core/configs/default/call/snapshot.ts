// call/snapshot.ts — ONE STILL PICTURE OF A CALL'S CAMERA OR SCREEN, for the agent of the call:
// - `callSnapshot(itx, input, { callerPath })`: `itx.config.callSnapshot({ source, of? })` (worker.ts).
//   It acts ONLY on the calling agent's own call (`callerPath()`): it takes no `agent`.
// - `handleSnapshotUpload(request, host, agent)`: Meet's `POST /snapshot<agent>` (apps/meet/app.ts),
//   where the page that shares the source sends the picture. A member's alone. It calls no
//   context that the mind's catalog does not list (a call to a path makes its context), and no
//   call facet that is not on: both answer 404. It asks the call facet whether the upload is the
//   open request's BEFORE it reads a byte of the body, reads at most `SNAPSHOT.maxBytes`, checks
//   the JPEG's first bytes, stores it at `/call-snapshots<agent>/<id>-<source>.jpg` (outside
//   `<agent>/`, so no guest of a share link of `<agent>` reads it through their view), and deletes
//   the file when the call does not settle it. AN UPLOAD OF THE REQUEST'S OWN PAGE THAT IS REFUSED
//   (no JPEG, no length, too long) FAILS THE REQUEST: the agent hears why at once, and no second
//   upload is taken for it.
// The rules (who may be pictured, the bounds, the audit trail) are call/rules.ts.
import type { IterateContextApi } from "iterate/api";
import type { IterateConfigEntrypoint } from "iterate/sdk";
import { z } from "zod";
import type { CallDurableObject } from "../call.ts";
import { SNAPSHOT, SNAPSHOT_SOURCES, type SnapshotSource, Who } from "./rules.ts";

const AGENT_PATH = /^\/agents(?:\/[A-Za-z0-9][\w.@+-]{0,99}){1,8}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_ID = /^[\w:.@-]{1,200}$/;

/** What an upload says its length is: `content-length`, or `x-length`, which the page sets itself
 *  (a body streamed on its way here can arrive with no content-length). A missing or malformed one
 *  is null. It is only the first gate: the count of what arrives is the cap. */
function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length") || request.headers.get("x-length");
  return value && /^\d{1,12}$/.test(value.trim()) ? Number(value) : null;
}

/** The body's bytes, read chunk by chunk and dropped the moment they pass `max`, whatever the
 *  upload declared: a body of any size is never buffered whole in the config worker. */
async function readCapped(
  request: Request,
  max: number,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; status: 411 | 413 | 400; error: string }
> {
  const declared = declaredLength(request);
  if (declared === null)
    return {
      ok: false,
      status: 411,
      error: "an upload says its length (content-length, or x-length)",
    };
  if (declared > max) return { ok: false, status: 413, error: `at most ${max} bytes` };
  if (!request.body) return { ok: false, status: 400, error: "an upload has a body" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413, error: `at most ${max} bytes` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** A JPEG by its first bytes, never by what the page calls it. */
const isJpeg = (bytes: Uint8Array) =>
  bytes.byteLength >= 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Where a call snapshot JPEG is stored in `itx.files`: outside `<agent>/` so `personItx`
 *  (core/itx/src/person-context.ts `files.get`, which enforces `file.startsWith(agent + "/")`)
 *  hard-blocks any guest on a share link of `<agent>` with FORBIDDEN, while members and the agent's
 *  own `AgentDurableObject` read it directly. */
export function snapshotFilePath(agent: string, id: string, source: SnapshotSource): string {
  return `/call-snapshots${agent}/${id}-${source}.jpg`;
}

/** The call facet's snapshot methods, as call.ts's class declares them. */
type CallFacet = Pick<
  CallDurableObject,
  "requestSnapshot" | "authorizeSnapshot" | "fulfillSnapshot" | "declineSnapshot" | "expireSnapshot"
>;

/** What an agent's script hands `callSnapshot`: a source, and maybe whose. */
const CallSnapshotInput = z
  .object({ source: z.enum(SNAPSHOT_SOURCES), of: z.string().max(200).optional() })
  .strict();
/** An input that names an agent: refused in its own words, since the call is the caller's. */
const NamesAgent = z.object({ agent: z.string() });
/** The audit events `callSnapshot` waits for (call/rules.ts `fulfillSnapshot`, `#failSnapshot`). */
const Taken = z.object({
  of: Who,
  source: z.enum(SNAPSHOT_SOURCES),
  width: z.number(),
  height: z.number(),
  path: z.string(),
  takenAt: z.string(),
});
const Failed = z.object({ reason: z.string() });

const ATTACHED_NOTE =
  "The image is attached to your context: you will see it on your next step, after this script. Do not try to fetch the path yourself.";

/** `itx.config.callSnapshot({ source, of? })`: takes ONE still JPEG of a consenting participant's
 *  camera or shared screen in the CALLING AGENT'S OWN CALL (`callerPath()`). */
export async function callSnapshot(
  itx: Pick<IterateContextApi, "cd">,
  input: unknown,
  { callerPath, waitMs = SNAPSHOT.waitMs }: { callerPath(): string; waitMs?: number },
): Promise<
  | {
      status: "succeeded";
      of: Who;
      source: SnapshotSource;
      width: number;
      height: number;
      path: string;
      takenAt: string;
      note: string;
    }
  | { status: "refused"; reason: string }
> {
  if (NamesAgent.safeParse(input).success)
    throw new Error(
      "callSnapshot acts only on the calling agent's own call; do not pass an agent path.",
    );
  const parsed = CallSnapshotInput.safeParse(input);
  if (!parsed.success)
    throw new Error('callSnapshot takes { source: "camera" | "screen", of?: string }.');
  const { source } = parsed.data;
  const of = parsed.data.of?.trim() || undefined;

  let caller = "";
  try {
    caller = callerPath();
  } catch {
    caller = "";
  }
  if (!AGENT_PATH.test(caller))
    throw new Error(
      `callSnapshot acts only from an agent's own context (got ${caller ? JSON.stringify(caller) : "no caller context"}).`,
    );

  const context = itx.cd(caller);
  const rows = await context.processors.list();
  if (!rows.some((row) => row.name === "call"))
    return { status: "refused", reason: "This agent has no active call." };

  const call = context.facets.get<CallFacet>("call");
  const asked = await call.requestSnapshot({ source, of });
  if (asked.status === "refused") return { status: "refused", reason: asked.reason };

  try {
    const settled = await itx.cd(`${caller}/call`).waitForEvent({
      type: ["call/snapshot-taken", "call/snapshot-failed"],
      payload: { id: asked.id },
      afterOffset: asked.auditOffset,
      timeoutMs: waitMs,
    });
    if (settled.type === "call/snapshot-taken") {
      const taken = Taken.parse(settled.payload);
      return { status: "succeeded", ...taken, note: ATTACHED_NOTE };
    }
    return {
      status: "refused",
      reason: Failed.safeParse(settled.payload).data?.reason || "No picture arrived.",
    };
  } catch {
    const ended = await call.expireSnapshot({ id: asked.id });
    if (ended.status === "fulfilled") {
      return {
        status: "succeeded",
        of: ended.of,
        source: ended.source,
        width: ended.width,
        height: ended.height,
        path: ended.path,
        takenAt: ended.takenAt,
        note: ATTACHED_NOTE,
      };
    }
    return {
      status: "refused",
      reason:
        ended.status === "failed"
          ? ended.reason
          : "timeout: the participant's page did not answer in time",
    };
  }
}

const dimensionOf = (request: Request, header: string) =>
  Math.min(Math.max(Math.round(Number(request.headers.get(header)) || 0), 0), 10_000);

/** `POST /snapshot<AGENT>` in apps/meet/app.ts: one JPEG from the consenting participant's own page.
 *  Checks auth, headers, that the agent is there with its call on (`agentListed`: whether the
 *  mind's catalog lists the agent, asked with no call to the agent's own context), the facet's
 *  authorization, and the declared type and length BEFORE reading any body byte. */
export async function handleSnapshotUpload(
  request: Request,
  host: Pick<IterateConfigEntrypoint, "auth" | "getItx">,
  agent: string,
  agentListed: (itx: IterateContextApi, agent: string) => Promise<boolean>,
): Promise<Response> {
  const denied = host.auth.require(request);
  if (denied) return denied;
  const person = host.auth.person(request);
  if (!person?.userId) return json({ error: "Sign in first." }, 401);
  if (!AGENT_PATH.test(agent)) return json({ error: "Invalid agent path." }, 404);

  const id = (request.headers.get("x-request") || "").trim();
  const page = (request.headers.get("x-page") || "").trim();
  if (!REQUEST_ID.test(id) || !PAGE_ID.test(page))
    return json({ error: "x-request and x-page headers are required." }, 400);

  using itx = host.getItx();
  // a call to a context that is not there makes it, and a facet that is not on throws: neither
  // has a snapshot request, so both are refused before the agent's context is called
  if (!(await agentListed(itx, agent))) return json({ error: "No such agent." }, 404);
  const rows = await itx.cd(agent).processors.list();
  if (!rows.some((row) => row.name === "call"))
    return json({ error: "This agent has no call, so no snapshot request." }, 404);
  const call = itx.cd(agent).facets.get<CallFacet>("call");
  // the page's own word that it could not take the picture: its reason may be empty
  if (request.headers.has("x-declined")) {
    const answer = await call.declineSnapshot({
      id,
      page,
      actor: person.userId,
      reason: request.headers.get("x-declined") || undefined,
    });
    return json(answer.ok ? { ok: true } : { error: answer.error }, answer.status);
  }

  // the call's word, then the content type and the declared length, BEFORE any byte of the body
  const authorized = await call.authorizeSnapshot({ id, page, actor: person.userId });
  if (!authorized.ok) return json({ error: authorized.error }, authorized.status);
  // the upload is the open request's own page's: one that is refused from here on fails the request
  const refuse = async (status: number, error: string, reason: string) => {
    await call.declineSnapshot({ id, page, actor: person.userId, reason }).catch(() => {});
    return json({ error }, status);
  };
  const contentType = (request.headers.get("content-type") || "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const noJpeg = "what the page sent is no JPEG";
  if (contentType !== "image/jpeg") return refuse(415, "A JPEG is required.", noJpeg);
  const declared = declaredLength(request);
  if (declared === null)
    return refuse(
      411,
      "An upload must declare its length (content-length or x-length).",
      "upload refused: it did not say its length",
    );
  const tooLong = `A picture is at most ${SNAPSHOT.maxBytes} bytes.`;
  if (declared > SNAPSHOT.maxBytes)
    return refuse(413, tooLong, `upload refused: at most ${SNAPSHOT.maxBytes} bytes`);

  const read = await readCapped(request, SNAPSHOT.maxBytes);
  if (!read.ok)
    return refuse(
      read.status,
      read.status === 413 ? tooLong : read.error,
      `upload refused: ${read.error}`,
    );
  if (!isJpeg(read.bytes)) return refuse(415, "A JPEG is required.", noJpeg);

  const file = itx.files.get(snapshotFilePath(agent, id, authorized.snapshot.source));
  const stored = await file.put({ contentType: "image/jpeg", data: read.bytes });
  const kept = await call
    .fulfillSnapshot({
      id,
      page,
      actor: person.userId,
      path: stored.path,
      bytes: stored.size,
      width: dimensionOf(request, "x-width"),
      height: dimensionOf(request, "x-height"),
    })
    .catch((error: unknown) => ({
      ok: false as const,
      status: 500,
      fulfilled: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (!kept.ok) {
    if (!kept.fulfilled) await file.delete().catch(() => {});
    return json({ error: kept.error }, kept.status);
  }
  return json({ ok: true, path: stored.path }, 200);
}
