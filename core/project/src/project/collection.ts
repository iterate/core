import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { codedError, errorCode, resolveContextPath } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxEntrypointScope } from "core-itx";
import type { ProjectState } from "./contract.ts";
import {
  entityPlural,
  type EntityCreationAndDeletionState,
  type EntitySlug,
} from "./entity-lifecycle.ts";

const TERMINAL_WAIT_MS = 30_000;
/** WORKAROUND: Cloudflare sometimes replaces a context's Durable Object under an in-flight call, and
 *  the new instance's appends never reach the old one's waiters. Each slice is a fresh call, which
 *  reaches the active instance. Remove when a call on a replaced instance fails. */
const TERMINAL_WAIT_SLICE_MS = 5_000;

export class EntityCollectionRpcTarget extends RpcTarget {
  private readonly slug: EntitySlug;
  private readonly getItx: () => ItxEntrypointScope & Disposable;
  private readonly catalog: () => Promise<ProjectState>;

  constructor(
    slug: EntitySlug,
    getItx: () => ItxEntrypointScope & Disposable,
    catalog: () => Promise<ProjectState>,
  ) {
    super();
    this.slug = slug;
    this.getItx = getItx;
    this.catalog = catalog;
  }

  async #state(context: { invoke(steps: (string | unknown[])[]): unknown }) {
    const snapshot = await context.invoke(["itx", "facets", ["get", this.slug], ["snapshot"]]);
    return (snapshot as { state: EntityCreationAndDeletionState }).state;
  }

  // A wake record found after a slice timed out is an incarnation the timed-out wait never saw.
  async #terminalFact(
    context: { waitForEvent(filter: object): unknown },
    path: string,
    types: string[],
    afterOffset: number,
  ): Promise<StreamEvent> {
    const started = Date.now();
    let after = afterOffset;
    let timedOut = 0;
    for (;;) {
      const remainingMs = started + TERMINAL_WAIT_MS - Date.now();
      if (remainingMs <= 0)
        throw codedError(
          "WAIT_TIMEOUT",
          `${this.slug} ${path}: no ${types.join(" or ")} after offset ${afterOffset} within ${TERMINAL_WAIT_MS}ms`,
        );
      let event: StreamEvent;
      try {
        event = (await context.waitForEvent({
          type: [...types, "events.iterate.com/itx/woken"],
          afterOffset: after,
          timeoutMs: Math.min(TERMINAL_WAIT_SLICE_MS, remainingMs),
        })) as StreamEvent;
      } catch (error) {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        timedOut += 1;
        continue;
      }
      if (event.type !== "events.iterate.com/itx/woken") return event;
      if (timedOut > 0)
        console.warn({
          event: "iterate-context.platform-failure-wait-moved",
          namespace: "iterate-context",
          message:
            "the entity's context was reborn under a wait that never saw it: waited again on the active instance",
          path,
          types: types.join(","),
          waitedMs: Date.now() - started,
          slicesTimedOut: timedOut,
          incarnation: Number(event.payload?.incarnation),
          cause: String(event.payload?.cause),
        });
      after = event.offset;
    }
  }

  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog())[entityPlural(this.slug)]).map(([path, row]) => ({
      path,
      ...row,
    }));
  }

  // A creation already open is waited on, never requested again: the terminal fact is sought after
  // the request that opened it, so a certificate landing between the read and the wait is seen.
  async create(path: string, options: { creator: string }): Promise<{ path: string }> {
    // A project member at `/` reaches this facet directly, and the creator becomes a link as written.
    const parsed = z.object({ creator: z.string().startsWith("/") }).safeParse(options);
    if (!parsed.success)
      throw codedError(
        "INVALID_INPUT",
        `${entityPlural(this.slug)}.create(${JSON.stringify(path)}): the creator must be an absolute context path`,
      );
    const creator = resolveContextPath("/", parsed.data.creator);
    using itx = this.getItx();
    const context = itx.cd(path);
    const state = await this.#state(context);
    if (state.deletion) throw new Error(`${this.slug} ${path}: deleted — not re-creatable`);
    if (state.creation?.status === "created") return { path };
    let requestedAtOffset: number;
    if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
    else {
      await context.processors.enable(this.slug);
      // Written here, never by the entity's processor from the request: whoever may append on a
      // path may append a request, so a creator it named would be the appender's choice.
      const link = {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx",
          target: ["itx", "builtins", ["cd", creator]],
          description: "everything this context does not claim, its creator answers",
        },
        idempotencyKey: `itx@${creator}`,
      };
      const request = { type: `events.iterate.com/${this.slug}/create-requested`, payload: {} };
      const appended = (await context.append(
        ...(creator === path ? [request] : [link, request]),
      )) as unknown as StreamEvent[];
      requestedAtOffset = appended.at(-1)!.offset;
    }
    const settled = await this.#terminalFact(
      context,
      path,
      [`events.iterate.com/${this.slug}/created`, `events.iterate.com/${this.slug}/create-failed`],
      requestedAtOffset,
    );
    if (settled.type === `events.iterate.com/${this.slug}/create-failed`)
      throw new Error(`${this.slug} ${path}: creation failed — ${String(settled.payload?.error)}`);
    return { path };
  }

  async delete(path: string): Promise<{ path: string }> {
    using itx = this.getItx();
    const context = itx.cd(path);
    const state = await this.#state(context);
    if (state.deletion?.status !== "deleted") {
      if (state.creation?.status !== "created")
        throw codedError("NOT_CREATED", `${this.slug} ${path}: not created — nothing to delete`, {
          path,
        });
      let requestedAtOffset: number;
      if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
      else {
        const [requested] = (await context.append({
          type: `events.iterate.com/${this.slug}/delete-requested`,
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      await this.#terminalFact(
        context,
        path,
        [`events.iterate.com/${this.slug}/deleted`],
        requestedAtOffset,
      );
    }
    // The row goes last, and again on a retry: a call that lost its answer after the certificate
    // would otherwise leave the row and the facet's storage behind.
    const rows = (await context.processors.list()) as unknown as { name: string }[];
    if (rows.some((row) => row.name === this.slug)) await context.processors.disable(this.slug);
    return { path };
  }
}
