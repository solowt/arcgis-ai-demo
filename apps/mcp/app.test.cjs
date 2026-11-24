const assert = require("node:assert/strict");
const { test } = require("node:test");

const toolsModule = import("./tools.js");
const definition = {
  name: "places.search",
  description: "Search for places in a region.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      filters: {
        type: "object",
        properties: {
          categories: {
            type: "array",
            items: { type: "string", enum: ["park", "library"] },
          },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["categories"],
        additionalProperties: false,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

test("MCP schemas become FunctionTools that validate input and call the original name", async () => {
  const { createMcpTools } = await toolsModule;
  const calls = [];
  const activities = [];
  const response = {
    content: [{ type: "text", text: "Found one park." }],
    structuredContent: { count: 1 },
  };
  const [tool] = createMcpTools(
    [definition],
    {
      callTool: async (...args) => {
        calls.push(args);
        return response;
      },
    },
    { onActivity: (activity) => activities.push(activity) },
  );
  assert.equal(tool.name, "places_search");
  assert.equal(tool.description, definition.description);
  assert.equal(tool.resultMode, "continue");
  const input = {
    query: "Portland",
    filters: { categories: ["park"], limit: 3 },
  };
  const result = await tool.getTool().invoke(input);
  assert.deepEqual(
    typeof result === "string" ? JSON.parse(result) : result,
    response,
  );
  assert.deepEqual(calls[0][0], { name: "places.search", arguments: input });
  assert.equal(calls[0][2].timeout, 60_000);
  assert.deepEqual(
    activities.map((activity) => activity.status),
    ["running", "complete"],
  );
  for (const invalid of [
    {},
    { query: "" },
    { query: "Portland", filters: { categories: ["unknown"] } },
    { query: "Portland", filters: { categories: [], limit: 0 } },
    { query: "Portland", unexpected: true },
  ]) {
    await assert.rejects(tool.getTool().invoke(invalid));
  }
  assert.equal(calls.length, 1);
});

test("query_data dependencies validate before MCP execution and preserve defaults", async () => {
  const { createMcpTools } = await toolsModule;
  const { z } = await import("zod");
  const queryDefinition = {
    name: "query_data",
    description: "Query a layer after inspecting its fields.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        layerOrTableUrl: { type: "string" },
        groupByField: { type: "string" },
        statistics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              statisticType: { type: "string", enum: ["count", "sum"] },
              onField: { type: "string" },
            },
            required: ["statisticType", "onField"],
          },
        },
        geometry: { type: "string" },
        geometryType: {
          type: "string",
          enum: ["esriGeometryPoint", "esriGeometryEnvelope"],
          default: "esriGeometryEnvelope",
        },
        bufferDistance: { type: "number", minimum: 0 },
        bufferUnits: { type: "string", enum: ["esriSRUnit_Meter"] },
      },
      required: ["layerOrTableUrl"],
      dependentRequired: {
        groupByField: ["statistics"],
        geometry: ["geometryType"],
        bufferDistance: ["bufferUnits"],
      },
    },
  };
  const original = structuredClone(queryDefinition);
  const calls = [];
  const [tool] = createMcpTools([queryDefinition], {
    callTool: async (request) => {
      calls.push(request);
      return { content: [] };
    },
  });
  const base = { layerOrTableUrl: "https://example.com/FeatureServer/0" };
  for (const invalid of [
    { groupByField: "region" },
    { groupByField: "" },
    { bufferDistance: 0 },
    { bufferDistance: 5, bufferUnits: undefined },
  ]) {
    await assert.rejects(tool.getTool().invoke({ ...base, ...invalid }));
  }
  assert.equal(calls.length, 0);
  const validInputs = [
    {
      groupByField: "region",
      statistics: [{ statisticType: "sum", onField: "population" }],
    },
    { bufferDistance: 0, bufferUnits: "esriSRUnit_Meter" },
    { geometry: "{}" },
    { geometry: "{}", geometryType: "esriGeometryPoint" },
  ];
  for (const input of validInputs) {
    await tool.getTool().invoke({ ...base, ...input });
  }
  assert.equal(calls.length, validInputs.length);
  assert.ok(calls.every((request) => request.name === "query_data"));
  assert.equal(calls[2].arguments.geometryType, "esriGeometryEnvelope");
  assert.equal(calls[3].arguments.geometryType, "esriGeometryPoint");
  assert.match(tool.description, /"groupByField".*"statistics"/);
  assert.match(tool.description, /"geometry".*"geometryType"/);
  assert.match(tool.description, /"bufferDistance".*"bufferUnits"/);
  assert.equal(
    z.toJSONSchema(tool.inputSchema).properties.bufferDistance.minimum,
    0,
  );
  assert.deepEqual(queryDefinition, original);
});

