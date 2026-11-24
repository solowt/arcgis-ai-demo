import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export function normalizeEndpoint(value) {
  const endpoint = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" &&
      !(local && endpoint.protocol === "http:")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error(
      "Use an HTTPS MCP endpoint (or HTTP on localhost) without URL credentials or a fragment.",
    );
  }
  return endpoint;
}

export function getMcpSharingUrl(value) {
  const endpoint = normalizeEndpoint(value);
  const sharingPath = endpoint.pathname.match(/^.*?\/sharing(?=\/|$)/i);
  endpoint.pathname = sharingPath ? sharingPath[0] : "/portal/sharing";
  endpoint.search = "";
  return endpoint.href;
}

export async function listMcpTools(client, { signal } = {}) {
  const definitions = [];
  const cursors = new Set();
  const names = new Set();
  let cursor;
  do {
    signal?.throwIfAborted();
    const page = await client.listTools(cursor ? { cursor } : {}, {
      signal,
      timeout: 20_000,
    });
    for (const tool of page.tools) {
      if (names.has(tool.name)) {
        throw new Error(
          `The MCP server returned duplicate tool "${tool.name}".`,
        );
      }
      names.add(tool.name);
      definitions.push(tool);
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) {
      throw new Error("The MCP server repeated a tools pagination cursor.");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  signal?.throwIfAborted();
  return definitions;
}

export function createMcpConnection({
  endpoint,
  token = "",
  getMcpToken = () => "",
  transportType = "http",
  onClose = () => {},
  onToolsChanged = () => {},
}) {
  const url = normalizeEndpoint(endpoint);
  if (!["http", "sse"].includes(transportType)) {
    throw new Error("Select Streamable HTTP or SSE transport.");
  }
  const controller = new AbortController();
  let closed = false;
  let connected = false;
  const requestFetch = (target, init = {}) => {
    const requestUrl = new URL(target instanceof Request ? target.url : target);
    if (requestUrl.origin !== url.origin) {
      throw new Error(
        "The MCP server attempted a request to a different origin.",
      );
    }
    const headers = new Headers(init.headers);
    const bearerToken = token.trim() || getMcpToken().trim();
    if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
    return fetch(target, {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, init.signal].filter(Boolean)),
    });
  };
  const options = { fetch: requestFetch };
  const transport =
    transportType === "sse"
      ? new SSEClientTransport(url, {
          ...options,
          eventSourceInit: { fetch: requestFetch },
        })
      : new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: "arcgis-mcp-assistant", version: "1.0.0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
    onToolsChanged(),
  );
  client.onclose = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    if (connected) onClose();
  };

  return {
    client,
    signal: controller.signal,
    async connect() {
      controller.signal.throwIfAborted();
      let rejectOnAbort;
      const aborted = new Promise((resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectOnAbort, {
          once: true,
        });
      });
      const timer = setTimeout(
        () => controller.abort(new Error("MCP connection timed out.")),
        20_000,
      );
      try {
        await Promise.race([
          client.connect(transport, {
            signal: controller.signal,
            timeout: 20_000,
          }),
          aborted,
        ]);
        if (!client.getServerCapabilities()?.tools) {
          throw new Error("This MCP server does not advertise tools.");
        }
        const definitions = await listMcpTools(client, {
          signal: controller.signal,
        });
        connected = true;
        return definitions;
      } catch (failure) {
        closed = true;
        controller.abort();
        await client.close();
        throw failure;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectOnAbort);
      }
    },
    listTools() {
      return listMcpTools(client, { signal: controller.signal });
    },
    async close() {
      closed = true;
      controller.abort();
      await client.close();
    },
  };
}
