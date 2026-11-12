// turn-on.js — WHAT THE CONFIG REPO HOLDS WITH VOICE ON (AGENTS.md, "Voice"): package.json pins a
// build of the package, voice.ts names the package's service and relay, and worker.ts has its two
// install lines as code, not as comments. `filesWithVoiceOn` gives those files, and the page
// (app.js) commits them.
export const VOICE = "@iterate-com/voice";

// the two lines of worker.ts, as code: the default config has each as a comment
const INSTALL_IMPORT = `import { installVoice } from "${VOICE}/install";`;
const INSTALL_CALL = "await installVoice(itx);";

/**
 * The config repo's files with voice on at `version`, as `commitFiles` takes them. `manifest` is
 * package.json's text, `worker` worker.ts's, and `voiceFile` voice.ts's (null when there is none).
 * A worker.ts that has the two lines as code already keeps them. One that has neither the lines
 * nor their comments is not changed: this throws, and says what to add by hand.
 */
export function filesWithVoiceOn({ manifest, worker, voiceFile, version }) {
  const next = JSON.parse(manifest || "{}");
  next.dependencies = { ...next.dependencies, [VOICE]: version };
  const withLine = (text, line) => text.replace(`// ${line}`, line);
  const nextWorker = withLine(withLine(worker || "", INSTALL_IMPORT), INSTALL_CALL);
  const isCode = (line) => nextWorker.split("\n").some((row) => row.trim() === line);
  if (!isCode(INSTALL_IMPORT) || !isCode(INSTALL_CALL))
    throw new Error(
      `worker.ts has no "// ${INSTALL_CALL}" line to switch on. Add these two lines to it yourself: ${INSTALL_IMPORT} at the top, and ${INSTALL_CALL} in the init case, after agents.install(itx).`,
    );
  const changes = [
    { path: "package.json", content: `${JSON.stringify(next, null, 2)}\n` },
    { path: "worker.ts", content: nextWorker },
  ];
  if (!voiceFile)
    changes.push({
      path: "voice.ts",
      content: `// Voice: the service at itx.voice, and the relay each device's own context runs. Both are\n// ${VOICE}'s, at the build package.json pins.\nexport { default, VoiceAgentDurableObject } from "${VOICE}";\n`,
    });
  return changes;
}
