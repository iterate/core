import { loadProjectConfig, resourceNamesOf, stageOf } from "../src/config.ts";

async function reposNamespace() {
  const config = await loadProjectConfig(stageOf(process.argv));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Error(
      "CLOUDFLARE_API_TOKEN is not set: the Artifacts namespace is made with it, as the deploy is",
    );
  if (config.project?.provided)
    return console.log("the project is provided: no Artifacts namespace");
  const { accountId } = config;
  const namespace = resourceNamesOf(config.name).repos;
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  // Listed first: creating a namespace that already holds repos is refused as 10004 ("Access denied"),
  // not the 10201 an empty one gets.
  // Six tries, five seconds apart: Cloudflare answers 10004 in passing for a namespace that exists.
  let answer = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const listed = await fetch(`${api}/${namespace}/repos`, { headers });
    await listed.body?.cancel();
    if (listed.ok) return console.log(`${namespace} exists`);
    const response = await fetch(api, {
      method: "POST",
      headers,
      body: JSON.stringify({ namespace }),
    });
    answer = await response.text();
    // `"success":true`, or 409 with code 10201 when the namespace exists.
    if (response.ok) return console.log(`made the Artifacts namespace ${namespace}`);
    if (/"code":\s*10201\b/.test(answer)) return console.log(`${namespace} exists`);
    console.log(`the Artifacts namespace ${namespace}: try ${attempt} of 6 was refused`);
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Cloudflare refused the Artifacts namespace ${namespace}: ${answer.slice(0, 500)}`,
  );
}

try {
  await reposNamespace();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