test("agent names are valid and unique without changing MCP routing", async () => {
  const { createMcpTools } = await toolsModule;
  const originalNames = [
    "places.search",
    "places/search",
    "x".repeat(90),
    "x".repeat(91),
  ];
  const calls = [];
  const tools = createMcpTools(
    originalNames.map((name) => ({ ...definition, name })),
    {
      callTool: async (request) => {
        calls.push(request.name);
        return { content: [] };
      },
    },
  );
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    await tool.execute({ query: "test" });
  }
  assert.deepEqual(calls, originalNames);
});

test("unsupported tools are reported without blocking compatible tools", async () => {
  const { createMcpTools } = await toolsModule;
  const unsupportedDefinition = {
    ...definition,
    name: "places/search",
    inputSchema: {
      ...definition.inputSchema,
      dependentSchemas: { query: { required: ["filters"] } },
    },
  };
  const nestedDependency = {
    ...definition,
    name: "nested_dependencies",
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          dependentRequired: { query: ["limit"] },
        },
      },
    },
  };
  const issues = [];
  const calls = [];
  const tools = createMcpTools(
    [
      unsupportedDefinition,
      definition,
      nestedDependency,
      { ...definition, name: "other.search" },
    ],
    {
      callTool: async (request) => {
        calls.push(request.name);
        return { content: [] };
      },
    },
    { onUnsupported: (issue) => issues.push(issue) },
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["places_search", "other_search"],
  );
  assert.deepEqual(
    issues.map((issue) => issue.definition),
    [unsupportedDefinition, nestedDependency],
  );
  assert.ok(
    issues.every((issue) =>
      /dependentSchemas and dependentRequired are not supported/.test(
        issue.error.message,
      ),
    ),
  );
  for (const tool of tools) await tool.getTool().invoke({ query: "Portland" });
  assert.deepEqual(calls, ["places.search", "other.search"]);
  assert.throws(
    () => createMcpTools([unsupportedDefinition], {}),
    /Cannot convert the input schema/,
  );
});

test("an entirely unsupported catalog returns no tools and reports every failure", async () => {
  const { createMcpTools } = await toolsModule;
  const issues = [];
  const tools = createMcpTools(
    [
      { ...definition, name: " " },
      { ...definition, name: "array_input", inputSchema: { type: "array" } },
    ],
    {},
    { onUnsupported: (issue) => issues.push(issue) },
  );
  assert.deepEqual(tools, []);
  assert.equal(issues.length, 2);
  assert.match(issues[0].error.message, /without a name/);
  assert.match(issues[1].error.message, /object input schema/);
});

test("tool errors and protocol errors are not reported as successful results", async () => {
  const { createMcpTools } = await toolsModule;
  for (const callTool of [
    async () => ({
      isError: true,
      content: [{ type: "text", text: "Permission denied" }],
    }),
    async () => {
      throw new Error("Permission denied");
    },
  ]) {
    const activities = [];
    const issues = [];
    const [tool] = createMcpTools(
      [definition],
      { callTool },
      {
        onActivity: (activity) => activities.push(activity),
        onUnsupported: (issue) => issues.push(issue),
      },
    );
    await assert.rejects(tool.execute({ query: "test" }), /Permission denied/);
    assert.deepEqual(
      activities.map((activity) => activity.status),
      ["running", "error"],
    );
    assert.deepEqual(issues, []);
  }
});

