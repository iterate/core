// app.js — THE ONBOARDING WIZARD: a centered, no-AI 3-step setup flow.
//   Step 1: Connect to iterate Cloud (optional, collapsible fine print)
//   Step 2: Configure AI (iterate Cloud credit, OpenAI API key, ChatGPT Plus/Pro, or Cloudflare AI Gateway)
//   Step 3: Verify & wake gate (real server-side POST /verify-ai + wait for /agents/onboarding's
//           first assistant response, then show the verified result and clear Done state with link
//           into https://dash.<zone>/?agent=/agents/onboarding)
import { html, render, useCallback, useEffect, useRef, useState } from "@iterate-com/ui/page";
import { Badge } from "@iterate-com/ui/components/ui/badge";
import { Button, buttonVariants } from "@iterate-com/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/ui/card";
import { Spinner } from "@iterate-com/ui/components/ui/spinner";
import { newWebSocketRpcSession, useContextStub, useIterateContext } from "@iterate-com/ui/live";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from "@iterate-com/ui/icons";

const AGENT = "/agents/onboarding";
const CLOUD_STEP = "connect-iterate-cloud";

/** The idempotent opener for /agents/onboarding, matching Dash's apps/dash/public/app.js. */
const OPENER =
  "The owner has just opened this chat for the first time and has typed nothing yet. Send your first message now: words only, no script (onboarding.md, 'Your first message').";

// ── the member's itx ──
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

const hostSession =
  window.__session ?? fetch("/.auth/session.json").then((answer) => answer.json());
const mind = new URL((await hostSession).issuer).hostname;
const zone = location.hostname.split(".").slice(1).join(".");
const dashOnboardingUrl = `https://dash.${zone}/?agent=${AGENT}`;

