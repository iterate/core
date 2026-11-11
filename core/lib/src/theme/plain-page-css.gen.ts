// Written by `node core/lib/scripts/plain-page-css.ts` from tokens.css and plain-page.css.
// Edit those, then run it.

/** tokens.css and plain-page.css: the text of a plain page's one `<style>`. */
export const plainPageCss = `:root {
color-scheme: light dark;
--radius: 0.625rem;
--background: light-dark(oklch(1 0 0), oklch(0.145 0 0));
--foreground: light-dark(oklch(0.145 0 0), oklch(0.985 0 0));
--card: light-dark(oklch(1 0 0), oklch(0.205 0 0));
--card-foreground: light-dark(oklch(0.145 0 0), oklch(0.985 0 0));
--popover: light-dark(oklch(1 0 0), oklch(0.205 0 0));
--popover-foreground: light-dark(oklch(0.145 0 0), oklch(0.985 0 0));
--primary: light-dark(oklch(0.205 0 0), oklch(0.922 0 0));
--primary-foreground: light-dark(oklch(0.985 0 0), oklch(0.205 0 0));
--secondary: light-dark(oklch(0.97 0 0), oklch(0.269 0 0));
--secondary-foreground: light-dark(oklch(0.205 0 0), oklch(0.985 0 0));
--muted: light-dark(oklch(0.97 0 0), oklch(0.269 0 0));
--muted-foreground: light-dark(oklch(0.556 0 0), oklch(0.708 0 0));
--accent: light-dark(oklch(0.97 0 0), oklch(0.269 0 0));
--accent-foreground: light-dark(oklch(0.205 0 0), oklch(0.985 0 0));
--destructive: light-dark(oklch(0.577 0.245 27.325), oklch(0.704 0.191 22.216));
--success: light-dark(oklch(0.508 0.118 165.612), oklch(0.765 0.177 163.223));
--warning: light-dark(oklch(0.555 0.163 48.998), oklch(0.828 0.189 84.429));
--info: light-dark(oklch(0.5 0.134 242.749), oklch(0.746 0.16 232.661));
--border: light-dark(oklch(0.922 0 0), oklch(1 0 0 / 10%));
--input: light-dark(oklch(0.922 0 0), oklch(1 0 0 / 15%));
--ring: light-dark(oklch(0.708 0 0), oklch(0.556 0 0));
--link: light-dark(oklch(0.205 0 0), oklch(0.922 0 0));
}
:root.light {
color-scheme: light;
}
:root.dark {
color-scheme: dark;
}
body {
margin: 0;
background: var(--background);
color: var(--foreground);
font-family:
ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol",
"Noto Color Emoji";
font-size: 1rem;
line-height: 1.5;
-webkit-font-smoothing: antialiased;
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
font-size: 1.5rem;
font-weight: 600;
line-height: 1.3;
letter-spacing: -0.025em;
}
h2 {
margin: 0;
font-size: inherit;
font-weight: 600;
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
border-radius: var(--radius);
}
label {
display: block;
}
input,
select,
textarea {
font: inherit;
}
input:not([type="checkbox"], [type="radio"], [type="file"], [type="hidden"]),
select,
textarea {
box-sizing: content-box;
max-width: calc(100% - 1.5rem - 2px);
min-height: 1.5rem;
padding: 0.375rem 0.75rem;
border: 1px solid var(--input);
border-radius: calc(var(--radius) - 2px);
background: transparent;
color: inherit;
}
pre,
code {
font-family:
ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
monospace;
font-size: 0.875em;
}
pre {
margin: 0;
padding: 0.75rem;
border-radius: calc(var(--radius) - 2px);
background: var(--muted);
overflow-x: auto;
white-space: pre-wrap;
}
pre code {
font-size: inherit;
}
button {
font: inherit;
}
:not(pre) > code {
background: var(--muted);
padding: 0.125rem 0.3rem;
border-radius: 0.25rem;
}
a,
.link {
color: var(--link);
font-weight: 500;
text-decoration: underline;
text-underline-offset: 4px;
}
button {
min-height: 2.25rem;
padding: 0 1rem;
border: 0;
border-radius: calc(var(--radius) - 2px);
background: var(--primary);
color: var(--primary-foreground);
font-size: 0.875rem;
font-weight: 500;
cursor: pointer;
}
button:hover {
background: color-mix(in oklab, var(--primary) 90%, transparent);
}
button.link {
min-height: 0;
padding: 0;
background: none;
font-size: inherit;
}
:focus-visible {
outline: 3px solid color-mix(in oklab, var(--ring) 50%, transparent);
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
export const plainPageCssHash = "'sha256-ZI/zi+6yiJDKQ6KEnj0WkjhVH99EgGoWnb0tRT4grUw='";
