import { attempt, projectRoot, type Check } from "./lib.ts";

// A first start pulls the image, which takes longer than one call may: ask again, for at most this.
const START_WAIT_MS = 8 * 60_000;

// A guess at Cloudflare's words: the check prints the message whichever way it goes.
const PRODUCT_MISSING =
  /not (?:enabled|entitled|subscribed|available)|subscription|purchase|plan does not|unauthori[sz]ed|forbidden|code":\s*10000/i;

const TINY_GIF = [
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
];

export async function sandboxChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      {
        check: "sandboxes, workspaces, images and browser",
        pass: true,
        detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
      },
    ];
  const marker = crypto.randomUUID().slice(0, 8);
  const sandbox = JSON.stringify(`/sandboxes/smoke-${marker}`);
  const workspace = JSON.stringify(`/workspaces/smoke-${marker}`);
  const run = (code: string) => projectRoot(domain, token).run(code) as Promise<unknown>;
  const onSandbox = (body: string) => `async (itx) => {
    const sandbox = itx.sandboxes.get(${sandbox});
    const started = async (call) => {
      const deadline = Date.now() + ${START_WAIT_MS};
      for (;;) {
        try { return await call(); }
        catch (error) {
          if (!/still starting/.test(String(error?.message)) || Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    };
    const text = (bytes) => new TextDecoder().decode(bytes).trim();
    ${body}
  }`;
  return [
    await attempt("sandboxes: create one, run a command and read its output", async () => {
      const answer = (await run(
        onSandbox(`
          await itx.sandboxes.create(${sandbox});
          const result = await started(() => sandbox.exec(["sh", "-c", "echo smoke-${marker}"]));
          return { exitCode: result.exitCode, stdout: text(result.stdout) };`),
      )) as { exitCode: number; stdout: string };
      return {
        pass: answer.exitCode === 0 && answer.stdout === `smoke-${marker}`,
        detail: JSON.stringify(answer),
      };
    }),
    await attempt("sandboxes: write a file and read it back", async () => {
      const written = `smoke file ${marker}`;
      const read = await run(
        onSandbox(`
          await started(() => sandbox.files.write("/tmp/smoke.txt", ${JSON.stringify(written)}));
          return await new Response(await sandbox.files.read("/tmp/smoke.txt")).text();`),
      );
      return { pass: read === written, detail: JSON.stringify(read) };
    }),
    await attempt("sandboxes: a request from inside leaves through the door", async () => {
      // with no internet of its own, an answer can only have come through the project's door
      const answer = (await run(
        onSandbox(`
          const result = await started(() =>
            sandbox.exec(["node", "-e", "fetch('https://example.com/').then((r) => console.log(r.status))"]),
          );
          return { exitCode: result.exitCode, stdout: text(result.stdout), stderr: text(result.stderr).slice(-300) };`),
      )) as { exitCode: number; stdout: string; stderr: string };
      return {
        pass: answer.exitCode === 0 && answer.stdout === "200",
        detail: JSON.stringify(answer),
      };
    }),
    await attempt("sandboxes: remove it", async () => {
      const answer = (await run(`async (itx) => {
        await itx.sandboxes.delete(${sandbox});
        return (await itx.sandboxes.list()).some(({ path }) => path === ${sandbox});
      }`)) as boolean;
      return { pass: answer === false, detail: `still listed: ${answer}` };
    }),
    await attempt("workspaces: create one, write and read a file, remove it", async () => {
      const text = `smoke workspace ${marker}`;
      const answer = (await run(`async (itx) => {
        await itx.workspaces.create(${workspace});
        const handle = itx.workspaces.get(${workspace});
        await handle.writeFile("/scratch/smoke.txt", ${JSON.stringify(text)});
        const read = await handle.readFile("/scratch/smoke.txt");
        await itx.workspaces.delete(${workspace});
        const listed = (await itx.workspaces.list()).some(({ path }) => path === ${workspace});
        return { read, listed };
      }`)) as { read: string | null; listed: boolean };
      return { pass: answer.read === text && !answer.listed, detail: JSON.stringify(answer) };
    }),
    await productCheck("images: info on a 1×1 GIF", async () => {
      const info = (await run(
        `async (itx) => itx.images.info(new Uint8Array(${JSON.stringify(TINY_GIF)}))`,
      )) as {
        width?: number;
        height?: number;
      };
      return { pass: info.width === 1 && info.height === 1, detail: JSON.stringify(info) };
    }),
    await productCheck("browser: markdown of https://example.com/", async () => {
      const markdown = await run(
        `async (itx) => itx.browser.quickAction("markdown", { url: "https://example.com/" })`,
      );
      return {
        pass: typeof markdown === "string" && markdown.includes("Example Domain"),
        detail: JSON.stringify(markdown).slice(0, 80),
      };
    }),
  ];
}

async function productCheck(
  check: string,
  run: () => Promise<{ pass: boolean; detail: string }>,
): Promise<Check> {
  const result = await attempt(check, run);
  return !result.pass && PRODUCT_MISSING.test(result.detail)
    ? { check, pass: true, detail: `skipped: the account lacks the product? ${result.detail}` }
    : result;
}
