import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export const INDEX = "index";

// Paths only: each secret's object stays the authority. The vault keeps its own list because the
// project's `/secrets` context may be hostile, and the vault never reads it.
export class ApprovalsIndex extends DurableObject<Env> {
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
