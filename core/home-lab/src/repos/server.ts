import { spawn, spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { repoGrantOf } from "./token.ts";

// as core/mind-worker's `repoArtifactName` spells one
const REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Git's basic-auth password, or a bearer, must be `token`, which opens everything, or a repo's
 *  own token (./token.ts), which opens that repo's git traffic alone. It listens on loopback only. */
export async function serveRepos(input: { dir: string; token: string; port: number }) {
  const { dir, token } = input;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const server = createServer((request, response) => {
    void answer(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  async function answer(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const offered = offeredToken(request.headers.authorization);
    if (!sameText(offered, token)) {
      // a repo's own token: that repo's git traffic alone, and a push only with "write"
      const grant = await repoGrantOf(token, offered);
      const repo = /^\/([^/]+)\.git\//.exec(url.pathname)?.[1];
      const pushes =
        url.pathname.endsWith("/git-receive-pack") ||
        url.searchParams.get("service") === "git-receive-pack";
      if (!grant || grant.repo !== repo || (pushes && grant.scope !== "write"))
        return void response
          .writeHead(401, { "www-authenticate": 'Basic realm="iterate home lab"' })
          .end("This store answers the home lab's token, or a repo's own token for that repo.\n");
    }
    if (url.pathname === "/_repos" && request.method === "GET")
      return json(response, 200, {
        repos: readdirSync(dir)
          .filter((entry) => entry.endsWith(".git"))
          .map((entry) => ({ name: entry.slice(0, -".git".length) })),
      });
    const admin = url.pathname.match(/^\/_repos\/([^/]+)$/);
    if (admin) return manage(request.method || "GET", decodeURIComponent(admin[1]!), response);
    // a decoded `..` would name a path outside the store
    if (decodeURIComponent(url.pathname).split("/").includes(".."))
      return void response.writeHead(400, { "content-type": "text/plain" }).end("Not a path\n");
    if (/^\/[^/]+\.git\//.test(url.pathname)) return gitHttpBackend(request, response, url, dir);
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  }

  // a missing repo is answered in Artifacts' words, which core/mind-worker reads
  function manage(method: string, name: string, response: ServerResponse) {
    if (!REPO_NAME.test(name))
      return void response.writeHead(400).end(`Not a repo name: ${JSON.stringify(name)}\n`);
    const repo = `${dir}/${name}.git`;
    const there = existsSync(repo);
    if (method === "PUT") {
      if (there) return void response.writeHead(409).end(`repo already exists: ${name}\n`);
      git(["init", "--quiet", "--bare", "--initial-branch=main", repo]);
      // a push over HTTP, and a fetch of any commit by its id (the facet's history reads)
      git(["--git-dir", repo, "config", "http.receivepack", "true"]);
      git(["--git-dir", repo, "config", "uploadpack.allowAnySHA1InWant", "true"]);
      return json(response, 201, { name });
    }
    if (!there) return void response.writeHead(404).end(`Repository not found (10200): ${name}\n`);
    if (method === "DELETE") {
      rmSync(repo, { recursive: true, force: true });
      return json(response, 200, { deleted: true });
    }
    return json(response, 200, { name });
  }

  await new Promise<void>((listening) => server.listen(input.port, "127.0.0.1", listening));
  return {
    // the port it listens on: the one asked for, or the free one that port 0 got. The cast: a
    // server that listens on a TCP port has an address of this shape
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => server.close(),
  };
}

// The body is read whole so CONTENT_LENGTH is known. `GIT_PROTOCOL` is what turns on protocol v2.
async function gitHttpBackend(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dir: string,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const header = (name: string) => String(request.headers[name] || "");
  const backend = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: dir,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROTOCOL: header("git-protocol"),
      REQUEST_METHOD: request.method || "GET",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: header("content-type"),
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: header("content-encoding"),
      // an authenticated user: `git http-backend` takes a push only from one
      REMOTE_USER: "home-lab",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  backend.stdin.end(body);
  let stderr = "";
  backend.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let head: Buffer = Buffer.alloc(0);
  let headersDone = false;
  for await (const chunk of backend.stdout) {
    if (headersDone) {
      response.write(chunk);
      continue;
    }
    head = Buffer.concat([head, chunk as Buffer]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) continue;
    headersDone = true;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.write(head.subarray(end + 4));
  }
  if (!headersDone)
    response
      .writeHead(500, { "content-type": "text/plain" })
      .write(`git http-backend gave no answer: ${stderr.trim()}\n`);
  response.end();
}

/** A bearer, or the password of git's basic auth. */
function offeredToken(authorization: string | undefined) {
  const [scheme, credential] = (authorization || "").split(" ");
  if (scheme === "Bearer") return credential || "";
  return scheme === "Basic" && credential
    ? Buffer.from(credential, "base64").toString().split(":").slice(1).join(":")
    : "";
}

function sameText(offered: string, token: string) {
  const [a, b] = [Buffer.from(offered), Buffer.from(token)];
  return a.length === b.length && timingSafeEqual(a, b);
}

function git(args: string[]) {
  const ran = spawnSync("git", args, { encoding: "utf8" });
  if (ran.status !== 0) throw new Error(`git ${args[0]} failed: ${ran.stderr.trim()}`);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}
