const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const webmcpModule = import("./webmcp.js");
const toolsModule = import("./tools.js");
const extentModule = import("@arcgis/core/geometry/Extent.js");
const featureUrl =
  "https://example.com/arcgis/rest/services/Hosted/places/FeatureServer/0";
const resultObject = (result) =>
  typeof result === "string" ? JSON.parse(result) : result;

function modelContextFixture() {
  const tools = new Map();
  return {
    tools,
    async registerTool(definition, { signal }) {
      tools.set(definition.name, definition);
      signal.addEventListener("abort", () => tools.delete(definition.name), {
        once: true,
      });
    },
  };
}

test("native definitions and real FunctionTools share actions and preserve results", async () => {
  const { createWebMcpDefinitions, registerWebMcpTools } = await webmcpModule;
  const { createFunctionTools } = await toolsModule;
  const changes = [];
  const activity = [];
  const definitions = createWebMcpDefinitions({
    setPanelOpen: (open) => changes.push({ open }),
    setBasemap: (basemap) => changes.push({ basemap }),
    onActivity: (event) => activity.push(event.status),
  });
  const context = modelContextFixture();
  const unregister = await registerWebMcpTools(definitions, context);
  const [panel, basemap] = createFunctionTools(definitions);
  const closed = await context.tools
    .get("set_panel_visibility")
    .execute({ open: false });
  assert.deepEqual(closed, {
    content: [{ type: "text", text: "The demo panel is closed." }],
    structuredContent: { open: false },
  });
  const opened = resultObject(await panel.getTool().invoke({ open: true }));
  assert.deepEqual(opened.structuredContent, { open: true });
  const changed = resultObject(
    await basemap.getTool().invoke({ basemap: "topo-vector" }),
  );
  assert.deepEqual(changed, {
    content: [{ type: "text", text: "The basemap is now topo-vector." }],
    structuredContent: { basemap: "topo-vector" },
  });
  await context.tools.get("set_basemap").execute({ basemap: "satellite" });
  assert.deepEqual(changes, [
    { open: false },
    { open: true },
    { basemap: "topo-vector" },
    { basemap: "satellite" },
  ]);
  assert.equal(panel.description, definitions[0].description);
  assert.equal(panel.resultMode, "continue");
  assert.deepEqual(activity, Array(4).fill(["running", "complete"]).flat());
  await unregister();
  assert.equal(context.tools.size, 0);
});

test("both browser callbacks and FunctionTools reject invalid input before UI changes", async () => {
  const { createWebMcpDefinitions } = await webmcpModule;
  const { createFunctionTools } = await toolsModule;
  let changes = 0;
  const definitions = createWebMcpDefinitions({
    setPanelOpen: () => changes++,
    setBasemap: () => changes++,
    addFeatureLayer: () => changes++,
  });
  const tools = createFunctionTools(definitions);
  for (const [index, invalidInputs] of [
    [0, [{}, { open: "false" }, { open: true, extra: true }]],
    [
      1,
      [{}, { basemap: "not-a-basemap" }, { basemap: "satellite", extra: true }],
    ],
    [
      2,
      [
        {},
        { url: "" },
        { url: "not a URL" },
        { url: featureUrl, extra: true },
        { url: featureUrl.replace("https:", "http:") },
        { url: `${featureUrl}?token=test-token` },
        { url: `${featureUrl}#fragment` },
        { url: featureUrl.replace("example.com", "user:pass@example.com") },
        { url: featureUrl.replace("/FeatureServer/0", "/FeatureServer") },
        { url: `${featureUrl}/query` },
      ],
    ],
  ]) {
    for (const input of invalidInputs) {
      await assert.rejects(definitions[index].execute(input));
      await assert.rejects(tools[index].getTool().invoke(input));
    }
  }
  assert.equal(changes, 0);
});

