"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const services = import("./services.js");

test("all eight helper services use the existing endpoint and authentication contract", async () => {
  const { HELPER_SERVICES, requestHelperService } = await services;
  assert.deepEqual(
    HELPER_SERVICES.map((service) => service.endpoint),
    [
      "text/analyze",
      "text/translate",
      "image/analyze",
      "image/extractText",
      "file/analyze",
      "embeddings",
      "audio/speech",
      "audio/transcribe",
    ],
  );
  for (const service of HELPER_SERVICES) {
    const payload = { input: "test input" };
    const response = {
      success: true,
      results: [
        service.name === "translate_text"
          ? {
              translations: [{ text: "result", to: "fr" }],
              key: "key:1",
            }
          : { value: "result" },
      ],
    };
    const result = await requestHelperService(
      service.name,
      payload,
      "test-token",
      {
        fetchImpl: async (url, options) => {
          assert.equal(
            url,
            `https://aiutilsdev.arcgis.com/api/${service.endpoint}`,
          );
          assert.equal(options.method, "POST");
          assert.equal(
            options.headers["X-Esri-Authorization"],
            "Bearer test-token",
          );
          assert.deepEqual(JSON.parse(options.body), payload);
          assert.equal(options.credentials, "omit");
          assert.equal(options.redirect, "error");
          assert.equal(options.cache, "no-store");
          assert.ok(options.signal instanceof AbortSignal);
          return Response.json(response);
        },
      },
    );
    assert.deepEqual(result, response);
  }
});

test("captured translation responses reach Results and the assistant", async () => {
  const { requestHelperService } = await services;
  const response = {
    success: true,
    meta: {
      usage: { inputCharacters: 37 },
      model: "azure-ai-translator",
    },
    results: [
      {
        translations: [
          {
            text: "Traduis tout mon message en fran\u00e7ais",
            to: "fr",
          },
        ],
        key: "key:1",
      },
    ],
  };
  const app = await createApp({
    request: (name, payload, token, options) =>
      requestHelperService(name, payload, token, {
        ...options,
        fetchImpl: async () => Response.json(response),
      }),
  });
  try {
    const tool = app.agent.tools.find(
      (candidate) => candidate.name === "translate_text",
    );
    const result = await tool.execute({
      text: "translate my entire message to french",
      outputCultures: ["fr"],
    });
    const expectedText = "fr: Traduis tout mon message en fran\u00e7ais";
    assert.equal(result.success, true);
    assert.equal(result.text, expectedText);
    assert.equal(app.nodes.get("result-count").textContent, "1");
    assert.equal(
      app.nodes.get("output-panel").children[0].textContent,
      expectedText,
    );
    assert.deepEqual(
      JSON.parse(app.nodes.get("json-panel").textContent),
      response,
    );
    const workspace = app.agent.tools
      .find((candidate) => candidate.name === "inspect_workspace")
      .execute({});
    assert.equal(workspace.result.text, expectedText);
  } finally {
    app.cleanup();
  }
});

test("translation batches preserve every source entry and target language", async () => {
  const { requestHelperService, resultText } = await services;
  const response = {
    success: true,
    results: [
      {
        key: "key:0",
        translations: [
          { text: "Bonjour", to: "fr" },
          { text: "Hola", to: "es" },
        ],
      },
      {
        key: "key:1",
        translations: [
          { text: "Au revoir", to: "fr" },
          { text: "Adi\u00f3s", to: "es" },
        ],
      },
    ],
  };
  const result = await requestHelperService("translate_text", {}, "token", {
    fetchImpl: async () => Response.json(response),
  });
  assert.deepEqual(result, response);
  assert.equal(
    resultText(result),
    "fr: Bonjour\nes: Hola\nfr: Au revoir\nes: Adi\u00f3s",
  );
});

test("malformed and partially failed translation results are rejected", async () => {
  const { requestHelperService } = await services;
  const translations = [{ text: "Bonjour", to: "fr" }];
  for (const entry of [
    { value: "Incorrect response format" },
    { translations: [] },
    { translations: [null] },
    { translations: [{ text: "Bonjour" }] },
    { translations: [{ text: 42, to: "fr" }] },
    {
      translations: [{ text: "Bonjour", to: "" }],
    },
    { translations, success: false },
  ]) {
    await assert.rejects(
      requestHelperService("translate_text", {}, "token", {
        fetchImpl: async () =>
          Response.json({
            success: true,
            results: [{ translations }, entry],
          }),
      }),
      /successful/,
    );
  }
});

