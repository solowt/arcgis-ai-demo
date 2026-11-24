# MCP Assistant

An `arcgis-assistant` backed by a custom `LLMAgent`. Enter an MCP endpoint to
discover its tools and register a `FunctionTool` for each one.

## Run locally

Requires Node.js 22.12+ and an ArcGIS account with access to ArcGIS AI services.
From the repository root:

```sh
npm ci --include=dev
npm run dev --workspace apps/mcp
```

Dependencies and the lockfile are shared at the repository root with the other
npm-based apps. Do not install dependencies separately in this app directory.

Open `http://127.0.0.1:5173/apps/mcp/index.html`, using the port Vite prints.
Sign in with ArcGIS, enter the MCP endpoint, select its transport, and connect.
Discovery also works before ArcGIS sign-in; chat requires both connections.
The ArcGIS sign-in at the top is only for the assistant. For an ArcGIS-backed
MCP server, use the separate sign-in icon beside the endpoint to authorize MCP
requests, or enter a bearer token manually.
The default ArcGIS portal matches the other demos and can be changed in the
sign-in form or with the `portal` query parameter.

The launcher opens the production build. Use the source URL above for live
development; custom ArcGIS agents require npm and cannot run from `file://`.

## Public endpoint presets

The endpoint field is an editable dropdown: choose a suggestion or enter any
custom MCP URL. Choosing a preset selects Streamable HTTP. Editing the endpoint
clears both the MCP login credential and any manually entered bearer token.

The preset list includes DeepWiki, Microsoft Learn, Cloudflare Docs, Cloudflare
Agents SDK, Context7, Exa Search, Hugging Face, Jina AI, GitMCP, Esri JS Resources
(via GitMCP), and MCP TypeScript SDK docs (via GitMCP).

On 2026-11-09, initialization, tool discovery, schema conversion, and CORS
responses were checked without credentials for all eleven endpoints. Individual
tool calls were not exercised in that check. These are third-party services:
availability, CORS policies, anonymous quotas, and tool-specific authentication
requirements may change. For anonymous access, leave the bearer token blank and
do not use the endpoint sign-in button. Signing in to ArcGIS for the assistant
does not authorize MCP requests. Use only public, non-sensitive inputs.

## MCP compatibility

- Supports Streamable HTTP, including JSON and SSE responses, and legacy SSE.
  Local `stdio` servers need a separately hosted HTTP/SSE bridge.
- Use an HTTPS endpoint, or HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
  Select the endpoint's actual transport; there is no automatic fallback.
- Public endpoints, optional bearer-token authentication, and explicit ArcGIS
  sign-in for MCP endpoints are supported. Generic MCP OAuth is not implemented.
- The endpoint sign-in icon calls `IdentityManager.getCredential` on the
  endpoint's sharing URL. For example, `/portal/sharing/rest/mcp` uses
  `/portal/sharing`. When there is no `/sharing` path component, the sign-in URL
  is `/sharing` at that origin. Query parameters are not included. This login
  is for ArcGIS-backed servers, not arbitrary public MCP services.
- Requests use `Authorization: Bearer <token>`. A nonblank bearer token entered
  in the form overrides the current, unexpired credential obtained using the
  endpoint sign-in button. Without either token, requests are anonymous.
  The endpoint credential is read on every request, so later MCP sign-in and
  credential updates take effect without reconnecting. The assistant's ArcGIS
  credential is never used automatically for MCP requests.
- Tokens are sent only to the selected MCP endpoint's origin. Explicit bearer
  tokens are kept in memory and cleared from the form when editing the endpoint,
  connecting successfully, or disconnecting. Redirects are rejected and browser
  cookies are omitted. The endpoint login remains available for reconnecting to
  that same URL, but changing the endpoint clears it. Signing out clears both
  ArcGIS and MCP credentials.
- The MCP server must allow the app's origin through CORS. Allow `GET`, `POST`,
  and `OPTIONS`, plus the request headers `Content-Type`, `Authorization`,
  `Mcp-Session-Id`, `MCP-Protocol-Version`, and `Last-Event-ID` as applicable.
  Expose `Mcp-Session-Id` in response headers for stateful Streamable HTTP.
  A server without browser access needs a trusted reverse proxy configured for
  that server; this app does not supply an open proxy.

Only connect to trusted servers. The agent sends tool arguments to that server
and receives its results; those results are also provided to ArcGIS AI for
reasoning. Server tool descriptions and results are not trusted system prompts.
The agent is instructed to request confirmation for consequential actions;
enforce permissions on the MCP server as well.

## Tool adapter

[mcp.js](mcp.js) uses the official MCP SDK for initialization, paginated
`tools/list`, authenticated transport, notifications, and cancellation.
[tools.js](tools.js) converts each MCP `inputSchema` using Zod's
`fromJSONSchema` and creates an ArcGIS `FunctionTool`. Top-level
`dependentRequired` rules are enforced with additional Zod validation before
execution, after schema defaults are applied. The requirements are also appended
to the tool description for the model. The original server schema is unchanged.

Unsupported tools remain visible as **Unavailable**, with the conversion reason
and original input schema, but are not registered with the agent. The tool count
shows available tools. Other tools remain usable and the MCP connection stays
open, even if every tool is unsupported; in that case chat is unavailable until
a refresh discovers compatible tools. Nested `dependentRequired`,
`dependentSchemas`, and other constructs the converter cannot support are
reported this way, not silently stripped. Assistant setup failures are reported
separately from connection failures.

Agent-facing names are normalized and made unique; execution always uses the
original MCP name in `tools/call`.

Tool results retain MCP `content` and `structuredContent`. An `isError` result
becomes a tool execution error. `resultMode: "continue"` lets the `LLMAgent`
reason over results and invoke more tools. The app uses the same chat-completions
middleware as the existing helper-services assistant.

Expand a tool to inspect its input schema. Refresh reloads the tool list and
resets the conversation. A server's `tools/list_changed` notification marks the
connection as "Tools changed"; refresh explicitly to accept the updated list.
Disconnect, refresh, and new conversation invalidate previous agent sessions.
Connection attempts have a 20-second timeout; tool calls have a 60-second timeout.

## Test and build

```sh
npm test --workspace apps/mcp
npm run build --workspace apps/mcp
npm run preview --workspace apps/mcp
```

Run `npm run build` at the repository root to build all three npm-based apps.

Tests use the real ArcGIS `FunctionTool` and local MCP SDK servers, covering
schema validation, name mapping, errors, cancellation, authentication, pagination,
and all three response/transport modes. Schema checks cover conditional
requirements, defaults, and mixed or entirely unsupported tool catalogs.
Authentication checks cover sharing-URL resolution, explicit bearer-token
precedence, endpoint sign-in credentials and updates, and anonymous requests
without a token. They do not require ArcGIS credentials or an external MCP server.

The build outputs `apps/mcp/dist/index.html` and its adjacent assets. The root
launcher links to that entry, and the deployment script builds it on the remote
alongside the helper-services assistant and webMCP. The preview command serves the build
at the URL Vite prints. SDK assets, fonts, and ArcGIS AI services require network
access.

## ArcGIS references

- [AI components](https://developers.arcgis.com/javascript/latest/references/ai-components/)
- [LLMAgent](https://developers.arcgis.com/javascript/latest/references/ai-components/agent-utils/LLMAgent/)
- [FunctionTool](https://developers.arcgis.com/javascript/latest/references/ai-components/agent-utils/tools/FunctionTool/)