test("agent name normalization keeps callbacks distinct and unsupported schemas fail explicitly", async () => {
  const { createFunctionTools } = await toolsModule;
  const names = ["panel.open", "panel_open", "x".repeat(90), "x".repeat(91)];
  const definition = {
    description: "A local action.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const tools = createFunctionTools(
    names.map((name) => ({
      ...definition,
      name,
      execute: async () => ({ originalName: name }),
    })),
  );
  assert.equal(new Set(tools.map((tool) => tool.name)).size, names.length);
  for (const [index, tool] of tools.entries()) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.deepEqual(resultObject(await tool.getTool().invoke({})), {
      originalName: names[index],
    });
  }
  for (const inputSchema of [
    { type: "array" },
    { type: "object", dependentSchemas: { open: { required: ["reason"] } } },
  ]) {
    assert.throws(
      () =>
        createFunctionTools([
          { ...definition, name: "test", inputSchema, execute() {} },
        ]),
      /Cannot convert the input schema for "test"/,
    );
  }
  assert.throws(
    () => createFunctionTools([{ ...definition, name: "test" }]),
    /execute callback/,
  );
});

test("callback errors and MCP-style error results reject instead of becoming successful results", async () => {
  const { createFunctionTools } = await toolsModule;
  for (const execute of [
    async () => {
      throw new Error("Basemap unavailable");
    },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "Basemap unavailable" }],
    }),
  ]) {
    const [tool] = createFunctionTools([
      {
        name: "set_basemap",
        description: "Change basemap.",
        inputSchema: { type: "object", properties: {} },
        execute,
      },
    ]);
    await assert.rejects(tool.getTool().invoke({}), /Basemap unavailable/);
  }
});