test("media encoding preserves MIME types and rejects invalid input", async () => {
  const { createMediaInput } = await services;
  assert.equal(
    await createMediaInput(
      new Blob(["audio"], {
        type: "audio/webm;codecs=opus",
      }),
    ),
    "data:audio/webm;base64,YXVkaW8=",
  );
  assert.equal(
    await createMediaInput("https://example.com/image.jpg"),
    "https://example.com/image.jpg",
  );
  for (const media of [
    new Blob([]),
    new Blob(["unknown"]),
    "http://example.com/image.jpg",
    "https://user:pass@example.com/image.jpg",
  ]) {
    await assert.rejects(createMediaInput(media));
  }
});

test("HTTP errors, expired tokens, partial failures, and malformed JSON are rejected", async () => {
  const { requestHelperService } = await services;
  for (const [response, expected] of [
    [new Response(null, { status: 401 }), { status: 401 }],
    [Response.json({ error: { code: 498 } }), { status: 498 }],
    [Response.json({ success: false }), /successful/],
    [
      Response.json({
        success: true,
        results: [{ success: false }],
      }),
      /successful/,
    ],
    [
      Response.json({
        success: true,
        results: [],
      }),
      /successful/,
    ],
    [
      Response.json({
        success: true,
        results: [{}],
      }),
      /successful/,
    ],
    [Response.json({ success: true }), /successful/],
    [new Response("not json"), /successful/],
  ]) {
    await assert.rejects(
      requestHelperService("analyze_text", {}, "token", {
        fetchImpl: async () => response,
      }),
      expected,
    );
  }
  await assert.rejects(requestHelperService("unknown", {}, "token"), /Unknown/);
  await assert.rejects(requestHelperService("analyze_text", {}, ""), /Sign in/);
});

test("binary speech responses are normalized without forwarding credentials", async () => {
  const { requestHelperService } = await services;
  const result = await requestHelperService(
    "generate_speech",
    { input: "Hello" },
    "private-token",
    {
      fetchImpl: async () =>
        new Response("audio", {
          headers: {
            "content-type": "audio/mpeg",
          },
        }),
    },
  );
  assert.equal(result.meta.contentType, "audio/mpeg");
  assert.equal(result.results[0].value, "YXVkaW8=");
  assert.ok(!JSON.stringify(result).includes("private-token"));
});

test("request cancellation reaches the underlying fetch", async () => {
  const { requestHelperService } = await services;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestHelperService("analyze_text", {}, "token", {
      signal: controller.signal,
      fetchImpl: async (_url, options) => options.signal.throwIfAborted(),
    }),
    { name: "AbortError" },
  );
});

test("each endpoint has a validated tool schema and the correct payload", async () => {
  const { HELPER_TOOL_DEFINITIONS, createServicePayload } =
    await import("./tools.js");
  const { HELPER_SERVICES } = await services;
  assert.deepEqual(
    HELPER_TOOL_DEFINITIONS.map((tool) => tool.name),
    HELPER_SERVICES.map((service) => service.name),
  );
  for (const tool of HELPER_TOOL_DEFINITIONS)
    assert.equal(tool.inputSchema.safeParse({}).success, false);
  assert.deepEqual(
    await createServicePayload("analyze_text", {
      text: "Report",
      prompt: "Summarize",
    }),
    {
      input: "Report",
      data: [{ key: "key:1", context: "Summarize" }],
    },
  );
  assert.deepEqual(
    await createServicePayload("translate_text", {
      text: ["Hello", "Goodbye"],
      outputCultures: ["es", "fr"],
    }),
    {
      input: [
        { key: "key:0", text: "Hello" },
        { key: "key:1", text: "Goodbye" },
      ],
      inputCulture: "en",
      outputCultures: ["es", "fr"],
    },
  );
  for (const [name, kind, mime] of [
    ["analyze_image", "image", "image/png"],
    ["extract_image_text", "image", "image/png"],
    ["analyze_file", "pdf", "application/pdf"],
    ["transcribe_audio", "audio", "audio/webm"],
  ]) {
    const payload = await createServicePayload(
      name,
      {
        source: "attachment",
        prompt: "Read",
        inputCulture: "fr",
      },
      async (source, expectedKind) => {
        assert.equal(source, "attachment");
        assert.equal(expectedKind, kind);
        return new Blob(["media"], {
          type: mime,
        });
      },
    );
    assert.equal(payload.input, `data:${mime};base64,bWVkaWE=`);
    assert.equal(payload.inputCulture, "fr");
    if (name !== "transcribe_audio")
      assert.deepEqual(payload.data, [{ key: "key:1", context: "Read" }]);
  }
  assert.deepEqual(
    await createServicePayload("generate_speech", {
      text: "Hello",
      outputSpeechRate: "slow",
    }),
    {
      input: "Hello",
      inputCulture: "en",
      outputSpeechRate: "slow",
    },
  );
});