async function ask(path, method = "GET") {
  const response = await fetch(path, { method });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${path} answered ${response.status}`);
  return body;
}

/** True only when the model itself has produced a visible reply: either prose carrying
 *  `llmRequestOffset`, or a script-written message after a model-authored assistant turn.
 *  Code-written notices like credit-spent carry no `llmRequestOffset` and precede any model turn. */
const hasModelReply = (events) => {
  const firstModelOffset = events.find(
    (event) =>
      event.type === "events.iterate.com/agent/context-added" &&
      event.payload?.role === "assistant" &&
      event.payload?.llmRequestOffset !== undefined,
  )?.offset;
  return events.some(
    (event) =>
      event.type === "events.iterate.com/agent/web-message-sent" &&
      (event.payload?.llmRequestOffset !== undefined ||
        (firstModelOffset !== undefined && event.offset > firstModelOffset)),
  );
};

function friendlyWakeError(raw) {
  const text = String(raw || "").trim();
  if (!text || text.startsWith("{") || text.includes('"error"'))
    return "Your onboarding agent could not complete its first response. Check your AI configuration and try again.";
  if (/402|credit|billing|quota|payment/i.test(text))
    return "Your AI provider reported a billing or credit issue. Go back to check your AI configuration.";
  if (/401|invalid.*key|unauthorized/i.test(text))
    return "Your AI credentials were rejected. Go back to update your AI configuration.";
  return text.slice(0, 240);
}

const PROVIDER_LABELS = {
  chatgpt: "ChatGPT Plus/Pro",
  "iterate-cloud": "iterate Cloud credit",
  openai: "OpenAI API key",
  "ai-gateway": "Cloudflare AI Gateway",
};

function verifySummaryOf(result) {
  const provider = PROVIDER_LABELS[result.provider] || result.provider;
  const parts = [result.model || "model"];
  if (result.reply) parts.push(`replied "${result.reply}"`);
  else parts.push("responded");
  if (result.usage) {
    const total = result.usage.inputTokens + result.usage.outputTokens;
    parts.push(`(${total} tokens)`);
  }
  return `${provider}: ${parts.join(" ")}.`;
}

function App() {
  const [cards, setCards] = useState();
  const [aiStatus, setAiStatus] = useState();
  const [loadError, setLoadError] = useState();
  const [step, setStep] = useState();
  const [verified, setVerified] = useState();
  const [busy, setBusy] = useState();
  const [actionError, setActionError] = useState();
  const initializedRef = useRef(false);
  const prevCloudStatusRef = useRef();

  const reload = useCallback(async () => {
    try {
      const [nextCards, nextAi] = await Promise.all([ask("/steps.json"), ask("/ai-status.json")]);
      setCards(nextCards);
      setAiStatus(nextAi);
      setLoadError(undefined);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  // Watch the onboarding log live so passkey signing updates Step 1 immediately.
  const onboardingLog = useContextStub(() => itx.cd("/apps/onboarding"), []);
  const liveOnboarding = useIterateContext(onboardingLog.stub, {
    consumes: [
      "onboarding/step-declined",
      "onboarding/step-action-requested",
      "onboarding/step-action-settled",
      "onboarding/step-checked",
    ],
  });
  const onboardingHead = liveOnboarding.events.at(-1)?.offset;
  useEffect(() => {
    void reload();
  }, [reload, onboardingHead]);

  // Watch /agents/onboarding live so revisiting onboarding after setup shows "Done", and Step 3
  // sees the first model-authored reply immediately.
  const agent = useContextStub(() => itx.cd(AGENT), []);
  const agentContext = useIterateContext(agent.stub, {
    consumes: [
      "events.iterate.com/agent/web-message-sent",
      "events.iterate.com/agent/context-added",
      "events.iterate.com/agent/message-received",
      "events.iterate.com/agent/llm-request-started",
      "events.iterate.com/agent/llm-request-settled",
    ],
  });

  // Refresh state when the user returns from a passkey, OpenAI key, or Cloudflare tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const cloudCard = cards?.find((card) => card.step === CLOUD_STEP);
  const offersCloud = Boolean(cloudCard);

  const handleVerified = useCallback((result) => {
    setVerified(result);
    setStep(4);
  }, []);

  // Choose the initial step once loaded, and auto-advance from Step 1 once iterate Cloud connects.
  // Do not block the wizard if watching /agents/onboarding fails.
  const agentSettled = Boolean(agentContext.caughtUp || agent.error || agentContext.error);
  useEffect(() => {
    if (!cards || !aiStatus || !agentSettled) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      prevCloudStatusRef.current = cloudCard?.status;
      if (agentContext.caughtUp && hasModelReply(agentContext.events)) {
        setStep(4);
      } else if (
        !cloudCard ||
        cloudCard.status === "connected" ||
        cloudCard.status === "own-keys"
      ) {
        setStep(2);
      } else {
        setStep(1);
      }
      return;
    }
    const prev = prevCloudStatusRef.current;
    prevCloudStatusRef.current = cloudCard?.status;
    if (step === 1 && prev === "connecting" && cloudCard?.status === "connected") {
      setStep(2);
    }
  }, [cards, aiStatus, cloudCard, step, agentSettled, agentContext.caughtUp, agentContext.events]);

  async function pressCloud(button) {
    const tab = button.opens ? window.open("about:blank", "_blank") : null;
    setBusy(button.action);
    setActionError(undefined);
    try {
      const answer = await ask(`/steps/${CLOUD_STEP}/${button.action}`, "POST");
      if (tab && answer.link) tab.location.href = answer.link;
      else tab?.close();
      if (!tab && answer.link) window.location.assign(answer.link);
      await reload();
    } catch (failure) {
      tab?.close();
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(undefined);
    }
  }

  async function skipCloud() {
    setActionError(undefined);
    const shouldDecline =
      cloudCard &&
      (cloudCard.status === "not-asked" ||
        cloudCard.status === "unavailable" ||
        cloudCard.status === "waiting" ||
        cloudCard.status === "connecting");
    if (shouldDecline) {
      setBusy("decline");
      try {
        await ask(`/steps/${CLOUD_STEP}/decline`, "POST");
        await reload();
      } catch (failure) {
        setActionError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(undefined);
      }
    }
    setStep(2);
  }

  async function openOpenAiKeyForm() {
    const tab = window.open("about:blank", "_blank");
    setBusy("collect-openai-key");
    setActionError(undefined);
    try {
      const { link } = await ask("/collect-openai-key", "POST");
      if (tab && link) tab.location.href = link;
      else if (link) window.location.assign(link);
      else tab?.close();
    } catch (failure) {
      tab?.close();
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(undefined);
    }
  }

  if (loadError && !cards) {
    return html`
      <main className="wizard-page">
        <div className="wizard-shell">
          <${Card}>
            <${CardHeader}>
              <${CardTitle}>Could not load onboarding<//>
              <${CardDescription} className="wizard-error-text" role="alert">${loadError}<//>
            <//>
            <${CardFooter}>
              <${Button} onClick=${() => void reload()}>Try again<//>
            <//>
          <//>
        </div>
      </main>
    `;
  }

  if (!cards || !aiStatus || step === undefined) {
    return html`
      <main className="wizard-page">
        <div className="wizard-gate">
          <${Spinner} className="size-6" />
          <p className="wizard-gate-desc">Loading your mind…</p>
        </div>
      </main>
    `;
  }

  const wizardSteps = offersCloud
    ? [
        { id: 1, label: "1. iterate Cloud" },
        { id: 2, label: "2. Configure AI" },
        { id: 3, label: "3. Verify & launch" },
      ]
    : [
        { id: 2, label: "1. Configure AI" },
        { id: 3, label: "2. Verify & launch" },
      ];

  let activeStep = null;
  if (step === 1 && cloudCard) {
    activeStep = html`
      <${CloudStep}
        card=${cloudCard}
        busy=${busy}
        error=${actionError}
        onPress=${pressCloud}
        onSkip=${skipCloud}
        onContinue=${() => setStep(2)}
      />
    `;
  } else if (step === 2) {
    activeStep = html`
      <${AiStep}
        aiStatus=${aiStatus}
        cloudCard=${cloudCard}
        offersCloud=${offersCloud}
        busy=${busy}
        error=${actionError}
        onBack=${() => setStep(1)}
        onAddOpenAiKey=${openOpenAiKeyForm}
        onRefresh=${reload}
        onContinue=${() => {
          setActionError(undefined);
          setStep(3);
        }}
      />
    `;
  } else if (step === 3) {
    activeStep = html`
      <${VerifyStep}
        agent=${agent}
        agentContext=${agentContext}
        onBackToAi=${() => {
          void reload();
          setStep(2);
        }}
        onDone=${handleVerified}
      />
    `;
  } else if (step === 4) {
    activeStep = html`
      <${DoneStep}
        verifyResult=${verified}
        aiStatus=${aiStatus}
        cloudCard=${cloudCard}
        onReviewAi=${() => {
          void reload();
          setStep(2);
        }}
      />
    `;
  }

  return html`
    <main className="wizard-page">
      <div className="wizard-shell">
        <header className="wizard-brand">
          <p className="wizard-mind">${mind}</p>
          <ol className="wizard-stepper" aria-label="Setup progress">
            ${wizardSteps.map((item) => {
              const state = item.id === step ? "active" : item.id < step ? "done" : "upcoming";
              const clickable = step !== 3 && item.id !== step && item.id < 3;
              return html`
                <li key=${item.id}>
                  <button
                    type="button"
                    className="wizard-step-pill"
                    data-state=${state}
                    data-clickable=${clickable ? "true" : "false"}
                    disabled=${!clickable}
                    onClick=${() => clickable && setStep(item.id)}
                  >
                    ${state === "done" ? html`<${CheckIcon} className="size-3" />` : null}
                    <span>${item.label}</span>
                  </button>
                </li>
              `;
            })}
          </ol>
        </header>
        ${activeStep}
      </div>
    </main>
  `;
}

// ── Step 1: Connect to iterate Cloud (optional) ──

function CloudFinePrint({ extraText, points, footnote }) {
  let pointList = null;
  if (points?.length) {
    pointList = html`
      <dl className="wizard-points">
        ${points.map(
          (point) => html`
            <div key=${point.title}>
              <dt>${point.title}</dt>
              <dd>${point.text}</dd>
            </div>
          `,
        )}
      </dl>
    `;
  }
  return html`
    <details className="wizard-details">
      <summary>How it works & privacy details</summary>
      <div className="wizard-details-body">
        ${extraText.map((line) => html`<p key=${line} className="m-0">${line}</p>`)} ${pointList}
        ${footnote ? html`<p className="wizard-footnote">${footnote}</p>` : null}
      </div>
    </details>
  `;
}

function CloudStep({ card, busy, error, onPress, onSkip, onContinue }) {
  const status = card.status;
  const summary = card.text[0];
  // Show the iterate approval sentence outside the fold so owners read it before pressing Connect.
  const approvalLine = card.text.slice(1).find((line) => /approves each mind/i.test(line));
  const extraText = card.text.slice(1).filter((line) => line !== approvalLine);
  const hasFinePrint =
    extraText.length > 0 || Boolean(card.points?.length) || Boolean(card.footnote);
  const connectBtn = card.buttons.find((b) => b.action === "connect");
  const disconnectBtn = card.buttons.find((b) => b.action === "disconnect");
  const checkBtn = card.buttons.find((b) => b.action === "check");
  const waitingLink = card.buttons.find((b) => b.href && !b.href.endsWith("/open-cloud"));
  const showHeaderSummary =
    Boolean(summary) &&
    status !== "failed" &&
    status !== "connected" &&
    status !== "connecting" &&
    status !== "disconnecting";

  let statusBanner = null;
  if (status === "failed" && summary) {
    statusBanner = html`
      <div className="wizard-status-banner" data-tone="error" role="alert">
        <${CircleAlertIcon} className="size-4 shrink-0 mt-0.5" />
        <span>${card.text.join(" ")}</span>
      </div>
    `;
  } else if (status === "connecting" || status === "disconnecting") {
    statusBanner = html`
      <div className="wizard-status-banner">
        <${Spinner} className="size-4 shrink-0 mt-0.5" />
        <span>${card.text.join(" ") || "Waiting for your passkey…"}</span>
      </div>
    `;
  } else if (status === "connected") {
    statusBanner = html`
      <div className="wizard-status-banner">
        <${CircleCheckIcon} className="size-4 shrink-0 mt-0.5" />
        <span>${card.text.join(" ")}</span>
      </div>
    `;
  }

  let primaryButton;
  let secondaryButton = null;
  if (status === "connected") {
    if (connectBtn) {
      primaryButton = html`
        <${Button}
          disabled=${Boolean(busy)}
          data-action="connect"
          onClick=${() => onPress(connectBtn)}
        >
          ${busy === "connect" ? html`<${Spinner} /> Connecting…` : connectBtn.label}
        <//>
      `;
      secondaryButton = html`<${Button} variant="outline" onClick=${onContinue}>Continue<//>`;
    } else {
      primaryButton = html`<${Button} onClick=${onContinue}>Continue<//>`;
    }
  } else if ((status === "connecting" || status === "disconnecting") && waitingLink?.href) {
    primaryButton = html`
      <a
        className=${buttonVariants({ variant: "default" })}
        href=${waitingLink.href}
        target="_blank"
        rel="noopener"
      >
        ${waitingLink.label}
      </a>
    `;
  } else if (status === "disconnecting" && disconnectBtn) {
    primaryButton = html`
      <${Button}
        disabled=${Boolean(busy)}
        data-action="disconnect"
        onClick=${() => onPress(disconnectBtn)}
      >
        ${busy === "disconnect" ? html`<${Spinner} /> Disconnecting…` : disconnectBtn.label}
      <//>
    `;
  } else if (connectBtn) {
    primaryButton = html`
      <${Button}
        disabled=${Boolean(busy)}
        data-action="connect"
        onClick=${() => onPress(connectBtn)}
      >
        ${busy === "connect" ? html`<${Spinner} /> Connecting…` : connectBtn.label}
      <//>
    `;
  } else if (checkBtn) {
    primaryButton = html`
      <${Button} disabled=${Boolean(busy)} data-action="check" onClick=${() => onPress(checkBtn)}>
        ${busy === "check" ? html`<${Spinner} /> Checking…` : checkBtn.label}
      <//>
    `;
  } else {
    primaryButton = html`<${Button} onClick=${onContinue}>Continue<//>`;
  }

  let skipButton = null;
  if (status !== "connected") {
    skipButton = html`
      <${Button} variant="outline" disabled=${Boolean(busy)} data-action="skip" onClick=${onSkip}>
        Skip
      <//>
    `;
  }

  // this mind's page on iterate Cloud: a plain link to this app's /open-cloud, which signs the
  // open and posts its one-use token in the new tab (open-cloud.ts)
  const openCloudLink = card.buttons.find((b) => b.href?.endsWith("/open-cloud"));
  let openCloudButton = null;
  if (openCloudLink) {
    openCloudButton = html`
      <a
        className=${buttonVariants({ variant: "ghost", size: "sm" })}
        data-action="open-cloud"
        href=${openCloudLink.href}
        target="_blank"
        rel="noopener"
      >
        ${openCloudLink.label}
      </a>
    `;
  }

  let disconnectButton = null;
  if (disconnectBtn && status !== "disconnecting") {
    disconnectButton = html`
      <${Button}
        variant="ghost"
        size="sm"
        disabled=${Boolean(busy)}
        data-action="disconnect"
        onClick=${() => onPress(disconnectBtn)}
      >
        ${disconnectBtn.label}
      <//>
    `;
  }

  let footerEnd = null;
  if (openCloudButton || disconnectButton) {
    footerEnd = html`
      <div className="wizard-actions-group">${openCloudButton} ${disconnectButton}</div>
    `;
  }

  let finePrint = null;
  if (hasFinePrint && status !== "failed" && status !== "connected" && status !== "disconnecting") {
    finePrint = html`
      <${CloudFinePrint} extraText=${extraText} points=${card.points} footnote=${card.footnote} />
    `;
  }

  return html`
    <${Card} data-step="cloud" data-status=${status}>
      <${CardHeader}>
        <${CardTitle} className="wizard-card-title">
          <${SparklesIcon} className="size-4" />
          <span>${card.title}</span>
          ${card.optional ? html`<${Badge} variant="outline">optional<//>` : null}
        <//>
        ${showHeaderSummary ? html`<${CardDescription}>${summary}<//>` : null}
        ${showHeaderSummary && approvalLine ? html`<${CardDescription}>${approvalLine}<//>` : null}
      <//>

      <${CardContent} className="wizard-options">
        ${error ? html`<p className="wizard-error-text" role="alert">${error}</p>` : null}
        ${statusBanner} ${card.command ? html`<${CopyCommand} command=${card.command} />` : null}
        ${finePrint}
      <//>

      <${CardFooter} className="wizard-actions">
        <div className="wizard-actions-group">
          ${primaryButton} ${secondaryButton} ${skipButton}
        </div>
        ${footerEnd}
      <//>
    <//>
  `;
}

// ── Step 2: Configure AI ──

function AiStep({
  aiStatus,
  cloudCard,
  offersCloud,
  busy,
  error,
  onBack,
  onAddOpenAiKey,
  onRefresh,
  onContinue,
}) {
  const hasCloudCredit = aiStatus.openai === "iterate-proxy" && cloudCard?.status === "connected";
  const hasChatgpt = aiStatus.chatgpt;
  const hasOwnOpenAi = aiStatus.openai === "own" || aiStatus.openai === "other-proxy";
  const hasReadyProvider = hasCloudCredit || hasChatgpt || hasOwnOpenAi;
  const chatgptCommand = `npx iterate@latest chatgpt connect ${aiStatus.mind}`;

  const readyLabels = [
    hasChatgpt && "ChatGPT Plus/Pro plan is connected.",
    hasOwnOpenAi && "Your OpenAI API key is saved.",
    hasCloudCredit &&
      `iterate Cloud credit is connected${cloudCard?.text?.[0] ? ` (${cloudCard.text[0]})` : ""}.`,
  ].filter(Boolean);

  const openAiLabel =
    busy === "collect-openai-key"
      ? html`<${Spinner} /> Opening…`
      : hasOwnOpenAi
        ? "Replace OpenAI API key"
        : "Add OpenAI API key";

  const optionsList = html`
    <div className="wizard-options">
      <div className="wizard-option">
        <div className="wizard-option-header">
          <h3 className="wizard-option-title">
            <${KeyRoundIcon} className="size-4" />
            <span>OpenAI API key</span>
          </h3>
          ${hasOwnOpenAi ? html`<${Badge} variant="secondary">Saved<//>` : null}
        </div>
        <p className="wizard-option-desc">
          Stored in your mind's secret vault and sent only to api.openai.com.
        </p>
        <div>
          <${Button}
            variant="outline"
            size="sm"
            disabled=${Boolean(busy)}
            data-action="collect-openai-key"
            onClick=${onAddOpenAiKey}
          >
            ${openAiLabel}
          <//>
        </div>
      </div>

      <div className="wizard-option">
        <div className="wizard-option-header">
          <h3 className="wizard-option-title">
            <${SquareTerminalIcon} className="size-4" />
            <span>ChatGPT Plus or Pro</span>
          </h3>
          ${hasChatgpt ? html`<${Badge} variant="secondary">Connected<//>` : null}
        </div>
        <p className="wizard-option-desc">
          Run this command on your computer to connect your personal ChatGPT subscription:
        </p>
        <${CopyCommand} command=${chatgptCommand} />
      </div>

      <div className="wizard-option">
        <div className="wizard-option-header">
          <h3 className="wizard-option-title">
            <${ExternalLinkIcon} className="size-4" />
            <span>Cloudflare AI Gateway credit</span>
          </h3>
        </div>
        <p className="wizard-option-desc">
          Use prepaid AI Gateway credit in your own Cloudflare account with no extra key.
        </p>
        <div>
          <a
            className=${buttonVariants({ variant: "outline", size: "sm" })}
            href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
            target="_blank"
            rel="noopener"
          >
            Open Cloudflare AI Gateway
          </a>
        </div>
      </div>
    </div>
  `;

  let bodyContent = optionsList;
  if (hasReadyProvider) {
    bodyContent = html`
      <div className="wizard-status-banner">
        <${CircleCheckIcon} className="size-4 shrink-0 mt-0.5" />
        <span>${readyLabels.join(" ")}</span>
      </div>
      <details className="wizard-details">
        <summary>Add or change AI credentials</summary>
        <div className="wizard-details-body">${optionsList}</div>
      </details>
    `;
  }

  return html`
    <${Card} data-step="ai">
      <${CardHeader}>
        <${CardTitle}>Configure AI<//>
        <${CardDescription}>
          ${
            hasReadyProvider
              ? "Your mind has an AI connection configured. Continue to verify that it works."
              : "Choose how your mind pays for AI models before launching your onboarding agent."
          }
        <//>
      <//>

      <${CardContent} className="wizard-options">
        ${error ? html`<p className="wizard-error-text" role="alert">${error}</p>` : null}
        ${bodyContent}
      <//>

      <${CardFooter} className="wizard-actions">
        <div className="wizard-actions-group">
          ${offersCloud ? html`<${Button} variant="outline" onClick=${onBack}>Back<//>` : null}
          <${Button} variant="ghost" size="sm" onClick=${() => void onRefresh()}> Refresh <//>
        </div>
        <${Button} data-action="verify-and-launch" onClick=${onContinue}> Verify & launch <//>
      <//>
    <//>
  `;
}

// ── Step 3: Verify & wake gate ──

function VerifyStep({ agent, agentContext, onBackToAi, onDone }) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState("verifying-ai"); // "verifying-ai" | "waking-agent" | "error"
  const [verifyResult, setVerifyResult] = useState();
  const [errorMessage, setErrorMessage] = useState();
  const verifyResultRef = useRef();
  const wakeTriggeredRef = useRef(false);
  const wakeStartOffsetRef = useRef(0);

  // Phase 1: run real server-side LLM inference verification (`POST /verify-ai`).
  useEffect(() => {
    let cancelled = false;
    wakeTriggeredRef.current = false;
    verifyResultRef.current = undefined;
    setVerifyResult(undefined);
    setPhase("verifying-ai");
    setErrorMessage(undefined);

    (async () => {
      try {
        const result = await ask("/verify-ai", "POST");
        if (cancelled) return;
        if (!result.ok) {
          setErrorMessage(
            result.error ||
              "Could not verify your AI connection. Go back to check your AI configuration.",
          );
          setPhase("error");
          return;
        }
        verifyResultRef.current = result;
        setVerifyResult(result);
        setPhase("waking-agent");
      } catch (failure) {
        if (cancelled) return;
        setErrorMessage(friendlyWakeError(failure instanceof Error ? failure.message : failure));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Phase 2: trigger idempotent opener on /agents/onboarding and wait for first model-written reply.
  useEffect(() => {
    if (phase !== "waking-agent" || !agentContext.caughtUp) return;
    const events = agentContext.events;

    if (hasModelReply(events)) {
      onDone(verifyResultRef.current);
      return;
    }

    if (wakeTriggeredRef.current) {
      const failedAfterWake = events.find(
        (event) =>
          event.offset > wakeStartOffsetRef.current &&
          event.type === "events.iterate.com/agent/llm-request-settled" &&
          event.payload?.result?.status &&
          event.payload.result.status !== "succeeded",
      );
      if (failedAfterWake) {
        setErrorMessage(friendlyWakeError(failedAfterWake.payload?.result?.errorMessage));
        setPhase("error");
      }
      return;
    }

    wakeTriggeredRef.current = true;
    wakeStartOffsetRef.current = events.at(-1)?.offset ?? 0;

    (async () => {
      try {
        await itx.agents.create(AGENT).catch(() => {});
        const stub = agent.stub || itx.cd(AGENT);
        // Find the last event that triggers an LLM turn (user/developer context or incoming
        // message; assistant notices like credit-spent do not trigger a turn).
        const lastTrigger = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "events.iterate.com/agent/message-received" ||
              (event.type === "events.iterate.com/agent/context-added" &&
                (event.payload?.role === "user" || event.payload?.role === "developer") &&
                event.payload?.llmRequestPolicy?.behaviour !== "dont-trigger-request"),
          );
        if (!lastTrigger) {
          await stub
            .append({
              type: "events.iterate.com/agent/context-added",
              idempotencyKey: `opener:${AGENT}`,
              payload: { role: "developer", content: OPENER },
            })
            .catch(() => {});
          return;
        }
        // Only append a recovery wake turn when the latest triggered turn has already settled
        // without producing a model reply; never duplicate a pending or in-flight opener.
        const lastSettled = [...events]
          .reverse()
          .find((event) => event.type === "events.iterate.com/agent/llm-request-settled");
        const lastStarted = [...events]
          .reverse()
          .find((event) => event.type === "events.iterate.com/agent/llm-request-started");
        const pendingOrInFlight =
          !lastSettled ||
          lastSettled.offset < lastTrigger.offset ||
          Boolean(lastStarted && lastStarted.offset > lastSettled.offset);
        if (!pendingOrInFlight) {
          await stub
            .append({
              type: "events.iterate.com/agent/context-added",
              idempotencyKey: `onboarding-wake:${lastSettled.offset}`,
              payload: { role: "developer", content: OPENER },
            })
            .catch(() => {});
        }
      } catch (failure) {
        setErrorMessage(friendlyWakeError(failure instanceof Error ? failure.message : failure));
        setPhase("error");
      }
    })();
  }, [phase, agentContext.caughtUp, agentContext.events, agent.stub, onDone]);

  // Bounded wait while waking the onboarding agent (60 seconds).
  useEffect(() => {
    if (phase !== "waking-agent") return;
    const timer = setTimeout(() => {
      setErrorMessage(
        "Your onboarding agent took too long to respond. Try again or check your AI configuration.",
      );
      setPhase("error");
    }, 60_000);
    return () => clearTimeout(timer);
  }, [phase, attempt]);

  const statusTitle =
    phase === "verifying-ai"
      ? "Checking that AI connection works…"
      : "Waking your onboarding agent…";
  const statusDesc =
    phase === "verifying-ai"
      ? "Running a quick test request to confirm your model responds."
      : "Waiting for your onboarding agent's first message.";

  let verifyBanner = null;
  if (verifyResult) {
    verifyBanner = html`
      <div className="wizard-status-banner">
        <${CircleCheckIcon} className="size-4 shrink-0 mt-0.5" />
        <span>AI check passed — ${verifySummaryOf(verifyResult)}</span>
      </div>
    `;
  }

  let gateContent = html`
    <div className="wizard-gate">
      <${Spinner} className="size-6" />
      <p className="wizard-gate-title">${statusTitle}</p>
      <p className="wizard-gate-desc">${statusDesc}</p>
      ${verifyBanner}
    </div>
  `;
  let errorFooter = null;
  if (phase === "error") {
    gateContent = html`
      <div className="wizard-gate">
        <${CircleAlertIcon} className="size-6 text-destructive" />
        <p className="wizard-gate-title">AI connection check failed</p>
        <p className="wizard-gate-desc" role="alert">${errorMessage}</p>
      </div>
    `;
    errorFooter = html`
      <${CardFooter} className="wizard-actions">
        <${Button} variant="outline" data-action="back-to-ai" onClick=${onBackToAi}>
          Back to AI setup
        <//>
        <${Button} data-action="retry-verify" onClick=${() => setAttempt((n) => n + 1)}>
          Try again
        <//>
      <//>
    `;
  }

  return html`
    <${Card} data-step="verify" data-phase=${phase}>
      <${CardContent}>${gateContent}<//>
      ${errorFooter}
    <//>
  `;
}

// ── Step 4: Done ──

function DoneStep({ verifyResult, aiStatus, cloudCard, onReviewAi }) {
  const hasCloudCredit = aiStatus.openai === "iterate-proxy" && cloudCard?.status === "connected";
  const hasOwnOpenAi = aiStatus.openai === "own" || aiStatus.openai === "other-proxy";
  const activeProviders = [
    aiStatus.chatgpt && PROVIDER_LABELS.chatgpt,
    hasOwnOpenAi && PROVIDER_LABELS.openai,
    hasCloudCredit && PROVIDER_LABELS["iterate-cloud"],
  ].filter(Boolean);
  const summaryLine = verifyResult
    ? `AI check passed — ${verifySummaryOf(verifyResult)}`
    : activeProviders.length > 0
      ? `Connected via ${activeProviders.join(", ")}. Your onboarding agent has replied and is ready.`
      : "Your onboarding agent has replied and is ready.";

  return html`
    <${Card} data-step="done">
      <${CardHeader}>
        <${CardTitle} className="wizard-card-title">
          <${CircleCheckIcon} className="size-5" />
          <span>Done: your mind is set up</span>
        <//>
        <${CardDescription}>
          Your AI connection works and your onboarding agent is waiting in the Dash.
        <//>
      <//>

      <${CardContent} className="wizard-options">
        <div className="wizard-status-banner">
          <${CircleCheckIcon} className="size-4 shrink-0 mt-0.5" />
          <span>${summaryLine}</span>
        </div>
      <//>

      <${CardFooter} className="wizard-actions">
        <${Button} variant="outline" data-action="review-ai" onClick=${onReviewAi}> AI settings <//>
        <a
          className=${buttonVariants({ variant: "default" })}
          href=${dashOnboardingUrl}
          data-action="open-dash"
        >
          Open Dash
        </a>
      <//>
    <//>
  `;
}

function CopyCommand({ command }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }
  return html`
    <div className="wizard-command-row">
      <pre className="wizard-command"><code>${command}</code></pre>
      <${Button} variant="outline" size="sm" onClick=${() => void copy()}>
        ${copied ? html`<${CheckIcon} className="size-3.5" /> Copied` : html`<${CopyIcon} className="size-3.5" /> Copy`}
      <//>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
