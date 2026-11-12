// Written by `node core/lib/scripts/plain-page-css.ts` from tokens.css and plain-page.css.
// Edit those, then run it.

/** tokens.css and plain-page.css: the text of a plain page's one `<style>`. */
export const plainPageCss = `:root {
color-scheme: light;
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
:root.dark {
color-scheme: dark;
}
body {
display: flex;
flex-direction: column;
min-height: 100svh;
margin: 0;
background: var(--muted);
color: var(--foreground);
font-family:
ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol",
"Noto Color Emoji";
font-size: 0.9375rem;
line-height: 1.5;
-webkit-font-smoothing: antialiased;
}
main {
box-sizing: border-box;
display: flex;
flex-direction: column;
gap: 1.25rem;
width: calc(100% - 2rem);
max-width: 26rem;
margin: auto;
padding: 2rem;
border: 1px solid var(--border);
border-radius: calc(var(--radius) + 4px);
background: var(--card);
color: var(--card-foreground);
box-shadow: 0 1px 2px 0 rgb(0 0 0 / 5%);
overflow-wrap: anywhere;
}
main.wide {
max-width: 46rem;
margin: 3rem auto;
}
@media (max-width: 40rem) {
body {
background: var(--card);
}
main,
main.wide {
width: 100%;
max-width: none;
margin: 0;
padding: 2rem 1.25rem 4rem;
border: 0;
border-radius: 0;
box-shadow: none;
}
}
.mark {
display: flex;
}
.mark svg {
width: 2.25rem;
height: 2.25rem;
border-radius: 22.37%;
}
.asks {
display: flex;
align-items: center;
justify-content: center;
gap: 1rem;
color: var(--muted-foreground);
font-size: 1.25rem;
}
.asks .mark svg,
.tile {
width: 3.5rem;
height: 3.5rem;
border-radius: 22.37%;
}
.tile {
box-sizing: border-box;
display: grid;
place-items: center;
overflow: hidden;
border: 1px solid var(--border);
background: var(--card);
color: var(--foreground);
font-size: 1.125rem;
font-weight: 600;
}
.tile svg {
width: 2rem;
height: 2rem;
}
.tile img {
width: 100%;
height: 100%;
object-fit: contain;
}
.tile.small {
flex: none;
width: 2rem;
height: 2rem;
font-size: 0.75rem;
}
.tile.small svg {
width: 1.125rem;
height: 1.125rem;
}
main.asked h1 {
text-align: center;
text-wrap: balance;
}
main.asked .where {
margin-top: -0.875rem;
text-align: center;
overflow-wrap: anywhere;
}
.about {
padding: 0.75rem 1rem;
border: 1px solid var(--border);
border-radius: var(--radius);
color: var(--muted-foreground);
font-size: 0.875rem;
}
.about p {
margin-bottom: 0.375rem;
}
.about strong {
color: var(--foreground);
}
.mark rect {
fill: var(--foreground);
}
.mark g {
fill: var(--card);
}
h1 {
margin: 0;
font-size: 1.25rem;
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
ul:empty {
display: none;
}
fieldset {
margin: 0;
padding: 0.75rem 1rem;
border: 1px solid var(--border);
border-radius: var(--radius);
}
legend {
float: left;
width: 100%;
margin-bottom: 0.5rem;
padding: 0;
}
legend + * {
clear: both;
}
label {
display: flex;
flex-direction: column;
gap: 0.375rem;
max-width: 100%;
font-size: 0.875rem;
font-weight: 500;
}
label:has(> input:is([type="checkbox"], [type="radio"])) {
flex-direction: row;
align-items: baseline;
gap: 0.5rem;
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
form.inline {
display: inline;
}
button.secondary {
border: 1px solid var(--input);
background: transparent;
color: var(--foreground);
}
button.secondary:hover {
background: var(--accent);
}
.or {
display: flex;
align-items: center;
gap: 0.75rem;
color: var(--muted-foreground);
font-size: 0.8125rem;
}
.or::before,
.or::after {
flex: 1;
border-top: 1px solid var(--border);
content: "";
}
main:not(.wide) .stack {
align-items: stretch;
}
main:not(.wide) .stack > button:not(.link) {
width: 100%;
}
main:not(.wide) .actions > button:not(.link) {
flex: 1;
}
main:not(.wide)
:is(input:not([type="checkbox"], [type="radio"], [type="file"], [type="hidden"]), textarea) {
box-sizing: border-box;
width: 100%;
max-width: none;
min-height: 2.25rem;
}
blockquote {
margin: 0;
padding-left: 0.875rem;
border-left: 2px solid var(--border);
color: var(--muted-foreground);
}
small {
color: var(--muted-foreground);
font-size: 0.8125rem;
}
button.outline {
border: 1px solid var(--border);
background: var(--background);
color: var(--foreground);
}
button.outline:hover {
background: var(--accent);
}
button svg {
margin-right: 0.5rem;
vertical-align: -0.2em;
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
[role="status"]:empty {
display: none;
}
[hidden] {
display: none !important;
}
.actions {
display: flex;
flex-wrap: wrap;
align-items: center;
gap: 0.75rem 1.25rem;
}
.access-list {
list-style: none;
padding: 0;
}
.access {
display: grid;
grid-template-columns: auto minmax(0, 1fr) auto;
gap: 0.25rem 0.75rem;
align-items: start;
padding: 0.75rem 0;
border-top: 1px solid var(--border);
}
.access p {
margin: 0;
overflow-wrap: anywhere;
}
.access-sessions {
list-style: none;
margin: 0.25rem 0 0;
padding: 0;
}
.access-sessions li {
display: flex;
flex-wrap: wrap;
justify-content: space-between;
gap: 0 0.75rem;
padding: 0.125rem 0;
overflow-wrap: anywhere;
}
@media (max-width: 30rem) {
.access {
grid-template-columns: auto minmax(0, 1fr);
}
.access form {
grid-column: 2;
}
}`;

/** The CSP source that allows that `<style>` and no other: its SHA-256. */
// allow-high-entropy-next-line: a hash of the public stylesheet above, not a secret
export const plainPageCssHash = "'sha256-b086NhpjuYap1cyhDl3uDHkP5h+7Jbwa67ix8CfwW/U='";