test("embeddings preserve a supplied request object and support JSON attachments", async () => {
  const { createServicePayload } = await import("./tools.js");
  const request = {
    input: ["harbor"],
    model: "user-specified-model",
  };
  assert.deepEqual(
    await createServicePayload("generate_embeddings", {
      requestJson: JSON.stringify(request),
    }),
    request,
  );
  assert.deepEqual(
    await createServicePayload(
      "generate_embeddings",
      { requestJson: "attachment" },
      async (source, kind) => {
        assert.equal(source, "attachment");
        assert.equal(kind, "json");
        return new Blob([JSON.stringify(request)], {
          type: "application/json",
        });
      },
    ),
    request,
  );
  for (const requestJson of ["bad JSON", "null", "[]", "true"]) {
    await assert.rejects(
      createServicePayload("generate_embeddings", { requestJson }),
      /JSON/,
    );
  }
});

test("generated audio decodes raw base64 and data URLs and rejects non-audio results", async () => {
  const { decodeSpeechAudio } = await services;
  const audio = decodeSpeechAudio("data:audio/mpeg;base64,YXVkaW8=");
  assert.equal(audio.type, "audio/mpeg");
  assert.equal(await audio.text(), "audio");
  assert.equal(
    await decodeSpeechAudio("YXVkaW8=", "audio/wav").text(),
    "audio",
  );
  for (const value of [
    "",
    "%%%",
    "data:text/html;base64,YXVkaW8=",
    "data:audio/mpeg,audio",
  ]) {
    assert.throws(() => decodeSpeechAudio(value));
  }
});