test("the adapter forwards cancellation and refuses stale sessions or late success", async () => {
  const { createFunctionTools } = await toolsModule;
  for (const abortSource of ["session", "invocation"]) {
    const session = new AbortController();
    const invocation = new AbortController();
    let finish;
    let receivedSignal;
    let calls = 0;
    const [tool] = createFunctionTools(
      [
        {
          name: "change",
          description: "A pending change.",
          inputSchema: { type: "object", properties: {} },
          execute: async (input, { signal }) => {
            calls++;
            receivedSignal = signal;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
      ],
      { signal: session.signal },
    );
    const pending = tool.execute({}, { signal: invocation.signal });
    assert.equal(receivedSignal.aborted, false);
    const controller = abortSource === "session" ? session : invocation;
    controller.abort(new Error("Canceled test request"));
    finish({ changed: true });
    await assert.rejects(pending, /Canceled test request/);
    assert.equal(receivedSignal.aborted, true);
    await assert.rejects(
      tool.execute({}, { signal: invocation.signal }),
      /Canceled test request/,
    );
    assert.equal(calls, 1);
  }
});

test("registration awaits promises and rolls back only this app's tools on failure", async () => {
  const { registerWebMcpTools } = await webmcpModule;
  const definitions = [{ name: "panel" }, { name: "basemap" }];
  for (const legacy of [false, true]) {
    const registered = new Set(["unrelated"]);
    const failure = new Error("Registration denied");
    const context = {
      registerTool(definition, { signal }) {
        if (definition.name === "basemap") {
          if (legacy) throw failure;
          return Promise.reject(failure);
        }
        registered.add(definition.name);
        if (!legacy) {
          signal.addEventListener("abort", () =>
            registered.delete(definition.name),
          );
          return Promise.resolve();
        }
      },
    };
    if (legacy) {
      context.unregisterTool = (name) => registered.delete(name);
    }
    await assert.rejects(registerWebMcpTools(definitions, context), failure);
    assert.deepEqual([...registered], ["unrelated"]);
  }
  await assert.rejects(
    registerWebMcpTools(definitions, undefined),
    /registration API/,
  );
});

async function createApp({
  search = "",
  modelContext,
  legacy = false,
  loadBasemap = async () => {},
  loadFeatureLayer = async () => {},
  queryFeatureExtent = async () => ({
    count: 5001,
    extent: new (await extentModule).default({
      xmin: 10,
      ymin: 20,
      xmax: 40,
      ymax: 60,
      spatialReference: { wkid: 3857 },
    }),
  }),
  createLayerView = async () => {},
  goTo = async () => {},
  getCredential = async () => ({
    token: "test-token",
    userId: "test-user",
    expires: Date.now() + 60_000,
  }),
} = {}) {
  const nodes = new Map();
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.textContent = "";
    }
    append(...children) {
      children.forEach((child) => {
        child.parent = this;
      });
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
      }
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    focus() {
      document.activeElement = this;
    }
    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    }
    async emit(type, event = {}) {
      return this.listeners.get(type)?.({
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
    requestSubmit() {
      return this.emit("submit");
    }
  }
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  for (const match of html.matchAll(/<([\w-]+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    nodes.set(
      match[3],
      Object.assign(new Element(match[1]), {
        id: match[3],
        hidden: /\shidden(?:\s|$)/.test(match[2]),
        disabled: /\sdisabled(?:\s|$)/.test(match[2]),
      }),
    );
  }
  nodes.get("demo-panel").append(nodes.get("close-panel"));
  document = {
    activeElement: null,
    querySelectorAll: () => [...nodes.values()],
    createElement: (tag) => new Element(tag),
    modelContext: legacy ? undefined : modelContext,
  };
  const agents = [];
  const authCalls = [];
  const basemaps = [];
  const featureLayers = [];
  const featureQueries = [];
  const mapMoves = [];
  const navigation = { assigned: "", reloads: 0, destroyedCredentials: 0 };
  const pageEvents = new Map();
  const context = vm.createContext({
    document,
    navigator: { modelContext: legacy ? modelContext : undefined },
    window: {
      addEventListener: (type, callback) => pageEvents.set(type, callback),
    },
    location: {
      search,
      href: `https://example.com/apps/webMCP/index.html${search}`,
      assign: (url) => {
        navigation.assigned = url;
      },
      reload: () => {
        navigation.reloads++;
      },
    },
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    DOMException,
    console,
    esriConfig: {},
    IdentityManager: {
      getCredential: async (url) => {
        authCalls.push(url);
        return getCredential(url);
      },
      destroyCredentials: () => {
        navigation.destroyedCredentials++;
      },
    },
    ArcGISMap: class {
      constructor({ basemap }) {
        this.basemap = { id: basemap, destroy() {} };
        this.layers = [];
      }
      add(layer) {
        this.layers.push(layer);
      }
      remove(layer) {
        this.layers = this.layers.filter((entry) => entry !== layer);
      }
    },
    MapView: class {
      constructor(properties) {
        Object.assign(this, properties);
        this.spatialReference = { wkid: 3857 };
      }
      on() {}
      async when() {
        return this;
      }
      async whenLayerView(layer) {
        assert.ok(this.map.layers.includes(layer));
        return createLayerView(layer);
      }
      async goTo(target, options) {
        mapMoves.push({ target, options, layers: [...this.map.layers] });
        return goTo(target, options);
      }
      destroy() {
        this.destroyed = true;
      }
    },
    Basemap: {
      fromId: (id) => {
        const basemap = {
          id,
          loadAll: () => loadBasemap(id),
          destroy() {
            this.destroyed = true;
          },
        };
        basemaps.push(basemap);
        return basemap;
      },
    },
    FeatureLayer: class {
      constructor(properties) {
        Object.assign(this, properties);
        this.id = `feature-${featureLayers.length + 1}`;
        this.title = "Places";
        this.isTable = false;
        this.fullExtent = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
        featureLayers.push(this);
      }
      async load(options) {
        this.loadOptions = options;
        await loadFeatureLayer(this, options);
        return this;
      }
      async queryExtent(query, options) {
        const request = { layer: this, query, options };
        featureQueries.push(request);
        request.result = await queryFeatureExtent(this, query, options);
        return request.result;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    LLMAgent: class {
      constructor(properties) {
        Object.assign(this, properties);
        this.registration = { name: this.name };
        agents.push(this);
      }
      destroy() {
        this.destroyed = true;
      }
    },
    createAgentMiddleware: (name, hooks) => ({ name, hooks }),
    createIcons() {},
    ...Object.fromEntries(
      [
        "Layers",
        "LogIn",
        "LogOut",
        "Map",
        "PanelLeft",
        "RotateCcw",
        "Wrench",
        "X",
      ].map((name) => [name, {}]),
    ),
    Option: class extends Element {
      constructor(text, value) {
        super("option");
        this.textContent = text;
        this.value = value;
      }
    },
    ...(await webmcpModule),
    ...(await toolsModule),
  });
  const source = readFileSync(join(__dirname, "app.js"), "utf8");
  vm.runInContext(
    source.slice(
      source.indexOf("const ui ="),
      source.indexOf("\ninitializeMap().catch"),
    ),
    context,
  );
  await context.initializeMap();
  await context.initializeWebMcp();
  vm.runInContext("ready = true; mountAssistant();", context);
  return {
    ui: Object.fromEntries(nodes),
    context,
    agents,
    authCalls,
    basemaps,
    featureLayers,
    featureQueries,
    mapMoves,
    navigation,
    pageEvents,
    read: (expression) => vm.runInContext(expression, context),
  };
}

test("entered portal URLs reload before authenticating against the selected sharing endpoint", async () => {
  const first = await createApp();
  first.ui["portal-url"].value = " https://example.com/portal/sharing/rest/ ";
  await first.ui["sign-in-form"].emit("submit");
  const target = new URL(first.navigation.assigned);
  assert.equal(target.searchParams.get("portal"), "https://example.com/portal");
  assert.equal(target.searchParams.get("signin"), "1");
  assert.deepEqual(first.authCalls, []);

  const selected = await createApp({ search: target.search });
  await selected.ui["sign-in-form"].emit("submit");
  assert.equal(
    selected.context.esriConfig.portalUrl,
    "https://example.com/portal",
  );
  assert.deepEqual(selected.authCalls, ["https://example.com/portal/sharing"]);
  assert.equal(selected.ui.login.hidden, true);
  assert.equal(selected.ui.account.hidden, false);
  assert.equal(selected.ui.username.textContent, "test-user");
  assert.equal(
    selected.ui["assistant-container"].children[0].tagName,
    "arcgis-assistant",
  );
  await selected.ui["sign-out"].emit("click");
  assert.equal(selected.navigation.destroyedCredentials, 1);
  assert.equal(selected.navigation.reloads, 1);
});

test("native tools, manual controls, and the assistant update the same map and independent flyout", async () => {
  const native = modelContextFixture();
  const app = await createApp({ modelContext: native });
  await app.ui["sign-in-form"].emit("submit");
  assert.equal(app.ui["webmcp-status"].dataset.state, "online");
  const assistant = app.ui["assistant-container"].children[0];
  const view = app.read("view");
  const center = view.center;
  app.ui["close-panel"].focus();
  await native.tools.get("set_panel_visibility").execute({ open: false });
  assert.equal(app.ui["demo-panel"].hidden, true);
  assert.equal(app.ui["toggle-panel"].attributes["aria-expanded"], "false");
  assert.equal(app.context.document.activeElement, app.ui["toggle-panel"]);
  assert.equal(app.ui["assistant-container"].children[0], assistant);
  await app.agents[0].tools[0].getTool().invoke({ open: true });
  assert.equal(app.ui["demo-panel"].hidden, false);
  await native.tools.get("set_basemap").execute({ basemap: "topo-vector" });
  assert.equal(view.map.basemap.id, "topo-vector");
  assert.equal(app.ui.basemap.value, "topo-vector");
  await app.agents[0].tools[1]
    .getTool()
    .invoke({ basemap: "dark-gray-vector" });
  assert.equal(view.map.basemap.id, "dark-gray-vector");
  app.ui.basemap.value = "satellite";
  await app.ui.basemap.emit("change");
  assert.equal(view.map.basemap.id, "satellite");
  assert.equal(view.center, center);
  assert.equal(view.zoom, 4);
  await app.ui["demo-panel"].emit("keydown", { key: "Escape" });
  assert.equal(app.ui["demo-panel"].hidden, true);

  const oldTool = app.agents[0].tools[0];
  await app.ui["new-conversation"].emit("click");
  await assert.rejects(oldTool.getTool().invoke({ open: true }));
  assert.equal(app.ui["demo-panel"].hidden, true);
  await native.tools.get("set_panel_visibility").execute({ open: true });
  assert.equal(app.ui["demo-panel"].hidden, false);
  assert.equal(app.agents[0].destroyed, true);
  app.pageEvents.get("pagehide")({ persisted: false });
  assert.equal(native.tools.size, 0);
  assert.equal(view.destroyed, true);
});

test("failed, canceled, and superseded basemap loads never overwrite the current map", async () => {
  const pending = new Map();
  const native = modelContextFixture();
  const app = await createApp({
    modelContext: native,
    loadBasemap: (id) =>
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      }),
  });
  const tool = native.tools.get("set_basemap");
  const first = tool.execute({ basemap: "topo-vector" });
  const second = tool.execute({ basemap: "gray-vector" });
  pending.get("gray-vector").resolve();
  await second;
  pending.get("topo-vector").resolve();
  await assert.rejects(first, /newer basemap request/);
  assert.equal(app.read("view.map.basemap.id"), "gray-vector");
  assert.equal(app.basemaps[0].destroyed, true);

  const failed = tool.execute({ basemap: "hybrid" });
  pending.get("hybrid").reject(new Error("Basemap service unavailable"));
  await assert.rejects(failed, /Basemap service unavailable/);
  assert.equal(app.ui.error.hidden, false);
  assert.match(app.ui.error.textContent, /Basemap service unavailable/);

  const controller = new AbortController();
  const canceled = tool.execute(
    { basemap: "satellite" },
    { signal: controller.signal },
  );
  controller.abort();
  pending.get("satellite").resolve();
  await assert.rejects(canceled, { name: "AbortError" });
  assert.equal(app.read("view.map.basemap.id"), "gray-vector");
  assert.equal(app.ui.basemap.value, "gray-vector");
  assert.ok(
    app.basemaps
      .filter(({ id }) => id !== "gray-vector")
      .every(({ destroyed }) => destroyed),
  );
});

test("unsupported browsers are labeled honestly while local assistant tools remain usable", async () => {
  const app = await createApp();
  assert.equal(app.ui["webmcp-status"].dataset.state, "unavailable");
  assert.match(app.ui["webmcp-help"].textContent, /same local tools/);
  await app.ui["sign-in-form"].emit("submit");
  await app.agents[0].tools[0].getTool().invoke({ open: false });
  assert.equal(app.ui["demo-panel"].hidden, true);

  const native = modelContextFixture();
  const preview = await createApp({ modelContext: native, legacy: true });
  assert.match(
    preview.ui["webmcp-help"].textContent,
    /navigator\.modelContext/,
  );
  assert.equal(native.tools.size, 3);
});

test("feature layer tools load the data URL, add the layer, and zoom to all queried features through either entry point", async () => {
  const native = modelContextFixture();
  const app = await createApp({ modelContext: native });
  await app.ui["sign-in-form"].emit("submit");
  const tool = native.tools.get("add_feature_layer");
  const adminUrl = featureUrl.replace(
    "/rest/services/",
    "/rest/admin/services/",
  );
  const nativeResult = await tool.execute({ url: `${adminUrl}/` });
  const functionTool = app.agents[0].tools.find(
    ({ name }) => name === tool.name,
  );
  const assistantResult = resultObject(
    await functionTool.getTool().invoke({ url: featureUrl }),
  );
  const view = app.read("view");
  assert.deepEqual(view.map.layers, app.featureLayers);
  assert.equal(app.featureLayers.length, 2);
  for (const [index, result] of [nativeResult, assistantResult].entries()) {
    const layer = app.featureLayers[index];
    const request = app.featureQueries[index];
    const move = app.mapMoves[index];
    assert.equal(layer.url, featureUrl);
    assert.equal(request.query.where, "1=1");
    assert.equal(request.query.geometry, undefined);
    assert.equal(request.query.outSpatialReference, view.spatialReference);
    assert.equal(request.options.signal, layer.loadOptions.signal);
    assert.equal(move.options.signal, request.options.signal);
    assert.ok(move.layers.includes(layer));
    assert.ok(move.target.contains(request.result.extent));
    assert.ok(move.target.width > request.result.extent.width);
    assert.ok(move.target.xmin > layer.fullExtent.xmax);
    assert.deepEqual(structuredClone(result.structuredContent), {
      id: layer.id,
      title: layer.title,
      url: featureUrl,
      featureCount: 5001,
      extent: request.result.extent.toJSON(),
    });
    assert.match(result.content[0].text, /zoomed to the extent of all/);
  }
});

test("empty and nonspatial feature layers are reported without adding a layer or navigating", async () => {
  for (const options of [
    {
      loadFeatureLayer: async (layer) => {
        layer.isTable = true;
      },
    },
    { queryFeatureExtent: async () => ({ count: 0, extent: null }) },
    { queryFeatureExtent: async () => ({ count: 3, extent: null }) },
  ]) {
    const native = modelContextFixture();
    const app = await createApp({ modelContext: native, ...options });
    await assert.rejects(
      native.tools.get("add_feature_layer").execute({ url: featureUrl }),
      /spatial/,
    );
    assert.equal(app.read("view.map.layers.length"), 0);
    assert.equal(app.mapMoves.length, 0);
    assert.equal(app.featureLayers[0].destroyed, true);
    assert.equal(app.ui.error.hidden, false);
  }
});

test("coincident feature locations use a point target and a usable zoom", async () => {
  const { default: Extent } = await extentModule;
  const extent = new Extent({
    xmin: 10,
    ymin: 20,
    xmax: 10,
    ymax: 20,
    spatialReference: { wkid: 3857 },
  });
  const native = modelContextFixture();
  const app = await createApp({
    modelContext: native,
    queryFeatureExtent: async () => ({ count: 5, extent }),
  });
  await native.tools.get("add_feature_layer").execute({ url: featureUrl });
  const { target } = app.mapMoves[0];
  assert.equal(target.target.type, "point");
  assert.equal(target.target.x, 10);
  assert.equal(target.target.y, 20);
  assert.ok(Number.isFinite(target.zoom) && target.zoom > 0);
});

test("feature loading, query, layer-view, and navigation errors remove only the incomplete layer", async () => {
  for (const hook of [
    "loadFeatureLayer",
    "queryFeatureExtent",
    "createLayerView",
    "goTo",
  ]) {
    const native = modelContextFixture();
    const failure = new Error(`${hook} failed`);
    const app = await createApp({
      modelContext: native,
      [hook]: async () => {
        throw failure;
      },
    });
    const existing = { id: "existing-layer" };
    app.read("view.map").add(existing);
    await assert.rejects(
      native.tools.get("add_feature_layer").execute({ url: featureUrl }),
      failure,
    );
    assert.deepEqual(app.read("view.map.layers"), [existing]);
    assert.equal(app.featureLayers[0].destroyed, true);
    assert.equal(app.ui.error.textContent, failure.message);
    assert.equal(app.ui.activity.textContent, "add_feature_layer: error");
  }
});

test("cancellation removes an incomplete feature layer and prevents late additions or navigation", async () => {
  const { default: Extent } = await extentModule;
  for (const hook of [
    "loadFeatureLayer",
    "queryFeatureExtent",
    "createLayerView",
    "goTo",
  ]) {
    const started = Promise.withResolvers();
    const pending = Promise.withResolvers();
    const native = modelContextFixture();
    const app = await createApp({
      modelContext: native,
      [hook]: async () => {
        started.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const call = native.tools
      .get("add_feature_layer")
      .execute({ url: featureUrl }, { signal: controller.signal });
    await started.promise;
    controller.abort();
    assert.equal(app.featureLayers[0].destroyed, true);
    assert.equal(app.read("view.map.layers.length"), 0);
    pending.resolve({
      count: 3,
      extent: new Extent({
        xmin: 10,
        ymin: 20,
        xmax: 40,
        ymax: 60,
        spatialReference: { wkid: 3857 },
      }),
    });
    await assert.rejects(call, { name: "AbortError" });
    assert.equal(app.read("view.map.layers.length"), 0);
    assert.equal(app.mapMoves.length, hook === "goTo" ? 1 : 0);
    assert.equal(app.featureLayers[0].loadOptions.signal.aborted, true);
    if (hook === "goTo")
      assert.equal(app.mapMoves[0].options.signal.aborted, true);
    assert.equal(app.ui.activity.textContent, "add_feature_layer: canceled");
  }
});

test("invalid portals, canceled login, and expired credentials never mount an assistant", async () => {
  const invalid = await createApp();
  invalid.ui["portal-url"].value = "http://example.com/portal";
  await invalid.ui["sign-in-form"].emit("submit");
  assert.deepEqual(invalid.authCalls, []);
  assert.match(invalid.ui.error.textContent, /HTTPS portal URL/);
  for (const getCredential of [
    async () => {
      throw Object.assign(new Error("Canceled"), {
        name: "identity-manager:user-aborted",
      });
    },
    async () => ({ token: "expired-test-token", expires: Date.now() - 1 }),
  ]) {
    const app = await createApp({ getCredential });
    await app.ui["sign-in-form"].emit("submit");
    assert.equal(app.agents.length, 0);
    assert.equal(app.ui.login.hidden, false);
    assert.equal(app.ui.account.hidden, true);
    assert.equal(app.ui.error.hidden, false);
    assert.equal(app.ui["sign-in"].disabled, false);
    assert.match(
      app.ui["assistant-container"].children[0]?.textContent || "",
      /Sign in with ArcGIS/,
    );
  }
});
