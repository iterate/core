import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { repoToken } from "./token.ts";

type StoreProps = { origin: string; token: string };

/** The part of Artifacts core/mind-worker calls (src/context/cf-artifacts.ts), over the launcher's git
 *  store. The store's token is the platform's own; a token that a repo hands out is for that repo
 *  and scope alone, and ends (./token.ts). */
export class HomeArtifacts extends WorkerEntrypoint<unknown, StoreProps> {
  async create(name: string) {
    await store(this.ctx.props, "PUT", `/_repos/${encodeURIComponent(name)}`);
    return { token: this.ctx.props.token };
  }

  async get(name: string) {
    await store(this.ctx.props, "GET", `/_repos/${encodeURIComponent(name)}`);
    return new HomeRepo(this.ctx.props, name);
  }

  async list() {
    return (await store(this.ctx.props, "GET", "/_repos")) as { repos: { name: string }[] };
  }

  async delete(name: string) {
    try {
      await store(this.ctx.props, "DELETE", `/_repos/${encodeURIComponent(name)}`);
      return true;
    } catch (error) {
      if (/not found/i.test(String(error))) return false;
      throw error;
    }
  }
}

class HomeRepo extends RpcTarget {
  readonly #props: StoreProps;
  readonly #name: string;

  constructor(props: StoreProps, name: string) {
    super();
    this.#props = props;
    this.#name = name;
  }

  info() {
    return { remote: `${this.#props.origin}/${this.#name}.git` };
  }

  async createToken(scope: "read" | "write", ttlSeconds: number) {
    const expires = Date.now() + ttlSeconds * 1000;
    return {
      plaintext: await repoToken(this.#props.token, { repo: this.#name, scope, expires }),
      expiresAt: new Date(expires).toISOString(),
    };
  }
}

async function store({ origin, token }: StoreProps, method: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error((await response.text()).trim());
  return response.json();
}
