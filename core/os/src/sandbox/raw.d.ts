// src/sandbox/raw.d.ts — `import text from "./x.ts?raw"`: a file's text, as the bundler (Vite) gives it.
// Referenced where it is used, since tsconfigs that reach the file through an import carry no Vite types.
declare module "*?raw" {
  const text: string;
  export default text;
}
