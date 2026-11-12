// app.js — THE GUESTBOOK'S PAGE. Anyone reads it. Someone signed in writes an entry or answers
// one. A member of the mind also sees every entry that waits, with Approve and Remove. It talks to
// app.ts alone, with fetch: a person who is no member holds no `itx`.
import { html, render, useCallback, useEffect, useState } from "@iterate-com/ui/page";
import { Badge } from "@iterate-com/ui/components/ui/badge";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Card, CardContent, CardFooter } from "@iterate-com/ui/components/ui/card";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";

const post = (path, body) =>
  // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- a refusal's body is JSON with its reason: it is read whatever the status, and `ok` goes with it
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (answer) => ({ ok: answer.ok, ...(await answer.json().catch(() => ({}))) }));

function App() {
  const [book, setBook] = useState(null);
  const load = useCallback(
    () =>
      fetch("/entries.json")
        // a read that failed keeps what the page shows: the next one is ten seconds away
        .then((answer) => (answer.ok ? answer.json().then(setBook) : undefined)),
    [],
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!book) return html`<p class="guestbook-note">Loading…</p>`;
  const { viewer, entries } = book;
  const top = entries.filter((entry) => entry.replyTo === undefined).reverse();
  return html`
    <main class="guestbook">
      <header class="guestbook-head">
        <h1>Guestbook</h1>
        ${viewer.email ? html`<${Account} viewer=${viewer} />` : html`<${Button} size="sm" render=${html`<a href="/sign-in" />`}>Sign in to write<//>`}
      </header>
      ${viewer.email && html`<${Write} onDone=${load} label="Write an entry" />`}
      ${top.length === 0 && html`<p class="guestbook-note">No entries yet.</p>`}
      ${top.map(
        (entry) => html`
          <${Entry} key=${entry.id} entry=${entry} viewer=${viewer} onDone=${load} />
          <div class="guestbook-replies">
            ${entries
              .filter((reply) => reply.replyTo === entry.id)
              .map(
                (reply) =>
                  html`<${Entry} key=${reply.id} entry=${reply} viewer=${viewer} onDone=${load} />`,
              )}
          </div>
        `,
      )}
    </main>
  `;
}

function Account({ viewer }) {
  return html`
    <form class="guestbook-row" method="post" action="/.iterate/sign-out">
      <span class="guestbook-note">${viewer.email}${viewer.member ? " (member)" : ""}</span>
      <${Button} type="submit" variant="ghost" size="sm">Sign out<//>
    </form>
  `;
}

function Entry({ entry, viewer, onDone }) {
  const [answering, setAnswering] = useState(false);
  const decide = (decision) => post(`/entries/${entry.id}/${decision}`).then(onDone);
  return html`
    <${Card}>
      <${CardContent}>
        <p class="guestbook-text">${entry.text}</p>
      <//>
      <${CardFooter} className="guestbook-row">
        <span class="guestbook-note">
          ${entry.author}, ${new Date(entry.at).toLocaleString()}
        </span>
        ${entry.status === "waiting" && html`<${Badge} variant="secondary">Waits for approval<//>`}
        ${
          viewer.member &&
          entry.status === "waiting" &&
          html`<${Button} size="sm" onClick=${() => decide("approve")}>Approve<//>`
        }
        ${
          viewer.member &&
          html`<${Button} size="sm" variant="outline" onClick=${() => decide("remove")}>Remove<//>`
        }
        ${
          viewer.email &&
          entry.status === "approved" &&
          entry.replyTo === undefined &&
          html`
            <${Button} size="sm" variant="ghost" onClick=${() => setAnswering(!answering)}>
              Reply
            <//>
          `
        }
      <//>
    <//>
    ${
      answering &&
      html`
        <${Write}
          label="Reply"
          replyTo=${entry.id}
          onDone=${() => {
            setAnswering(false);
            onDone();
          }}
        />
      `
    }
  `;
}

function Write({ label, replyTo, onDone }) {
  const [text, setText] = useState("");
  const [said, setSaid] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    const answer = await post("/entries", { text, replyTo });
    if (!answer.ok) return setSaid(answer.refused || "That did not work. Sign in again.");
    setText("");
    setSaid("Thank you. A member reads it before everyone sees it.");
    onDone();
  };
  return html`
    <form class="guestbook-form" onSubmit=${submit}>
      <${Textarea}
        value=${text}
        maxLength=${1000}
        placeholder=${label}
        onChange=${(event) => setText(event.target.value)}
      />
      <div class="guestbook-row">
        <${Button} type="submit" size="sm" disabled=${!text.trim()}>${label}<//>
        <span class="guestbook-note">${said}</span>
      </div>
    </form>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
