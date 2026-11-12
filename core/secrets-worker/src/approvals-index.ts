import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export const INDEX = "index";
/** A second set, under its own name: the paths of the secrets that are set (./secret-list.ts). */
export const SET = "set";

// Paths only: each secret's object stays the authority. The vault keeps its own list because the
// mind's `/secrets` context may be hostile, and the vault never reads it.
export class ApprovalsIndex extends DurableObject<Env> {
  /** Whether this set was once filled from every path the mind knew (`SET` alone). */
  async complete(): Promise<boolean> {
    return this.ctx.storage.kv.get<boolean>("complete") ?? false;
  }

  async markComplete(): Promise<void> {
    this.ctx.storage.kv.put("complete", true);
  }

  async add(path: string): Promise<void> {
    this.ctx.storage.kv.put(`path:${path}`, true);
  }

  async remove(path: string): Promise<void> {
    this.ctx.storage.kv.delete(`path:${path}`);
  }

  async paths(): Promise<string[]> {
    return [...this.ctx.storage.kv.list({ prefix: "path:" })].map(([key]) =>
      key.slice("path:".length),
    );
  }
}
