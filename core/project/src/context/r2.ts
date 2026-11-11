import { stampCaller, type ItxHostRootContext } from "core-itx";
import type { IterateContextApi, R2ObjectRecord } from "iterate/api";
import type { StreamEventInput } from "iterate/stream/processor";
import { signedFileUrl } from "./file-urls.ts";
import { hopCaller } from "./hop-caller.ts";

// A script's result has no event of its own: the run's settlement already names it.
const SCRIPT_RESULT_FILE = /\/script-results\/[^/]+$/;

export function r2Root(
  context: ItxHostRootContext,
  bucket: R2Bucket,
  { domain, secret }: { domain: string; secret: () => Promise<string> },
): IterateContextApi["r2"] {
  const { path } = context;
  // What a context writes lands on its log, so no file is loose. The write comes first, so a crash
  // between the two leaves a file with no fact.
  type FileEvent = Pick<StreamEventInput, "source"> &
    (
      | {
          type: "events.iterate.com/itx/file-set";
          payload: { path: string; size: number; contentType: string; etag: string };
        }
      | { type: "events.iterate.com/itx/file-deleted"; payload: { path: string } }
    );
  const recordFileEvents = async (...events: FileEvent[]) => {
    const kept = events.filter(({ payload }) => !SCRIPT_RESULT_FILE.test(payload.path));
    if (kept.length)
      await context
        .context(path)
        .append(...kept.map((event) => stampCaller(event, hopCaller(context), path)));
  };
  return {
    head: async (key) => {
      const object = await bucket.head(key);
      return object ? r2ObjectRecord(object) : null;
    },
    get: async (key, options = {}) => {
      const object = await bucket.get(key, options);
      if (!object) return null;
      return { ...r2ObjectRecord(object), data: new Uint8Array(await object.arrayBuffer()) };
    },
    put: async (key, value, options = {}) => {
      const record = r2ObjectRecord(await bucket.put(key, value, options));
      await recordFileEvents({
        type: "events.iterate.com/itx/file-set",
        payload: {
          path: `/${key}`,
          size: record.size,
          contentType: record.httpMetadata?.contentType || "application/octet-stream",
          etag: record.etag,
        },
      });
      return record;
    },
    delete: async (keys) => {
      const list = typeof keys === "string" ? [keys] : keys;
      await bucket.delete(list);
      await recordFileEvents(
        ...list.map((key) => ({
          type: "events.iterate.com/itx/file-deleted" as const,
          payload: { path: `/${key}` },
        })),
      );
    },
    list: async (options = {}) => {
      const page = await bucket.list(options);
      return {
        objects: page.objects.map((object) => r2ObjectRecord(object)),
        delimitedPrefixes: page.delimitedPrefixes,
        truncated: page.truncated,
        ...(page.truncated && { cursor: page.cursor }),
      };
    },
    presign: async (input) =>
      signedFileUrl({
        key: input.key,
        method: input.method || "GET",
        expiresInSeconds: input.expiresInSeconds,
        domain,
        secret: await secret(),
      }),
  };
}

function r2ObjectRecord(object: R2Object): R2ObjectRecord {
  return {
    key: object.key,
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    // the hex forms: the class holds ArrayBuffers, which do not cross the wire
    checksums: object.checksums.toJSON() as Record<string, string>,
    uploaded: object.uploaded.toISOString(),
    httpMetadata: object.httpMetadata || {},
    customMetadata: object.customMetadata || {},
    range: object.range,
    storageClass: object.storageClass,
  };
}
