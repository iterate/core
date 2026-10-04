import { expect, onTestFinished, test, vi } from "vitest";
import {
  buildStanding,
  pinPkgPrNewVersion,
  pinVersion,
  pkgPrNewVersion,
  type BuildStanding,
} from "./package-builds.ts";

const commit = "aaaaabbbbbccccc111112222233333aaaaabbbbb";

test.for([
  ["a branch", "main"],
  ["a PR number", "3338"],
])("%s is pinned at the commit pkg.pr.new's HEAD names", async ([, ref]) => {
  const head = vi.fn(async () => served(`iterate:private:${commit}`));
  expect(await pinPkgPrNewVersion("@iterate-com/agents", agentsAt(ref), head)).toBe(
    agentsAt(commit),
  );
  expect(head).toHaveBeenCalledExactlyOnceWith(
    agentsAt(ref),
    expect.objectContaining({ method: "HEAD" }),
  );
});

test.for([
  ["a commit", "@iterate-com/agents", agentsAt(commit)],
  ["an npm range", "hono", "^4"],
  ["a dist-tag", "hono", "latest"],
  ["a URL of another package (an alias)", "@iterate-com/voice", agentsAt("main")],
])("%s is written as it is, and pkg.pr.new is never asked", async ([, name, version]) => {
  const head = vi.fn(async () => served(`iterate:private:${commit}`));
  expect(await pinPkgPrNewVersion(name, version, head)).toBe(version);
  expect(head).not.toHaveBeenCalled();
});

test.for([
  ["a 404, which echoes the ref", served("iterate:private:main", 404), 404],
  ["a 200 naming a short sha", served("iterate:private:9f8e7d6"), 200],
  ["a 200 naming no commit", new Response(null), 200],
] as const)("%s cannot be pinned, and says so", async ([, answer, status]) => {
  await expect(
    pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), async () => answer),
  ).rejects.toThrow(
    `${agentsAt("main")} answered ${status} without naming the commit it serves, so it cannot be pinned`,
  );
});

test("pkg.pr.new's 503 is asked once more a second later, and its next answer pins", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answers = [new Response("down", { status: 503 }), served(`iterate:private:${commit}`)];
  const head = vi.fn(async () => answers.shift()!);
  const pinned = pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), head);
  await vi.runAllTimersAsync();
  expect(await pinned).toBe(agentsAt(commit));
  expect(head).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "pkg-pr-new.platform-failure-retry", kind: "disconnected", status: 503 },
  ]);
});

test("a HEAD pkg.pr.new never answers fails at its 10 s deadline, and is not sent again", async () => {
  // The fake clock cannot move AbortSignal.timeout's own timer, so the deadline is a fake
  // setTimeout that aborts as the real one does.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("timed out", "TimeoutError")), ms);
    return deadline.signal;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const head = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve) => init!.signal!.addEventListener("abort", resolve));
    throw init!.signal!.reason;
  });
  const started = Date.now();
  await expect(pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), head)).rejects.toThrow(
    `HEAD ${agentsAt("main")}: no answer within 10 s`,
  );
  expect(Date.now() - started).toBe(10_000);
  expect(head).toHaveBeenCalledOnce();
});

const older = "1".repeat(40);
const newer = "2".repeat(40);
const earlier = "Mon, 28 Sep 2026 13:20:32 GMT";
const later = "Tue, 29 Sep 2026 09:28:04 GMT";
const afterLater = "Tue, 29 Sep 2026 10:00:00 GMT";
const distTags = "https://registry.npmjs.org/-/package/@iterate-com/agents/dist-tags";

test.for([
  { name: "`main` of one of ours is the version npm's dist-tag names", pkg: "@iterate-com/agents" },
  { name: "`main` of iterate itself too", pkg: "iterate" },
])("$name", async ({ pkg }) => {
  const get = vi.fn(async () => Response.json({ latest: "0.4.0", main: npmAt(newer, later) }));
  expect(await pinVersion(pkg, "main", get)).toBe(npmAt(newer, later));
  expect(get).toHaveBeenCalledExactlyOnceWith(
    `https://registry.npmjs.org/-/package/${pkg}/dist-tags`,
    expect.anything(),
  );
});

test("`main` of another package is its own dist-tag, and npm is never asked", async () => {
  const get = vi.fn(async () => Response.json({ main: npmAt(newer, later) }));
  expect(await pinVersion("hono", "main", get)).toBe("main");
  expect(get).not.toHaveBeenCalled();
});

