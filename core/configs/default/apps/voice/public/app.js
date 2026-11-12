// app.js — THE VOICE APP'S PAGE: this browser as a voice device of the mind (@iterate-com/voice).
// Call opens the microphone and presses; the mind's live model listens and speaks, and hands what
// it cannot answer to the device's own agent, /agents/voice/<device>, which remembers every call.
//
// The page shows one of three things:
//   1. Voice is off: the config repo does not install it. "Turn voice on" makes that commit.
//   2. Voice needs its key, or is still being installed.
//   3. The phone: Call, Hang up, and what was said.
//
// What it draws is @iterate-com/ui, loaded through the import map in index.html. The voice code
// itself comes from the build of @iterate-com/voice that this mind's package.json pins, so the
// page and the mind's relay are always the same build.
import { html, render, useEffect, useRef, useState } from "@iterate-com/ui/page";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/ui/field";
import { Input } from "@iterate-com/ui/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { newWebSocketRpcSession } from "@iterate-com/ui/live";
import { BotIcon, PhoneIcon } from "@iterate-com/ui/icons";
import { base64ToInt16, int16ToBase64, openAudio } from "./audio.js";
import { VOICE, filesWithVoiceOn } from "./turn-on.js";

const MODULES = "https://esm.iterate.com";
const EVENT = "events.iterate.com/voice-agent/";

// ── the member's itx ──
// As apps/agents/public/app.js: one WebSocket to this host's /itx, a capnweb session whose root is
// the mind's itx, as the member the platform signed in on this host. The platform ends it when
// the sign-in ends; a reload signs in again. Three closes in a minute stop the reloads.
const socket = new WebSocket(new URL("/itx", location.href.replace(/^http/, "ws")));
const itx = newWebSocketRpcSession(socket);
socket.addEventListener("close", () => {
  const now = Date.now();
  let closes = [];
  try {
    closes = JSON.parse(sessionStorage.getItem("itx-closes") || "[]").filter(
      (at) => now - at < 60_000,
    );
    sessionStorage.setItem("itx-closes", JSON.stringify([...closes, now]));
  } catch {
    // no storage: one reload is still right
  }
  if (closes.length < 3) setTimeout(() => location.reload(), 1000);
  else document.getElementById("root").textContent = "Disconnected. Reload the page to connect.";
});

const { principal } = await itx.whoami();
/** The config repo's handle. A stub is used for one call, so each read asks for it again. */
const repo = () => itx.repos.get("/repos/config");

// The mind is its domain, and this host is one label under it.
const domain = location.hostname.split(".").slice(1).join(".") || location.hostname;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// ── what the mind has of voice ──

/** The build of voice the config repo pins, whether `itx.voice` is installed (the init case in
 *  worker.ts writes that rule), and whether the mind has the live model's key. */
async function readVoice() {
  // the one secret is asked about by its path: `secrets.list()` asks the vault about every secret
  // the mind ever had
  const [manifest, rule, key] = await Promise.all([
    repo().readFile("package.json"),
    itx.rewriteRules.get("itx.voice"),
    itx.secrets.describe("/secrets/openai"),
  ]);
  let pin;
  try {
    pin = JSON.parse(manifest || "{}").dependencies?.[VOICE];
  } catch {
    // a package.json that is not JSON pins nothing
  }
  return {
    pin,
    installed: Boolean(rule?.target),
    hasKey: key.set,
  };
}

/** A module of the voice build the mind pins: `call` is the device's client, `install` the set-up. */
const voiceModule = (pin, name) => import(`${MODULES}/${VOICE}@${pin}/${name}`);

// ── turning voice on ──
// The commit is turn-on.js's: this function finds the newest build, makes the commit as the
// member, and waits for the platform to publish it.

