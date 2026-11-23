// sdk/cut.ts — THE CUT RULE, FOR WHAT A CONFIG'S CODE THREW (./code-failed.ts): the message, the
// stack and the path of a `mind/code-failed` lose their URLs' hosts and query strings, and their
// tokens, before the fact is first appended. The same rule as the platform's page tag
// (core/auth-worker/src/page-tag.ts `pathOf` and `cut`) and the template's
// (core/configs/default/apps/telemetry/cut.ts); iterate/lib cannot import either, so it holds a
// copy, and lint/page-tag-cut-rule.test.ts holds every copy to the same answers. Change one,
// change all.
//
// - `pathOf`: a path loses its query string and its hash, and a segment that looks like an id or
//   a token becomes `<id>`: a UUID, 32 or more hex characters, 12 or more letters and digits with
//   both, 20 or more characters in both cases, or 16 or more in both cases with a digit. At most
//   200 characters.
// - `cut`: every URL-like run keeps its path alone, by the path rule (a script's file name stays
//   whole), and its line and column:
//     absolute           `https://host/a?b#c`   its scheme, host, query string and hash go
//     protocol-relative  `//host/a?b#c`         its host, query string and hash go
//     relative           `/a?b`, `../a#c`, `assets/app.js?rev=1#x`, and any other run of text
//                        with a `?` or a `#` inside it: every `?` and `#` part goes
//   Then a `code=`, `state=` or `token=` (also `auth_code=`, `access_token=`) and its value, a
//   bearer token, and a run of 32 or more letters and digits are each `<cut>`.
// No import: lint's test imports this file as it is.

/** A path that keeps its words and loses its secrets. */
export function pathOf(path: unknown): string {
  const isId = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{32,}$/i.test(s) ||
    (s.length >= 12 && /^\w+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s)) ||
    (s.length >= 16 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.length >= 20 || /\d/.test(s)));
  return String(path ?? "")
    .split(/[?#]/)[0]!
    .slice(0, 2_000)
    .split("/")
    .map((s) => (isId(s) ? "<id>" : s))
    .join("/")
    .slice(0, 200);
}

/** A text with every URL in it cut to its path, and its codes, states, tokens and bearer tokens
 *  out. */
export function cut(text: unknown): string {
  const keep = (path: string, rest?: string) => {
    const [, folder, file, at] =
      /^(.*?\/)?([\w.-]{1,80}\.(?:m?[jt]sx?|css|wasm))?((?::\d+){0,2})$/.exec(path || "/") ?? [];
    const line = at || (rest || "").match(/(?::\d+){1,2}$/)?.[0] || "";
    return file ? pathOf(folder || "") + file + line : pathOf(path || "/") + line;
  };
  return String(text ?? "")
    .replace(
      /[a-z][a-z0-9+.-]*:\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/gi,
      (_, path: string, rest?: string) => keep(path, rest),
    )
    .replace(
      /(^|[\s"'(=@])\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
      (_, before: string, path: string, rest?: string) => before + keep(path, rest),
    )
    .replace(
      /(^|[\s"'(=@])((?:\.{0,2}\/)[^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
      (_, before: string, path: string, rest?: string) => before + keep(path, rest),
    )
    .replace(/([^\s"'()<>?#]+)([?#][^\s"'()<>]+)/g, (_, path: string, rest: string) =>
      keep(path, rest),
    )
    .replace(/\b[a-z_]*(?:code|state|token)=[^\s&"'(),;<>]*|\bbearer\s+[^\s"'(),;<>]+/gi, "<cut>")
    .replace(/[A-Za-z0-9_+=-]{32,}/g, "<cut>");
}