test("agent cancellation reaches MCP and a disconnected session cannot execute tools", async () => {
  const { createMcpTools } = await toolsModule;
  const connection = new AbortController();
  const execution = new AbortController();
  let requestSignal;
  let calls = 0;
  const [tool] = createMcpTools(
    [definition],
    {
      callTool: async (request, schema, options) => {
        calls++;
        requestSignal = options.signal;
        return { content: [] };
      },
    },
    { signal: connection.signal },
  );
  await tool.execute({ query: "test" }, { signal: execution.signal });
  execution.abort();
  assert.equal(requestSignal.aborted, true);
  connection.abort();
  await assert.rejects(tool.execute({ query: "test" }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("invalid tool schemas fail explicitly", async () => {
  const { createMcpTools } = await toolsModule;
  assert.throws(
    () => createMcpTools([{ ...definition, name: " " }], {}),
    /without a name/,
  );
  assert.throws(
    () =>
      createMcpTools([{ ...definition, inputSchema: { type: "string" } }], {}),
    /object input schema/,
  );
  for (const dependentRequired of [
    null,
    [],
    { query: "filters" },
    { query: ["filters", "filters"] },
  ]) {
    assert.throws(
      () =>
        createMcpTools(
          [
            {
              ...definition,
              inputSchema: { ...definition.inputSchema, dependentRequired },
            },
          ],
          {},
        ),
      /dependentRequired must map/,
    );
  }
});

test("MCP sign-in targets the endpoint's sharing URL without query parameters", async () => {
  const { getMcpSharingUrl } = await import("./mcp.js");
  for (const [endpoint, sharingUrl] of [
    [
      "https://example.com/portal/sharing/rest/mcp?f=json",
      "https://example.com/portal/sharing",
    ],
    ["https://example.com/sharing/rest/mcp", "https://example.com/sharing"],
    ["https://example.com/mcp", "https://example.com/sharing"],
    [
      "http://localhost:3000/arcgis/sharing/rest/mcp",
      "http://localhost:3000/arcgis/sharing",
    ],
  ]) {
    assert.equal(getMcpSharingUrl(endpoint), sharingUrl);
  }
});

test("endpoint validation permits HTTPS and loopback HTTP only", async () => {
  const { normalizeEndpoint } = await import("./mcp.js");
  for (const endpoint of [
    "https://example.com/mcp",
    "http://localhost:3000/mcp",
    "http://127.0.0.1/mcp",
    "http://[::1]/mcp",
  ]) {
    assert.equal(normalizeEndpoint(endpoint).href, endpoint);
  }
  for (const endpoint of [
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp#fragment",
    "file:///tmp/mcp",
    "not a URL",
  ]) {
    assert.throws(() => normalizeEndpoint(endpoint));
  }
});

test("discovery rejects repeated cursors and duplicate tool names", async () => {
  const { listMcpTools } = await import("./mcp.js");
  let page = 0;
  await assert.rejects(
    listMcpTools({
      listTools: async () => ({
        tools: [{ ...definition, name: `tool_${page++}` }],
        nextCursor: "again",
      }),
    }),
    /repeated.*cursor/,
  );
  assert.equal(page, 2);
  await assert.rejects(
    listMcpTools({
      listTools: async () => ({ tools: [definition, definition] }),
    }),
    /duplicate tool/,
  );
});

for (const transportType of ["http", "sse"]) {
  test(
    `${transportType} disconnect rejects pending initialization`,
    { timeout: 2000 },
    async (context) => {
      const { createServer } = require("node:http");
      const { once } = require("node:events");
      const { createMcpConnection } = await import("./mcp.js");
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const connection = createMcpConnection({
        endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
        transportType,
      });
      context.after(async () => {
        await connection.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const requestReceived = once(server, "request");
      const rejected = assert.rejects(connection.connect());
      await requestReceived;
      await connection.close();
      await rejected;
      assert.equal(connection.signal.aborted, true);
    },
  );
}

async function startMcpServer(context, { legacy = false, json = false } = {}) {
  const { createServer } = require("node:http");
  const { randomUUID } = require("node:crypto");
  const { once } = require("node:events");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { SSEServerTransport } =
    await import("@modelcontextprotocol/sdk/server/sse.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server(
    { name: "MCP test server", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
    },
  );
  const requests = [];
  const cursors = [];
  const calls = [];
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    cursors.push(request.params?.cursor);
    return request.params?.cursor
      ? {
          tools: [
            {
              name: "clock.time",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }
      : { tools: [definition], nextCursor: "second" };
  });
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params);
    return {
      content: [{ type: "text", text: request.params.arguments.query }],
    };
  });
  let transport;
  if (!legacy) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: json,
    });
    await server.connect(transport);
  }
  const httpServer = createServer(async (request, response) => {
    requests.push({ method: request.method, headers: request.headers });
    try {
      if (legacy && request.method === "GET") {
        transport = new SSEServerTransport("/messages", response);
        await server.connect(transport);
      } else if (legacy) {
        await transport.handlePostMessage(request, response);
      } else {
        await transport.handleRequest(request, response);
      }
    } catch (failure) {
      response.writeHead(500).end(failure.message);
    }
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  context.after(async () => {
    await server.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return {
    endpoint: `http://127.0.0.1:${httpServer.address().port}/${legacy ? "sse" : "mcp"}`,
    requests,
    cursors,
    calls,
  };
}

for (const mode of [
  { label: "Streamable HTTP with JSON responses", json: true },
  { label: "Streamable HTTP with SSE responses" },
  { label: "legacy SSE", legacy: true },
]) {
  test(`${mode.label} initializes, authenticates, paginates, and executes a FunctionTool`, async (context) => {
    const { createMcpConnection } = await import("./mcp.js");
    const { createMcpTools } = await toolsModule;
    const server = await startMcpServer(context, mode);
    const connection = createMcpConnection({
      endpoint: server.endpoint,
      token: "test-mcp-token",
      getMcpToken: () => "test-mcp-sign-in-token",
      transportType: mode.legacy ? "sse" : "http",
    });
    context.after(() => connection.close());
    const definitions = await connection.connect();
    assert.deepEqual(
      definitions.map((tool) => tool.name),
      ["places.search", "clock.time"],
    );
    assert.deepEqual(server.cursors, [undefined, "second"]);
    assert.equal(connection.client.getServerVersion().name, "MCP test server");
    const [tool] = createMcpTools(definitions, connection.client, {
      signal: connection.signal,
    });
    const result = await tool.getTool().invoke({ query: "Portland" });
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    assert.equal(parsed.content[0].text, "Portland");
    assert.deepEqual(server.calls[0], {
      name: "places.search",
      arguments: { query: "Portland" },
    });
    for (const request of server.requests) {
      assert.equal(request.headers.authorization, "Bearer test-mcp-token");
      assert.equal(request.headers["x-esri-authorization"], undefined);
    }
    assert.ok(server.requests.some((request) => request.method === "GET"));
    await connection.close();
    assert.equal(connection.signal.aborted, true);
    await assert.rejects(tool.execute({ query: "after disconnect" }), {
      name: "AbortError",
    });
  });

  test(`${mode.label} stays anonymous until MCP sign-in and follows credential changes`, async (context) => {
    const { createMcpConnection } = await import("./mcp.js");
    const { createMcpTools } = await toolsModule;
    const server = await startMcpServer(context, mode);
    let mcpToken = "";
    const connection = createMcpConnection({
      endpoint: server.endpoint,
      token: " \t ",
      getMcpToken: () => mcpToken,
      transportType: mode.legacy ? "sse" : "http",
    });
    context.after(() => connection.close());
    const definitions = await connection.connect();
    const [tool] = createMcpTools(definitions, connection.client, {
      signal: connection.signal,
    });
    let checkedRequests = 0;
    for (const currentToken of [
      "",
      "mcp-sign-in-token",
      "refreshed-mcp-token",
      "",
    ]) {
      mcpToken = currentToken;
      await connection.listTools();
      await tool.execute({ query: "Portland" });
      const requests = server.requests.slice(checkedRequests);
      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.equal(
          request.headers.authorization,
          currentToken ? `Bearer ${currentToken}` : undefined,
        );
        assert.equal(request.headers["x-esri-authorization"], undefined);
      }
      checkedRequests = server.requests.length;
    }
  });
}