async function createApp({ request, getCredential, signedIn = true } = {}) {
  const nodes = new Map();
  class Element extends EventTarget {
    constructor(tag = "div") {
      super();
      this.tagName = tag;
      this.children = [];
      this.value = "";
      this.textContent = "";
      this.dataset = {};
      this.attributes = {};
      this.hidden = false;
    }
    replaceChildren(...children) {
      this.children = children;
      if (this.tagName === "select") this.value = children[0]?.value || "";
    }
    append(...children) {
      this.children.push(...children);
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    querySelectorAll(tag) {
      return this.children
        .flatMap((child) => [child, ...child.querySelectorAll(tag)])
        .filter((child) => child.tagName === tag);
    }
    pause() {}
    load() {}
    click() {}
    focus() {}
    remove() {}
  }
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)) {
    nodes.set(
      match[2],
      Object.assign(new Element(match[1]), {
        id: match[2],
      }),
    );
  }
  const document = {
    querySelectorAll: () => [...nodes.values()],
    createElement: (tag) => new Element(tag),
  };
  const tools = await import("./tools.js");
  const helpers = await services;
  const calls = [];
  const authCalls = [];
  let destroyedCredentials = 0;
  let reloads = 0;
  const context = vm.createContext({
    document,
    window: Object.assign(new EventTarget(), {
      location: {
        reload() {
          reloads++;
        },
      },
    }),
    URL,
    URLSearchParams,
    File,
    Blob,
    AbortController,
    AbortSignal,
    DOMException,
    location: {
      search: "",
      href: "https://example.com/apps/helper-services-assistant/",
    },
    navigator: {},
    esriConfig: {},
    IdentityManager: {
      async getCredential(url) {
        authCalls.push(url);
        return getCredential
          ? getCredential(url)
          : {
              token: "test-token",
              userId: "test-user",
              expires: Date.now() + 60000,
            };
      },
      destroyCredentials() {
        destroyedCredentials++;
      },
    },
    createIcons() {},
    ...Object.fromEntries(
      [
        "Camera",
        "Copy",
        "Download",
        "Layers",
        "LogIn",
        "LogOut",
        "MapPinOff",
        "Paperclip",
        "PanelBottom",
        "RotateCcw",
        "Trash2",
        "X",
      ].map((name) => [name, {}]),
    ),
    GraphicsLayer: class {
      constructor() {
        this.graphics = [];
      }
      removeAll() {
        this.graphics = [];
      }
      addMany(graphics) {
        this.graphics.push(...graphics);
      }
      removeMany(graphics) {
        this.graphics = this.graphics.filter(
          (graphic) => !graphics.includes(graphic),
        );
      }
    },
    FunctionTool: class {
      constructor(properties) {
        Object.assign(this, properties);
      }
    },
    LLMAgent: class {
      constructor(properties) {
        Object.assign(this, properties);
        this.registration = {
          name: this.name,
          createGraph() {},
        };
      }
    },
    createAgentMiddleware: (name, hooks) => ({
      name,
      hooks,
    }),
    Option: class extends Element {
      constructor(text, value) {
        super("option");
        this.textContent = text;
        this.value = value;
      }
    },
    ...helpers,
    ...tools,
    z: (await import("zod")).z,
    requestHelperService: async (name, payload, token, options) => {
      calls.push({
        name,
        payload,
        token,
        options,
      });
      if (request) return request(name, payload, token, options);
      const entry =
        name === "translate_text"
          ? {
              translations: payload.outputCultures.map((to) => ({
                text: "Service result",
                to,
              })),
            }
          : {
              value: name === "generate_speech" ? "YXVkaW8=" : "Service result",
            };
      return {
        success: true,
        results: [entry],
        meta: { contentType: "audio/mpeg" },
      };
    },
  });
  const source = readFileSync(join(__dirname, "app.js"), "utf8");
  vm.runInContext(
    source
      .slice(
        source.indexOf("const ui ="),
        source.indexOf("async function initialize()"),
      )
      .replace("export function createAgent", "function createAgent"),
    context,
  );
  if (signedIn)
    vm.runInContext(
      "credential = { token: 'test-token', userId: 'test-user', expires: Date.now() + 60000 };",
      context,
    );
  const agent = context.createAgent();
  return {
    context,
    nodes,
    calls,
    agent,
    authCalls,
    destroyedCredentials: () => destroyedCredentials,
    reloads: () => reloads,
    installAuthentication: () => context.installAuthentication(agent),
    submitLogin: () =>
      nodes.get("sign-in-form").dispatchEvent(
        new Event("submit", {
          cancelable: true,
        }),
      ),
    cleanup: () => {
      context.clearResults();
      context.clearAttachment();
    },
  };
}

