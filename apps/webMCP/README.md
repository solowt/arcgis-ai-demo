# webMCP

A live Esri `MapView`, an independent flyout panel, and an `arcgis-assistant`
demonstrate three in-page WebMCP tools:

| Tool                   | Input                                                                                 | Action                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `set_panel_visibility` | `{ "open": true }` or `{ "open": false }`                                             | Opens or closes the demo panel without hiding the assistant.      |
| `set_basemap`          | `{ "basemap": "topo-vector" }`                                                        | Changes the basemap without changing the map extent.              |
| `add_feature_layer`    | `{ "url": "https://example.com/arcgis/rest/services/Hosted/places/FeatureServer/0" }` | Adds a feature layer and zooms to the extent of all its features. |

Supported basemaps are imagery (`satellite`), imagery with labels (`hybrid`),
streets, topographic, light gray, dark gray, and OpenStreetMap. Expand the tool
schemas in the panel for the exact IDs. The toolbar controls, browser agents,
and ArcGIS assistant all execute the same definitions and update the same UI.
The activity indicator and last-result display show their executions.

## Run locally

Requires Node.js 22.12+ and an ArcGIS account with access to ArcGIS AI services.
From the repository root:

```sh
npm ci --include=dev
npm run dev --workspace apps/webMCP
```

Dependencies and the lockfile are shared at the repository root with the other
npm-based apps. Do not install dependencies separately in this app directory.

Open `http://127.0.0.1:5173/apps/webMCP/index.html`, using the port Vite prints.
The map, manual controls, and browser tools work without ArcGIS sign-in. Enter
your portal URL and select **Sign in with ArcGIS** to use the assistant.
Authentication uses `IdentityManager.getCredential("<portal>/sharing")`, just
like the other apps. Changing the portal reloads the app before sign-in so the
ArcGIS components initialize against the selected portal. The default matches
the other demos and can also be overridden with the `portal` query parameter.
No token or credential is included in a tool definition or result.

Try "Close the demo panel", "Switch to the topographic basemap", or "Open the
panel and use imagery". Closing the panel leaves both the assistant and the
toolbar's **Demo panel** button available. Escape closes the panel when focus
is inside it.

## Add a feature layer

Ask the assistant to "Add this feature layer and zoom to all its features",
including a URL ending in `/FeatureServer/<layerId>`. A service can contain
multiple layers, so supply the individual layer URL rather than the
`/FeatureServer` root. URLs containing `/rest/admin/services/` are normalized
to the corresponding `/rest/services/` data endpoint on the same server.
Use HTTPS, or HTTP on localhost, without URL credentials, query parameters,
or fragments.

The tool creates and loads an ArcGIS `FeatureLayer`, then calls its server-side
`queryExtent` with `where: "1=1"` in the map's spatial reference. This fits all
features in the specified layer, not just the current view, the first page of
records, or the service's cached `fullExtent`. The layer is added to the map,
its layer view is checked, and the map zooms to the queried extent with a small
margin. A single-point extent uses a neighborhood-scale zoom.

The result includes the added map layer's ID, title, URL, feature count, and
queried extent. Empty layers and nonspatial tables produce an explicit error.
Loading, querying, rendering, or navigation failures remove the incomplete layer;
cancellation also removes it and prevents late additions or zooms.

The service must permit querying and browser access through CORS. Secured
services use the ArcGIS SDK's normal authentication flow; do not put a token in
the tool URL. This tool only adds a layer to the page, not edits to service data.

## Native WebMCP and the FunctionTool transformer

[webmcp.js](webmcp.js) defines the tools with a name, description, JSON
Schema `inputSchema`, and an `execute` callback. The page registers those
definitions with `document.modelContext.registerTool` (the current WebMCP
draft), or `navigator.modelContext.registerTool` in preview implementations.
Registration supports both promise-returning and synchronous implementations.
Cleanup uses an abort signal and, where available, preview `unregisterTool`.
Partial registration failures unregister the tools already added by this app.

Native WebMCP requires a supporting browser with the experimental API enabled
and a secure context (HTTPS or localhost). The browser-support banner reports
whether registration actually succeeded. There is no polyfill or remote MCP
server. In an unsupported browser, the manual controls and ArcGIS assistant
still work through the local definitions; this is **not** native WebMCP access
for browser agents.

On implementations with the current draft's discovery and execution API, a
browser agent can discover and execute the registered tools using:

```js
const context = document.modelContext ?? navigator.modelContext;
const tools = await context.getTools();
await context.executeTool(
  tools.find((tool) => tool.name === "set_panel_visibility"),
  { open: false },
);
```

Older preview builds may need their corresponding browser-agent tooling instead
of `getTools` / `executeTool`. WebMCP is evolving; see the
[specification](https://webmachinelearning.github.io/webmcp/) and
[Chrome preview information](https://developer.chrome.com/blog/webmcp-epp).

[tools.js](tools.js) transforms the **same definitions** into ArcGIS
`FunctionTool` instances. Like the MCP app, it converts JSON Schema to Zod,
normalizes agent-facing names, and uses `resultMode: "continue"` so the
`LLMAgent` can reason about results and perform multiple actions in one request.
Unlike the MCP app, it invokes the definition's local `execute` callback,
not an HTTP server or a browser testing API. The assistant uses the existing
chat-completions middleware pattern.

Both entry points validate inputs. Invalid arguments, callback failures, and
MCP-style `isError` results are not reported as successful tool calls. The
transformer preserves successful tool results and forwards cancellation.
Unsupported JSON Schemas fail conversion explicitly rather than weakening
validation. Basemaps load before replacing the current one; failed, canceled,
or superseded loads leave the previous basemap intact. Resetting the
conversation invalidates its old FunctionTools without unregistering the page's
native tools.

Tool actions are local, but assistant prompts, tool metadata, and results are
sent to ArcGIS AI for reasoning. ArcGIS SDK assets, basemaps, feature services,
and fonts also require network access.

## Test and build

```sh
npm test --workspace apps/webMCP
npm run build --workspace apps/webMCP
npm run preview --workspace apps/webMCP
```

Run `npm run build` at the repository root to build all three npm-based apps.

Tests use the real ArcGIS `FunctionTool` and simulated browser/ArcGIS UI
dependencies; no credentials or AI service calls are needed. They exercise
all three tools, validation, results, errors, cancellation, registration cleanup,
portal sign-in routing, shared UI state, and feature extent queries and navigation.
Feature layer tests simulate service responses rather than contacting a live
service.

The build produces `apps/webMCP/dist/index.html` and adjacent assets. The root
launcher opens that build, and the deployment script builds it alongside the
other npm-based apps. Use the source URL above for Vite development.
