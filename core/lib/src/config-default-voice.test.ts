// The default config's Voice app (core/configs/default/apps/voice): the commit its "Turn voice on"
// makes. The page's own code (public/turn-on.js) runs here on the default config's own worker.ts
// and package.json, so a change to either that the page can no longer switch on fails here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const IMPORT = 'import { installVoice } from "@iterate-com/voice/install";';
const CALL = "await installVoice(itx);";

test("Turn voice on pins the build, adds voice.ts, and takes the comment off two lines of the default worker.ts", async () => {
  const files = await withVoiceOn({
    manifest: config("package.json"),
    worker: config("worker.ts"),
    voiceFile: null,
    version: "1.2.3",
  });
  expect(Object.keys(files)).toEqual(["package.json", "worker.ts", "voice.ts"]);
  // every other field of package.json keeps its value
  expect(JSON.parse(files["package.json"]!)).toEqual({
    ...JSON.parse(config("package.json")),
    dependencies: { "@iterate-com/voice": "1.2.3" },
  });
  // worker.ts is the same file, but for the two lines
  const before = config("worker.ts").split("\n");
  const after = files["worker.ts"]!.split("\n");
  expect(after).toHaveLength(before.length);
  expect(before.filter((line, at) => line !== after[at]).map((line) => line.trim())).toEqual([
    `// ${IMPORT}`,
    `// ${CALL}`,
  ]);
  expect(after.filter((line, at) => line !== before[at]).map((line) => line.trim())).toEqual([
    IMPORT,
    CALL,
  ]);
  expect(files["voice.ts"]).toContain(
    'export { default, VoiceAgentDurableObject } from "@iterate-com/voice";',
  );
});

test("a config with voice on keeps its worker.ts and its voice.ts: only the pin moves", async () => {
  const on = await withVoiceOn({
    manifest: config("package.json"),
    worker: config("worker.ts"),
    voiceFile: null,
    version: "1.2.3",
  });
  const again = await withVoiceOn({
    manifest: on["package.json"]!,
    worker: on["worker.ts"]!,
    voiceFile: on["voice.ts"]!,
    version: "1.2.4",
  });
  expect(Object.keys(again)).toEqual(["package.json", "worker.ts"]);
  expect(again["worker.ts"]).toBe(on["worker.ts"]);
  expect(JSON.parse(again["package.json"]!)).toMatchObject({
    dependencies: { "@iterate-com/voice": "1.2.4" },
  });
});

test("a worker.ts without the two lines is not changed: the person is told what to add", async () => {
  await expect(
    withVoiceOn({
      manifest: "{}",
      worker: "export default class {}\n",
      voiceFile: null,
      version: "1.2.3",
    }),
  ).rejects.toThrow(`Add these two lines to it yourself: ${IMPORT} at the top, and ${CALL}`);
});

/** A file of the default config, as text. */
function config(file: string) {
  return readFileSync(new URL(`../../configs/default/${file}`, import.meta.url), "utf8");
}

/** The page's `filesWithVoiceOn`, its answer by path. The module is the page's plain JavaScript,
 *  loaded by its address. */
async function withVoiceOn(input: {
  manifest: string;
  worker: string;
  voiceFile: string | null;
  version: string;
}): Promise<Record<string, string>> {
  const module: {
    filesWithVoiceOn(input: object): { path: string; content: string }[];
  } = await import(
    new URL("../../configs/default/apps/voice/public/turn-on.js", import.meta.url).href
  );
  return Object.fromEntries(
    module.filesWithVoiceOn(input).map((change) => [change.path, change.content]),
  );
}
