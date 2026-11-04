// Written by `node core/lib/scripts/plain-page-css.ts` from tokens.css and plain-page.css.
// Edit those, then run it.

/** tokens.css and plain-page.css: the text of a plain page's one `<style>`. */
export const plainPageCss = `:root {
color-scheme: dark;
--radius: 0;
--background: #111111;
--foreground: #eeeeee;
--card: #111111;
--card-foreground: #eeeeee;
--popover: #111111;
--popover-foreground: #eeeeee;
--primary: #eeeeee;
--primary-foreground: #111111;
--secondary: #222222;
--secondary-foreground: #eeeeee;
--muted: #222222;
--muted-foreground: #aaaaaa;
--accent: #222222;
--accent-foreground: #eeeeee;
--destructive: #ff8080;
--success: #75d994;
--warning: #e8bb63;
--info: #72cadd;
--border: #444444;
--input: #444444;
--ring: #eeeeee;
--link: #8ab4f8;
}
body {
margin: 0;
background: var(--background);
color: var(--foreground);
font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
font-size: 1rem;
line-height: 1.55;
}
main {
box-sizing: border-box;
display: flex;
flex-direction: column;
gap: 1.5rem;
max-width: 52.5rem;
margin: 0 auto;
padding: 3.5rem 1.25rem 6.5rem;
overflow-wrap: anywhere;
}
h1 {
margin: 0;
font-size: 1.75rem;
line-height: 1.3;
}
h2 {
margin: 0;
font-size: inherit;
}
p,
form {
margin: 0;
}
ul {
margin: 0;
padding-left: 1.25rem;
}
fieldset {
margin: 0;
padding: 0.75rem 1rem;
border: 1px solid var(--border);
}
label {
display: block;
}
input,
select,
textarea {
font: inherit;
}
pre {
margin: 0;
padding: 0.75rem;
background: var(--muted);
overflow-x: auto;
white-space: pre-wrap;
}
code,
button {
font: inherit;
}
:not(pre) > code {
background: var(--muted);
padding: 0 0.25rem;
}
a,
.link {
color: var(--link);
text-decoration: underline;
text-underline-offset: 2px;
}
button {
min-height: 2.75rem;
padding: 0 1rem;
border: 0;
border-radius: var(--radius);
background: var(--primary);
color: var(--primary-foreground);
cursor: pointer;
}
button:hover {
background: color-mix(in oklab, var(--primary) 80%, transparent);
}
button.link {
min-height: 0;
padding: 0;
background: none;
}
:focus-visible {
outline: 2px solid var(--ring);
outline-offset: 2px;
}
.muted {
color: var(--muted-foreground);
}
[role="alert"] {
color: var(--destructive);
}
.stack {
display: flex;
flex-direction: column;
align-items: flex-start;
gap: 0.75rem;
}
[hidden] {
display: none !important;
}
.actions {
display: flex;
flex-wrap: wrap;
align-items: center;
gap: 0.75rem 1.25rem;
}`;

/** The CSP source that allows that `<style>` and no other: its SHA-256. */
// allow-high-entropy-next-line: a hash of the public stylesheet above, not a secret
export const plainPageCssHash = "'sha256-/XG73T47VmtVm6jWZnJz3w9tI7O1/vX16Y0fDooA6WM='";