async function turnVoiceOn(say) {
  say("Finding the newest build of voice…");
  // npm's `main` tag, as esm.iterate.com resolves it: the page pins the exact build it names
  const [newest, tip] = await Promise.all([
    fetch(`${MODULES}/${VOICE}@main/package.json`),
    repo().tip(),
  ]);
  if (!newest.ok) throw new Error(`${MODULES} answered ${newest.status} for ${VOICE}@main`);
  const [{ version }, manifest, worker, voiceFile] = await Promise.all([
    newest.json(),
    repo().readFile("package.json", { commitOid: tip }),
    repo().readFile("worker.ts", { commitOid: tip }),
    repo()
      .readFile("voice.ts", { commitOid: tip })
      .catch(() => null),
  ]);
  const changes = filesWithVoiceOn({ manifest, worker, voiceFile, version });
  say("Committing to the config repo…");
  const { commitOid } = await repo().commitFiles({
    message: `Turn voice on: ${VOICE} ${version}\n\nVia: the Voice app`,
    parent: tip,
    changes,
  });
  say("Publishing the mind's code…");
  // one deadline for the whole wait: the platform can give up for now and still owe the commit
  const deadline = Date.now() + 120_000;
  for (let afterOffset = 0; ;) {
    const outcome = await itx.waitForEvent({
      type: [
        "events.iterate.com/mind/worker-updated",
        "events.iterate.com/mind/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (outcome.type.endsWith("/worker-updated")) return;
    if (!outcome.payload?.unavailable)
      throw new Error(`The commit was not published: ${String(outcome.payload?.error)}`);
    afterOffset = outcome.offset;
  }
}

// ── this browser as a device ──

/** This browser's name as a device, kept across visits: every call from this browser is one
 *  device's, with one agent that remembers. */
function deviceName() {
  const key = "iterate-voice-device";
  try {
    const kept = localStorage.getItem(key);
    if (kept && /^web-[0-9a-f]{12}$/.test(kept)) return kept;
  } catch {
    // storage refused (a private window): the name lasts as long as the page
  }
  const name = `web-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  try {
    localStorage.setItem(key, name);
  } catch {
    // as above
  }
  return name;
}

const DEVICE = deviceName();

function App() {
  // what the mind has of voice: undefined while the page reads it
  const [voice, setVoice] = useState();
  const [error, setError] = useState();
  const read = () =>
    readVoice().then(setVoice, (failure) =>
      setError(`Could not read the mind: ${messageOf(failure)}`),
    );
  useEffect(() => {
    read();
  }, []);
  let view = html`<p className="muted" data-spinner="true">Reading the mind…</p>`;
  if (error) view = html`<p role="alert" className="error">${error}</p>`;
  else if (voice && !voice.pin) view = html`<${VoiceOff} onDone=${read} />`;
  else if (voice && !(voice.installed && voice.hasKey))
    view = html`<${SetUp} pin=${voice.pin} needsKey=${!voice.hasKey} onDone=${read} />`;
  else if (voice) view = html`<${Phone} pin=${voice.pin} />`;
  return html`
    <${AppShell}
      app="Voice"
      mind=${domain}
      mindHref=${() => "./"}
      nav=${html`<${Nav} />`}
      account=${principal}
      locationKey="/"
    >
      <div className="voice-scroll"><div className="voice">${view}</div></div>
    <//>
  `;
}

/** 1. The config repo does not install voice. */
function VoiceOff({ onDone }) {
  const [step, setStep] = useState();
  const [error, setError] = useState();
  const turnOn = async () => {
    setError(undefined);
    try {
      await turnVoiceOn(setStep);
      await onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setStep(undefined);
    }
  };
  return html`
    <h1>Voice is off</h1>
    <p>
      With voice on, you talk to ${domain} from this page: a live model listens and speaks, and one
      of the mind's agents does the work.
    </p>
    <p className="muted">
      "Turn voice on" makes one commit to this mind's config repo, in your name: package.json pins
      the newest build of ${VOICE}, voice.ts is added, and two lines of worker.ts are switched on.
      You can read it in the Docs app afterwards, and revert it like any commit.
    </p>
    <div>
      <${Button} size="lg" onClick=${turnOn} disabled=${Boolean(step)} data-turn-on>
        ${step || "Turn voice on"}
      <//>
    </div>
    ${error ? html`<p role="alert" className="error">${error}</p>` : null}
  `;
}

/** 2. Voice is in the config repo, and cannot take a call yet: the mind has no key for the live
 *  model, or its init case has yet to install `itx.voice`. `ensureVoiceAgent` is the package's own
 *  check: it stores the key, waits for the install and asks the service for its health. */
function SetUp({ pin, needsKey, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState();
  const setUp = async (key) => {
    setBusy(true);
    setError(undefined);
    try {
      const { ensureVoiceAgent } = await voiceModule(pin, "install");
      await ensureVoiceAgent(itx, key);
      await onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  // with the key there already, the wait for the install starts by itself
  useEffect(() => {
    if (!needsKey) setUp();
  }, [needsKey]);
  if (!needsKey && error)
    return html`
      <h1>Setting up voice</h1>
      <p role="alert" className="error">${error}</p>
      <div><${Button} onClick=${() => setUp()} disabled=${busy}>Try again<//></div>
    `;
  if (!needsKey)
    return html`
      <h1>Setting up voice</h1>
      <p className="muted" data-spinner="true">The mind is installing voice…</p>
    `;
  return html`
    <form
      className="voice-form"
      onSubmit=${(event) => {
        event.preventDefault();
        setUp(String(new FormData(event.currentTarget).get("openai-key") || ""));
      }}
    >
      <h1>Voice needs an OpenAI key</h1>
      <p>Voice talks to OpenAI's live model with your key.</p>
      <${Field}>
        <${FieldLabel} htmlFor="openai-key">OpenAI API key<//>
        <${Input}
          id="openai-key"
          name="openai-key"
          type="password"
          autoComplete="new-password"
          required
        />
        <${FieldDescription}>
          Saved as the secret /secrets/openai in this mind, and only ever sent to api.openai.com.
        <//>
      <//>
      <div>
        <${Button} type="submit" size="lg" disabled=${busy}>
          ${busy ? "Setting up…" : "Save the key"}
        <//>
      </div>
      ${error ? html`<p role="alert" className="error">${error}</p>` : null}
    </form>
  `;
}

/** 3. The phone. This browser is provisioned as a device when the page opens, so Call only
 *  presses. Call opens the microphone inside the click, because the browser wants the gesture. */
function Phone({ pin }) {
  // the device: `{ device }` once it is provisioned, `{ error }` if it could not be
  const [opened, setOpened] = useState();
  // the call in progress and its audio: read by Hang up and by the call's own facts, never drawn
  const current = useRef();
  // "calling" from the press, "live" once the model listens, undefined with no call
  const [phase, setPhase] = useState();
  const [speaking, setSpeaking] = useState(false);
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState();
  const [last, setLast] = useState();

  useEffect(() => {
    let gone = false;
    let device;
    (async () => {
      try {
        const { connectVoiceDevice } = await voiceModule(pin, "call");
        device = await connectVoiceDevice(itx, { client: DEVICE });
        if (gone) device.close();
        else setOpened({ device });
      } catch (failure) {
        if (!gone) setOpened({ error: `Voice is not answering: ${messageOf(failure)}` });
      }
    })();
    return () => {
      gone = true;
      device?.close();
    };
  }, [pin]);

  /** The call is over, whoever ended it: the microphone closes, and the page says how it went. */
  const over = async (reason) => {
    const ended = current.current;
    if (!ended) return;
    current.current = undefined;
    ended.audio.onFrame = null;
    setPhase(undefined);
    setSpeaking(false);
    const { pressToAcceptedMs, pressToFirstAudioMs } = ended.call.stats;
    setLast(
      [
        reason && `The call ended: ${reason}.`,
        pressToAcceptedMs !== null && `It connected ${pressToAcceptedMs} ms after the press.`,
        pressToFirstAudioMs !== null && `The first sound came after ${pressToFirstAudioMs} ms.`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    await ended.audio.close().catch(() => {});
  };

  const onCall = async () => {
    setBusy(true);
    setError(undefined);
    setLast(undefined);
    setTurns([]);
    let audio;
    try {
      audio = await openAudio(); // inside the click: the browser wants a gesture
      const say = (role, text) => setTurns((before) => [...before, { role, text }]);
      const call = opened.device.call({
        onSpeakerFrame: (frame) => {
          if (frame.clearSpeakerBufferBeforeFrame) audio.speaker.clear();
          if (frame.pcm) audio.speaker.push(base64ToInt16(frame.pcm));
          setSpeaking(!frame.lastFrameOfAnswer);
        },
        onFact: (fact) => {
          const { payload } = fact;
          if (fact.type === `${EVENT}conversation-accepted`) setPhase("live");
          else if (fact.type === `${EVENT}utterance-transcribed`) say("listener", payload.text);
          else if (fact.type === `${EVENT}answer-transcribed`) say("assistant", payload.text);
          else if (fact.type === `${EVENT}provider-error-reported`)
            setError(`The live model reported: ${payload.message}`);
          else if (fact.type === `${EVENT}call-ended`) over(payload.reason);
        },
      });
      current.current = { call, audio };
      setPhase("calling");
      // The press is on its way: the microphone's frames follow it at once.
      audio.onFrame = (pcm) => call.sendMicFrame(int16ToBase64(pcm));
      call.pressed.catch((failure) => {
        setError(`The call was refused: ${messageOf(failure)}`);
        over();
      });
    } catch (failure) {
      setError(
        failure?.name === "NotAllowedError"
          ? "The browser did not give this page the microphone. Allow it for this site, then call again."
          : messageOf(failure),
      );
      await audio?.close().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const onHangUp = async () => {
    setBusy(true);
    try {
      // its `call-ended` comes back through the subscription, and ends the call above
      await current.current?.call.hangUp("hung up");
      await over("hung up");
    } finally {
      setBusy(false);
    }
  };

  let title = `Talk to ${domain}`;
  if (phase === "calling") title = "Calling…";
  if (phase === "live") title = speaking ? "Speaking…" : "Listening";
  const device = opened?.device;
  let button = html`
    <${Button} key="call" size="lg" onClick=${onCall} disabled=${busy || !device} data-call>
      ${opened ? (busy ? "Connecting…" : "Call") : "Getting ready…"}
    <//>
  `;
  if (phase)
    button = html`
      <${Button} key="hang-up" size="lg" variant="destructive" onClick=${onHangUp} disabled=${busy}>
        Hang up
      <//>
    `;
  return html`
    <h1 data-phase=${phase || "idle"}>${title}</h1>
    <div>${button}</div>
    ${opened?.error ? html`<p role="alert" className="error">${opened.error}</p>` : null}
    ${error ? html`<p role="alert" className="error">${error}</p>` : null}
    ${turns.length ? html`<${Turns} turns=${turns} />` : null}
    ${!phase && last ? html`<p className="muted" data-last-call>${last}</p>` : null}
    ${device ? html`<${DeviceNote} agentPath=${device.agentPath} />` : null}
  `;
}

/** What was said in the call: the person's words and the voice's, in order. */
function Turns({ turns }) {
  return html`
    <ol className="voice-turns" aria-label="What was said">
      ${turns.map((turn, index) => html`<li key=${index} data-role=${turn.role}>${turn.text}</li>`)}
    </ol>
  `;
}

/** Which device this browser is, and the way to its agent's chat in the Agents app. */
function DeviceNote({ agentPath }) {
  return html`
    <div className="voice-note">
      <p className="muted">
        This browser is the device ${DEVICE}. Its agent answers every call from here and remembers
        them.
      </p>
      <p className="muted">
        <a href=${`https://agents.${domain}/?agent=${encodeURIComponent(agentPath)}`}>
          Open that agent's chat
        </a>
      </p>
    </div>
  `;
}

/** The sidebar's two rows: the phone, and the way to every agent. */
function Nav() {
  return html`
    <${SidebarGroup}>
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          <${SidebarMenuItem}>
            <${SidebarMenuButton} isActive tooltip="Call" render=${html`<a href="./" />`}>
              <${PhoneIcon} />
              <span>Call</span>
            <//>
          <//>
          <${SidebarMenuItem}>
            <${SidebarMenuButton}
              tooltip="All agents"
              render=${html`<a href=${`https://agents.${domain}`} />`}
            >
              <${BotIcon} />
              <span>All agents</span>
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