test.for<{
  name: string;
  installed: string;
  answers: Record<string, Response>;
  standing: BuildStanding;
}>([
  {
    name: "main's newest npm build is the newest",
    installed: npmAt(newer, later),
    answers: { [distTags]: Response.json({ main: npmAt(newer, later) }) },
    standing: { kind: "newest", installed: "2222222" },
  },
  {
    name: "an npm build of an older commit is behind: an upgrade to the newest",
    installed: npmAt(older, earlier),
    answers: { [distTags]: Response.json({ main: npmAt(newer, later) }) },
    standing: {
      kind: "behind",
      installed: "1111111",
      newest: "2222222",
      version: npmAt(newer, later),
    },
  },
  {
    name: "one of the first npm builds, whose version holds milliseconds and the whole sha, is main's newest by its first seven digits",
    installed: `0.1.0-main.20260929T092804000Z-${newer}`,
    answers: { [distTags]: Response.json({ main: npmAt(newer, later) }) },
    standing: { kind: "newest", installed: newer },
  },
  {
    name: "one of the first npm builds, of an older commit, is behind",
    installed: `0.1.0-main.20260928T132032000Z-${older}`,
    answers: { [distTags]: Response.json({ main: npmAt(newer, later) }) },
    standing: { kind: "behind", installed: older, newest: "2222222", version: npmAt(newer, later) },
  },
  {
    name: "a pkg.pr.new build published after main's newest commit (a pull request's) is ahead",
    installed: agentsAt(older),
    answers: {
      [distTags]: Response.json({ main: npmAt(newer, later) }),
      [agentsAt(older)]: served(`iterate:private:${older}`, 200, afterLater),
    },
    standing: { kind: "ahead", installed: older, newest: "2222222" },
  },
  {
    name: "a pkg.pr.new build of main from before npm is behind",
    installed: agentsAt(older),
    answers: {
      [distTags]: Response.json({ main: npmAt(newer, later) }),
      [agentsAt(older)]: served(`iterate:private:${older}`, 200, earlier),
    },
    standing: { kind: "behind", installed: older, newest: "2222222", version: npmAt(newer, later) },
  },
  {
    name: "a build pkg.pr.new no longer serves is behind",
    installed: agentsAt(older),
    answers: {
      [distTags]: Response.json({ main: npmAt(newer, later) }),
      [agentsAt(older)]: served(`iterate:private:${older}`, 404),
    },
    standing: { kind: "behind", installed: older, newest: "2222222", version: npmAt(newer, later) },
  },
  {
    name: "pkg.pr.new's build of main's newest commit is the newest, by the seven digits npm's version holds",
    installed: agentsAt(newer),
    answers: {
      [distTags]: Response.json({ main: npmAt(newer, later) }),
      [agentsAt(newer)]: served(`iterate:private:${newer}`, 200, later),
    },
    standing: { kind: "newest", installed: newer },
  },
])("$name", async ({ installed, answers, standing }) => {
  const get = vi.fn(async (url: string | URL | Request) => answers[String(url)]!);
  expect(await buildStanding("@iterate-com/agents", installed, get)).toEqual(standing);
  expect(get.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(answers).sort());
});

test.for([
  ["an npm range", "^1.2.0"],
  ["an npm release", "0.4.0"],
  ["a pkg.pr.new branch, which the loader refuses", agentsAt("main")],
  ["a fork's build", `https://pkg.pr.new/someone/fork/@iterate-com/agents@${older}`],
  ["another package's build", pkgPrNewVersion("@iterate-com/voice", older)],
])("%s is the project's own, and nothing is asked", async ([, installed]) => {
  const get = vi.fn(async () => Response.json({ main: npmAt(newer, later) }));
  expect(await buildStanding("@iterate-com/agents", installed, get)).toEqual({
    kind: "own",
    installed,
  });
  expect(get).not.toHaveBeenCalled();
});

test.for([
  {
    name: "npm without the package (its 401 for a scope it doesn't have)",
    main: new Response('"Unauthorized"', { status: 401 }),
    installed: served(`iterate:private:${older}`, 200, earlier),
    error: `npm has no main build of @iterate-com/agents: ${distTags} answered 401`,
  },
  {
    name: "a `main` that is no main build",
    main: Response.json({ main: "0.4.0" }),
    installed: served(`iterate:private:${older}`, 200, earlier),
    error: `npm has no main build of @iterate-com/agents: ${distTags} answered 200 naming 0.4.0`,
  },
  {
    name: "the installed build served without a publish time",
    main: Response.json({ main: npmAt(newer, later) }),
    installed: served(`iterate:private:${older}`),
    error: `${agentsAt(older)} answered 200 without saying when it was published`,
  },
])("a standing is never guessed: $name throws", async ({ main, installed, error }) => {
  await expect(
    buildStanding("@iterate-com/agents", agentsAt(older), async (url) =>
      String(url) === distTags ? main : installed,
    ),
  ).rejects.toThrow(error);
});

test("npm failing the dist-tags twice fails the standing within its bound, naming the answer", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const get = vi.fn(async () => new Response("down", { status: 503 }));
  const standing = buildStanding("@iterate-com/agents", npmAt(older, earlier), get);
  const settled = expect(standing).rejects.toThrow(`GET ${distTags} answered HTTP 503`);
  await vi.runAllTimersAsync();
  await settled;
  expect(get).toHaveBeenCalledTimes(2);
});

/** main's npm build of `commit`, committed at `committed` (an HTTP date): `0.1.0-main.20260929T092804Z-2222222`. */
function npmAt(commit: string, committed: string) {
  const stamp = new Date(committed).toISOString().slice(0, 19).replace(/\W/g, "");
  return `0.1.0-main.${stamp}Z-${commit.slice(0, 7)}`;
}

function agentsAt(ref: string) {
  return pkgPrNewVersion("@iterate-com/agents", ref);
}

/** pkg.pr.new's answer to a HEAD: `status`, naming `key` in `x-commit-key`, and the build's
 *  publish time in `last-modified` when given. */
function served(key: string, status = 200, lastModified?: string) {
  const headers = new Headers({ "x-commit-key": key });
  if (lastModified) headers.set("last-modified", lastModified);
  return new Response(null, { status, headers });
}