test("registered tool callbacks execute all eight services and publish their results", async () => {
  const app = await createApp();
  const inputs = {
    analyze_text: {
      text: "Report",
      prompt: "Summarize",
    },
    translate_text: {
      text: "Hello",
      outputCultures: ["es"],
    },
    analyze_image: {
      source: "https://example.com/image.png",
      prompt: "Describe",
    },
    extract_image_text: {
      source: "https://example.com/image.png",
      prompt: "Extract all text",
    },
    analyze_file: {
      source: "https://example.com/report.pdf",
      prompt: "Summarize",
    },
    generate_embeddings: {
      requestJson: '{"input":["harbor"]}',
    },
    generate_speech: { text: "Hello" },
    transcribe_audio: {
      source: "https://example.com/audio.webm",
    },
  };
  try {
    assert.equal(app.agent.registration.name, "Helper Services");
    for (const [name, input] of Object.entries(inputs)) {
      const tool = app.agent.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Missing ${name}`);
      const result = await tool.execute(tool.inputSchema.parse(input));
      assert.equal(result.success, true);
      assert.equal(result.resultId, `result-${app.calls.length}`);
      assert.equal(result.outputWindow, "Results");
      assert.ok(!JSON.stringify(result).includes("test-token"));
      if (name === "generate_speech")
        assert.ok(!JSON.stringify(result).includes("YXVkaW8="));
    }
    assert.equal(app.calls.length, 8);
    assert.equal(app.nodes.get("result-count").textContent, "8");
    assert.equal(app.nodes.get("download-result").disabled, false);
  } finally {
    app.cleanup();
  }
});

test("attachments expose only metadata to the agent and enforce media type matching", async () => {
  const app = await createApp();
  try {
    app.context.setAttachment(
      new File(["private file bytes"], "photo.png", { type: "image/png" }),
    );
    const state = app.agent.tools
      .find((tool) => tool.name === "inspect_workspace")
      .execute({});
    assert.equal(state.attachment.name, "photo.png");
    assert.ok(!JSON.stringify(state).includes("private file bytes"));
    const image = await app.context.resolveMedia("attachment", "image");
    assert.equal(await image.text(), "private file bytes");
    await assert.rejects(
      app.context.resolveMedia("attachment", "pdf"),
      /pdf attachment/,
    );
    await assert.rejects(
      app.context.resolveMedia("map", "audio"),
      /only available to image/,
    );
    app.context.clearAttachment();
    await assert.rejects(
      app.context.resolveMedia("attachment", "image"),
      /No attachment/,
    );
  } finally {
    app.cleanup();
  }
});

test("canceled and expired sessions cannot publish late helper results", async () => {
  let resolveRequest;
  const app = await createApp({
    request: () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
  });
  const tool = app.agent.tools.find(
    (candidate) => candidate.name === "analyze_text",
  );
  try {
    const pending = tool.execute({
      text: "Report",
      prompt: "Summarize",
    });
    await new Promise(setImmediate);
    app.context.cancelRequests();
    resolveRequest({
      success: true,
      results: [{ value: "Late result" }],
    });
    await assert.rejects(pending, /canceled/);
    assert.equal(app.calls[0].options.signal.aborted, true);
    assert.equal(app.nodes.get("result-selection").children.length, 0);
    vm.runInContext("credential.expires = 1", app.context);
    await assert.rejects(
      tool.execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
    assert.equal(app.calls.length, 1);
  } finally {
    app.cleanup();
  }
});

test("service errors leave no successful output and use plain text in the error panel", async () => {
  const app = await createApp({
    request: async () => {
      throw new Error("<script>not markup</script>");
    },
  });
  try {
    await assert.rejects(
      app.agent.tools
        .find((tool) => tool.name === "analyze_text")
        .execute({
          text: "Report",
          prompt: "Summarize",
        }),
      /not markup/,
    );
    assert.equal(
      app.nodes.get("error").textContent,
      "<script>not markup</script>",
    );
    assert.equal(app.nodes.get("error").hidden, false);
    assert.equal(app.nodes.get("result-selection").children.length, 0);
  } finally {
    app.cleanup();
  }
});

test("portal sign-in uses the same IdentityManager flow as AI Services and enables the assistant", async () => {
  const app = await createApp({
    signedIn: false,
  });
  try {
    app.installAuthentication();
    assert.equal(app.nodes.get("login").hidden, false);
    assert.equal(app.nodes.get("account").hidden, true);
    assert.equal(
      app.nodes.get("assistant-container").children[0].textContent,
      "Sign in required",
    );
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
    assert.equal(app.calls.length, 0);
    app.nodes.get("portal-url").value =
      "https://excalibur.mapsdevext.arcgis.com/sharing/rest/";
    app.submitLogin();
    assert.equal(app.nodes.get("sign-in").disabled, true);
    assert.equal(app.nodes.get("portal-url").disabled, true);
    await new Promise(setImmediate);
    assert.deepEqual(app.authCalls, [
      "https://excalibur.mapsdevext.arcgis.com/sharing",
    ]);
    assert.equal(
      app.nodes.get("portal-url").value,
      "https://excalibur.mapsdevext.arcgis.com",
    );
    assert.equal(app.nodes.get("login").hidden, true);
    assert.equal(app.nodes.get("username").textContent, "test-user");
    assert.equal(app.nodes.get("account").hidden, false);
    assert.equal(
      app.nodes.get("assistant-container").children[0].tagName,
      "arcgis-assistant",
    );
    await app.agent.tools[0].execute({
      text: "Report",
      prompt: "Summarize",
    });
    assert.equal(app.calls[0].token, "test-token");
    app.nodes.get("sign-out").dispatchEvent(new Event("click"));
    assert.equal(app.destroyedCredentials(), 1);
    assert.equal(app.reloads(), 1);
    assert.equal(app.nodes.get("result-count").textContent, "0");
    assert.equal(app.nodes.get("login").hidden, false);
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
  } finally {
    app.cleanup();
  }
});

test("invalid portals and canceled sign-ins do not authorize services", async () => {
  const app = await createApp({
    signedIn: false,
    getCredential: async () => {
      throw Object.assign(new Error(), {
        name: "identity-manager:user-aborted",
      });
    },
  });
  try {
    app.installAuthentication();
    app.nodes.get("portal-url").value = "http://example.com";
    app.submitLogin();
    await new Promise(setImmediate);
    assert.equal(app.authCalls.length, 0);
    assert.match(app.nodes.get("error").textContent, /HTTPS/);
    app.nodes.get("portal-url").value =
      "https://excalibur.mapsdevext.arcgis.com";
    app.submitLogin();
    await new Promise(setImmediate);
    assert.equal(app.nodes.get("error").textContent, "Sign-in canceled.");
    assert.equal(app.nodes.get("sign-in").disabled, false);
    assert.equal(app.nodes.get("portal-url").disabled, false);
    assert.equal(app.nodes.get("login").hidden, false);
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
  } finally {
    app.cleanup();
  }
});

test("a late sign-in cannot restore a signed-out session", async () => {
  let finishSignIn;
  const app = await createApp({
    signedIn: false,
    getCredential: () =>
      new Promise((resolve) => {
        finishSignIn = resolve;
      }),
  });
  try {
    app.installAuthentication();
    app.submitLogin();
    app.nodes.get("sign-out").dispatchEvent(new Event("click"));
    finishSignIn({
      token: "late-token",
      userId: "late-user",
    });
    await new Promise(setImmediate);
    assert.equal(app.nodes.get("login").hidden, false);
    assert.equal(app.nodes.get("account").hidden, true);
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
  } finally {
    app.cleanup();
  }
});

test("structured service values remain available for follow-up tools", async () => {
  const { resultText } = await services;
  const value = {
    language: "es",
    translation: "Hola",
  };
  assert.deepEqual(JSON.parse(resultText({ results: [{ value }] })), value);
});

test("service token rejection clears credentials and returns to the portal sign-in form", async () => {
  const app = await createApp({
    request: async () => {
      throw Object.assign(new Error("Token rejected"), { status: 498 });
    },
  });
  try {
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Token rejected/,
    );
    assert.equal(app.destroyedCredentials(), 1);
    assert.equal(app.nodes.get("login").hidden, false);
    assert.equal(app.nodes.get("account").hidden, true);
    assert.equal(
      app.nodes.get("assistant-container").children[0].textContent,
      "Sign in required",
    );
    await assert.rejects(
      app.agent.tools[0].execute({
        text: "Report",
        prompt: "Summarize",
      }),
      /Sign in/,
    );
    assert.equal(app.calls.length, 1);
  } finally {
    app.cleanup();
  }
});

test("the helper agent uses the existing model's chat-completions transport without changing tool-call context", async () => {
  const app = await createApp();
  try {
    const completions = {
      model: "gpt-5.6-terra",
      configuration: { fetch: async () => {} },
    };
    const request = {
      model: { completions, responses: {} },
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-count",
              name: "analyze_image",
              args: {
                source: "map",
                prompt: "Count buildings",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-count",
          content: "42",
        },
      ],
      tools: app.agent.tools,
      signal: new AbortController().signal,
    };
    const result = await app.agent.middlewares[0].hooks.wrapModelCall(
      request,
      (forwarded) => {
        assert.equal(forwarded.model, completions);
        assert.equal(forwarded.messages, request.messages);
        assert.equal(forwarded.tools, request.tools);
        assert.equal(forwarded.signal, request.signal);
        return {
          content: "There are 42 visible buildings.",
        };
      },
    );
    assert.equal(result.content, "There are 42 visible buildings.");
    assert.notEqual(request.model, completions);
  } finally {
    app.cleanup();
  }
});

test("numeric image-analysis results, including zero, reach the assistant's tool response", async () => {
  for (const count of [0, 42]) {
    const app = await createApp({
      request: async () => ({
        success: true,
        results: [{ success: true, value: count }],
      }),
    });
    try {
      const tool = app.agent.tools.find(
        (candidate) => candidate.name === "analyze_image",
      );
      const result = await tool.execute({
        source: "https://example.com/map.png",
        prompt: "Count buildings",
      });
      assert.equal(result.text, String(count));
      assert.equal(
        app.nodes.get("output-panel").children[0].textContent,
        String(count),
      );
    } finally {
      app.cleanup();
    }
  }
});

test("the assistant receives the same JSON fallback displayed in Results when result text is empty", async () => {
  const response = {
    success: true,
    results: [{ success: true, value: "" }],
    meta: { count: 42 },
  };
  const app = await createApp({
    request: async () => response,
  });
  try {
    const tool = app.agent.tools.find(
      (candidate) => candidate.name === "analyze_image",
    );
    const result = await tool.execute({
      source: "https://example.com/map.png",
      prompt: "Count buildings",
    });
    assert.equal(result.text, JSON.stringify(response, null, 2));
    assert.equal(
      result.text,
      app.nodes.get("output-panel").children[0].textContent,
    );
  } finally {
    app.cleanup();
  }
});

test("installed SDK model dependencies complete streamed and non-streamed tool round trips without encrypted reasoning replay", async () => {
  const sdkRequire = createRequire(
    require.resolve("@arcgis/ai-components/package.json"),
  );
  const { ChatOpenAI } = sdkRequire("@langchain/openai");
  const { createAgent, createMiddleware, tool } = sdkRequire("langchain");
  const { HELPER_TOOL_DEFINITIONS, useChatCompletions } =
    await import("./tools.js");
  for (const streaming of [false, true]) {
    const requests = [];
    let toolCalls = 0;
    const model = new ChatOpenAI({
      model: "gpt-5.6-terra",
      apiKey: "test-key",
      streaming,
      maxRetries: 0,
      configuration: {
        baseURL: "https://model.example.invalid/v1",
        fetch: async (url, options) => {
          const body = JSON.parse(options.body);
          requests.push({
            url: String(url),
            body,
          });
          assert.ok(String(url).endsWith("/chat/completions"));
          const first = requests.length === 1;
          const message = first
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call-count",
                    type: "function",
                    function: {
                      name: "analyze_image",
                      arguments: '{"source":"map","prompt":"Count buildings"}',
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "There are 42 visible buildings.",
              };
          const response = {
            id: `chatcmpl-${requests.length}`,
            model: "gpt-5.6-terra",
            created: 0,
            object: streaming ? "chat.completion.chunk" : "chat.completion",
            choices: [
              {
                index: 0,
                [streaming ? "delta" : "message"]: message,
                finish_reason: first ? "tool_calls" : "stop",
              },
            ],
          };
          return streaming
            ? new Response(
                `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`,
                {
                  headers: {
                    "Content-Type": "text/event-stream",
                  },
                },
              )
            : Response.json(response);
        },
      },
    });
    const imageTool = tool(
      async () => {
        toolCalls++;
        return JSON.stringify({
          success: true,
          text: "42",
        });
      },
      {
        name: "analyze_image",
        description: "Count visible buildings",
        schema: HELPER_TOOL_DEFINITIONS.find(
          (definition) => definition.name === "analyze_image",
        ).inputSchema,
      },
    );
    const agent = createAgent({
      model,
      tools: [imageTool],
      middleware: [
        createMiddleware({
          name: "helper-chat-completions",
          wrapModelCall: useChatCompletions,
        }),
      ],
    });
    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Count the buildings on the map.",
        },
      ],
    });
    assert.equal(
      result.messages.at(-1).content,
      "There are 42 visible buildings.",
    );
    assert.equal(toolCalls, 1);
    assert.equal(requests.length, 2);
    assert.ok(
      requests[1].body.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "call-count" &&
          message.content.includes("42"),
      ),
    );
    assert.ok(!JSON.stringify(requests).includes("encrypted_content"));
  }
});
