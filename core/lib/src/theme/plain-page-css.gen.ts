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
--cloudflare: #f6821f;
--cloudflare-foreground: oklch(0.145 0 0);
--cloudflare-button: #c65102;
--cloudflare-button-foreground: #fff;
--cloudflare-button-hover: #ad4702;
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
main.centered {
max-width: 24rem;
margin: 0 auto;
padding-top: 3rem;
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
main.centered {
max-width: 24rem;
gap: 1.5rem;
padding: 2.5rem 2rem 2rem;
}
main.centered > .mark,
main.centered > .tile,
main.centered > .asks,
main.centered > h1 {
align-self: center;
text-align: center;
text-wrap: balance;
}
main.centered > .mark svg,
main.centered > .tile {
width: 2.75rem;
height: 2.75rem;
}
.asks {
display: flex;
align-items: center;
gap: 0.75rem;
}
.asks .mark svg,
.asks .tile {
width: 2.75rem;
height: 2.75rem;
}
.joins {
width: 1.5rem;
border-top: 2px dotted var(--ring);
}
.tile {
box-sizing: border-box;
display: grid;
place-items: center;
border-radius: 22.37%;
overflow: hidden;
border: 1px solid var(--border);
background: var(--card);
color: var(--foreground);
font-size: 1.125rem;
font-weight: 600;
}
.tile svg {
width: 60%;
height: 60%;
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
.ways {
display: flex;
flex-direction: column;
gap: 0.625rem;
}
main.centered :is(.ways, .stack) > button:not(.link) {
min-height: 2.875rem;
font-size: 0.9375rem;
}
main.centered p {
text-wrap: pretty;
}
main.centered > .center {
text-align: center;
}
main.centered > .note {
margin-top: -0.5rem;
font-size: 0.8125rem;
text-align: center;
text-wrap: balance;
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
input.code {
font-size: 1.125rem;
font-variant-numeric: tabular-nums;
letter-spacing: 0.25em;
text-align: center;
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
button.cloudflare {
background: var(--cloudflare-button);
color: var(--cloudflare-button-foreground);
font-weight: 600;
}
button.cloudflare:hover {
background: var(--cloudflare-button-hover);
}
button:has(> svg) {
display: inline-flex;
align-items: center;
justify-content: center;
gap: 0.625rem;
}
button > svg {
flex: none;
}
:focus-visible {
outline: 2px solid color-mix(in oklab, var(--foreground) 70%, transparent);
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
.state {
display: flex;
flex-wrap: wrap;
align-items: center;
justify-content: space-between;
gap: 0.75rem 1rem;
padding: 0.75rem 1rem;
border: 1px solid var(--border);
border-radius: var(--radius);
}
.state > p {
flex: 1 1 14rem;
}
dialog {
box-sizing: border-box;
width: calc(100% - 2rem);
max-width: 28rem;
padding: 1.5rem;
border: 1px solid var(--border);
border-radius: calc(var(--radius) + 4px);
background: var(--card);
color: var(--card-foreground);
box-shadow: 0 10px 15px -3px rgb(0 0 0 / 10%);
overflow-wrap: anywhere;
}
dialog[open] {
display: flex;
flex-direction: column;
gap: 1rem;
}
dialog::backdrop {
background: color-mix(in oklab, var(--foreground) 50%, transparent);
}
dialog li + li {
margin-top: 0.375rem;
}
dialog .actions {
justify-content: flex-end;
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
export const plainPageCssHash = "'sha256-fQ0xPDdwewssumsdWSH2GRZqatRTx/NsQVv30rrn/u0='";
