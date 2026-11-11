// Written by `node core/lib/scripts/plain-page-css.ts` from tokens.css and plain-page.css.
// Edit those, then run it.

/** tokens.css and plain-page.css: the text of a plain page's one `<style>`. */
export const plainPageCss = `:root {
color-scheme: light dark;
--radius: 0;
--background: light-dark(#ffffff, #111111);
--foreground: light-dark(#111111, #eeeeee);
--card: light-dark(#ffffff, #111111);
--card-foreground: light-dark(#111111, #eeeeee);
--popover: light-dark(#ffffff, #111111);
--popover-foreground: light-dark(#111111, #eeeeee);
--primary: light-dark(#111111, #eeeeee);
--primary-foreground: light-dark(#ffffff, #111111);
--secondary: light-dark(#f4f4f4, #222222);
--secondary-foreground: light-dark(#111111, #eeeeee);
--muted: light-dark(#f4f4f4, #222222);
--muted-foreground: light-dark(#555555, #aaaaaa);
--accent: light-dark(#f4f4f4, #222222);
--accent-foreground: light-dark(#111111, #eeeeee);
--destructive: light-dark(#a40000, #ff8080);
--success: light-dark(#1a7f37, #75d994);
--warning: light-dark(#9a6700, #e8bb63);
--info: light-dark(#0e7490, #72cadd);
--border: light-dark(#dddddd, #444444);
--input: light-dark(#dddddd, #444444);
--ring: light-dark(#111111, #eeeeee);
--link: light-dark(#0645ad, #8ab4f8);
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
export const plainPageCssHash = "'sha256-jupqFOKdrafVAspH3ZHYAYUSEIc24wyPztZZba/2A5c='";
