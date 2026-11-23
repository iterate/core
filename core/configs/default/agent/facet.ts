// facet.ts — THE HOSTS: one facet for the agent's processor, and one for each shape of LLM API.
// Enable each on the context that runs the agent (any context can: `/agents/<name>` is only where
// `itx.agents.create` puts one), under its own name. The agent's processor is named `agent`:
//
//   processors.enable("agent", { className: "AgentFacet", mainModule: "facet.ts", source, consumes })
//   processors.enable("llm-api-chat-completions", { className: "ChatCompletionsFacet", … })
//
// They share nothing but the log. Enable only the API shapes the agent's providers speak: each
// facet is pushed every request fact, and a context should keep well under ten facets that react to
// one fact (measured: README.md). An API shape of your own is a facet like these four, or any
// processor anywhere that reads `llm-request/requested` and writes `llm-request/settled`.
//
// The context needs a parent link (`itx/rewrite-rule-configured { match: "itx", target:
// "itx.cd('/')" }`): a new context has no `itx.ai` of its own. `itx.agents.create` writes it for the
// contexts it makes; on any other context, write it once. To host a variant of the agent, put its
// class where `Agent` is.

import { StreamProcessorDurableObject } from "iterate/sdk";
import type { AgentState } from "./contract.ts";
import { LlmApiProcessor, type LlmApi, type LlmApiState } from "./llm-api.ts";
import { anthropicMessages } from "./llm-apis/anthropic-messages.ts";
import { chatCompletions } from "./llm-apis/chat-completions.ts";
import { googleGenerateContent } from "./llm-apis/google-generate-content.ts";
import { openaiResponses } from "./llm-apis/openai-responses.ts";
import { Agent } from "./processor.ts";

// one wide event for each attempt, in the Worker's own log
const report = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

/** THE AGENT. It appends facts and needs nothing of its host. */
export class AgentFacet extends StreamProcessorDurableObject<AgentState> {
  processor = new Agent();
}

/** A request maker of one API shape, with what it needs of its host: the context's `itx`, on which
 *  it reads a provider's AI binding or fetcher (two itx expressions of the config) and its own log
 *  (a request's base that it does not hold), and the facet's own `fetch` (the mind's egress, which
 *  swaps a secret's placeholder in a header for the secret) for a provider with a `baseUrl` and no
 *  fetcher. */
abstract class LlmApiFacet extends StreamProcessorDurableObject<LlmApiState> {
  protected requestMaker(api: LlmApi) {
    return new LlmApiProcessor({
      api,
      getItx: () => this.getItx(),
      fetch: (request) => fetch(request),
      now: () => Date.now(),
      report,
      // a request's base that it does not hold, read from the context's own log
      readEvents: async (afterOffset, limit) => {
        using itx = this.getItx();
        return await itx.readEvents(afterOffset, limit);
      },
    });
  }
}

export class OpenaiResponsesFacet extends LlmApiFacet {
  processor = this.requestMaker(
    openaiResponses({
      report,
      // The facet's own `fetch` carries a WebSocket back. No itx expression can: the facet reaches
      // `itx` over Workers RPC, and no RPC answer holds a socket. A header that names a secret by
      // proxy (`getSecret("/secrets/iterate-cloud")`) makes the secrets Worker sign the upgrade
      // with the mind's own key.
      openWebSocket: async (url, headers) => {
        const response = await fetch(url, { headers: { ...headers, upgrade: "websocket" } });
        const socket = response.webSocket;
        if (!socket)
          throw new Error(`no WebSocket from ${new URL(url).host}: HTTP ${response.status}`);
        socket.accept();
        return socket;
      },
    }),
  );
}

export class AnthropicMessagesFacet extends LlmApiFacet {
  processor = this.requestMaker(anthropicMessages);
}

export class ChatCompletionsFacet extends LlmApiFacet {
  processor = this.requestMaker(chatCompletions);
}

export class GoogleGenerateContentFacet extends LlmApiFacet {
  processor = this.requestMaker(googleGenerateContent);
}
