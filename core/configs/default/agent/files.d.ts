// What `import agentFiles from "./agent/"` gives (../agent-start.ts): every file of this folder,
// by its path. The platform's loader makes that module for an import that ends in a slash
// (../files.d.ts declares it for every folder).
//
// This folder needs the line of its own because it has a package.json: its `main` names the entry
// module of the agent's facets for the platform, and TypeScript would read `main` as the type of
// the folder import too. package.json's `types` points here instead.
declare const files: Record<string, string | Uint8Array>;
export default files;
