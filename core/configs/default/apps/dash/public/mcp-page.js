// mcp-page.js — THE DASH'S MCP PAGE: how to connect coding agents (Claude Code, Codex, Claude)
// to this mind over MCP. Shows both the platform endpoint (`https://<mind>/mcp`, which stays up
// even if userspace code breaks the web UI) and the customizable userspace endpoint
// (`https://mcp.<zone>/mcp`, served by apps/mcp/ in /repos/config).
import { html } from "@iterate-com/ui/page";
import { CopyText } from "@iterate-com/ui/components/copy-text";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/ui/card";

function Command({ text, label }) {
  return html`
    <${CopyText}
      text=${text}
      label=${label}
      className="[&>code]:overflow-visible [&>code]:break-all [&>code]:whitespace-normal"
    />
  `;
}

function EndpointSection({ title, description, server, name }) {
  return html`
    <${Card}>
      <${CardHeader}>
        <${CardTitle}>${title}<//>
        <${CardDescription}>${description}<//>
      <//>
      <${CardContent} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">Server URL</div>
          <${Command} text=${server} label=${`${title} address`} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            Claude Code — add, then run <code>/mcp</code>, pick <code>${name}</code>, Authenticate
          </div>
          <${Command}
            text=${`claude mcp add --transport http ${name} ${server}`}
            label=${`Claude Code command for ${title}`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">Codex CLI</div>
          <${Command}
            text=${`codex mcp add ${name} --url ${server}`}
            label=${`Codex add command for ${title}`}
          />
          <${Command}
            text=${`codex mcp login ${name}`}
            label=${`Codex login command for ${title}`}
          />
        </div>
      <//>
    <//>
  `;
}

export function DashMcp({ mind }) {
  const zone = location.hostname.split(".").slice(1).join(".");
  const platformServer = `https://${mind}/mcp`;
  const platformName = mind.replaceAll(".", "-");
  const userspaceHost = `mcp.${zone}`;
  const userspaceServer = `https://${userspaceHost}/mcp`;
  const userspaceName = userspaceHost.replaceAll(".", "-");

  return html`
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">MCP</h1>
          <p className="text-sm text-muted-foreground">
            Connect Claude Code, Codex, or Claude to this mind over MCP. One tool,
            <code>run</code>, evaluates scripts at <code>/</code> as you, and every run is recorded
            on the mind root's log.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Handy safety net:</strong> the Dash and every web UI in this mind live in
            userspace (<code>/repos/config</code>). Connecting a coding agent to the platform
            <code>/mcp</code> endpoint means you can still inspect and fix
            <code>/repos/config</code>
            even if a bad edit bricks the web UI.
          </p>
        </div>
        <${EndpointSection}
          title="Platform MCP (always-on recovery)"
          description="Served directly by the platform — keeps working even if userspace code breaks the Dash or another web app."
          server=${platformServer}
          name=${platformName}
        />
        <${EndpointSection}
          title="Userspace MCP (customizable)"
          description="Served by apps/mcp/ in /repos/config, so you can customize the instructions and run tool description your coding agents see."
          server=${userspaceServer}
          name=${userspaceName}
        />
      </div>
    </div>
  `;
}

// holds nothing of a session
DashMcp.staysOverReconnect = true;
