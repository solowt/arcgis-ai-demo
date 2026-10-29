"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "app.js"), "utf8");
const portalUrl = "https://example.maps.arcgis.com";
const serviceUrl = "https://rasteranalysis.arcgis.com/arcgis/rest/services/RasterAnalysisTools/GPServer";
const taskUrl = `${serviceUrl}/DetectObjectsUsingDeepLearning`;
const itemId = "0123456789abcdef0123456789abcdef";
const featureLayerUrl = "https://servicesdev.arcgis.com/example/arcgis/rest/services/AI_cars_test/FeatureServer/0";
const extent = { xmin: 10, ymin: 20, xmax: 110, ymax: 220, spatialReference: { wkid: 3857 } };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createApp(options = {}) {
  const elements = new Map();
  const windowEvents = new Map();
  const timers = new Map();
  const requests = [];
  const featureLayers = [];
  const watches = [];
  let sdkCallback;
  let view;
  let imagery;
  let timerId = 0;
  let uuid = 0;
  let credentialClears = 0;
  const config = {};
  const initialValues = {
    "analysis-model": "buildings", "analysis-prompt": "buildings", "portal-url": portalUrl,
  };
  class Element {
    constructor(id) {
      this.value = initialValues[id] || "";
      this.checked = false;
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this.children = [];
      this.style = {};
      this.events = new Map();
      this.attributes = new Map();
    }
    get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); }
    addEventListener(type, handler) { this.events.set(type, handler); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    focus() { this.focused = true; }
    dispatch(type) { return this.events.get(type)?.({ preventDefault() {} }); }
  }
  class ArcGISMap {
    constructor(properties) {
      Object.assign(this, properties);
      this.layers = [...properties.layers];
    }
    add(layer) { this.layers.push(layer); }
    remove(layer) { this.layers = this.layers.filter((candidate) => candidate !== layer); }
  }
  class MapView {
    constructor(properties) {
      Object.assign(this, properties);
      this.updating = false;
      this.stationary = true;
      this.ui = { add() {} };
      view = this;
    }
    async when() {}
    async whenLayerView() {}
    addHandles() {}
    destroy() { this.destroyed = true; this.map = null; }
  }
  class ImageryLayer {
    constructor(properties) {
      Object.assign(this, properties);
      this.fullExtent = {
        ...extent,
        toJSON() {
          return {
            xmin: this.xmin, ymin: this.ymin, xmax: this.xmax, ymax: this.ymax,
            spatialReference: { ...this.spatialReference },
          };
        },
      };
      imagery = this;
    }
    async load() {
      if (options.imageryError) throw options.imageryError;
    }
  }
  class FeatureLayer {
    constructor(properties) {
      Object.assign(this, properties);
      this.geometryType = "polygon";
      featureLayers.push(this);
    }
    async load() {
      if (options.loadOutput) await options.loadOutput();
      if (options.outputError) throw options.outputError;
    }
    createPopupTemplate() { return { content: [{ type: "fields" }] }; }
    async queryFeatureCount() { return options.count ?? 3; }
    destroy() { this.destroyed = true; }
  }
  const manager = {
    async getCredential(url) {
      assert.equal(url, `${portalUrl}/sharing`);
      if (options.loginError) throw options.loginError;
      return { userId: "test-user", token: "test-only-credential", expires: options.expires ?? Date.now() + 3_600_000 };
    },
    destroyCredentials() { credentialClears++; },
  };
  async function request(url, requestOptions) {
    requests.push({ url, options: requestOptions });
    if (options.request) return options.request(url, requestOptions);
    if (url.endsWith("/portals/self")) {
      return { data: options.portal || { helperServices: { rasterAnalytics: { url: serviceUrl } } } };
    }
    if (url === taskUrl) {
      return { data: { parameters: ["inputRaster", "model", "outputObjects", "outObjects"].map((name) => ({ name })) } };
    }
    if (url.endsWith("/submitJob")) return { data: { jobId: "j123", jobStatus: "esriJobSucceeded" } };
    if (url.endsWith("/results/outObjects")) {
      return { data: {
        paramName: "outObjects", dataType: "GPFeatureRecordSetLayer",
        value: options.outputValue === undefined ? { itemId } : options.outputValue,
      } };
    }
    throw new Error(`Unexpected request: ${url}`);
  }
  const context = vm.createContext({
    URL, AbortController,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element(id));
        return elements.get(id);
      },
      createElement: (tag) => new Element(tag),
    },
    window: {
      addEventListener: (type, handler) => windowEvents.set(type, handler),
      require: (modules, callback) => { sdkCallback = callback; },
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context);
  return {
    context, requests, featureLayers, windowEvents, timers, watches, config,
    ui: Object.fromEntries(elements),
    get view() { return view; },
    get imagery() { return imagery; },
    get credentialClears() { return credentialClears; },
    async initialize() {
      await sdkCallback(
        ArcGISMap, MapView, ImageryLayer, manager, config,
        { watch: (get, callback) => {
          let previous = get();
          const handle = {
            get, callback,
            check() {
              const next = get();
              const equal = Array.isArray(next) && Array.isArray(previous)
                ? next.length === previous.length && next.every((value, index) => value === previous[index])
                : next === previous;
              const old = previous;
              previous = next;
              if (!equal) callback(next, old);
            },
          };
          watches.push(handle);
          return handle;
        } },
        class {}, class {}, FeatureLayer, request,
      );
    },
    async signIn() { await elements.get("sign-in-form").dispatch("submit"); },
    async run() {
      elements.get("credit-consent").checked = true;
      await elements.get("analysis-form").dispatch("submit");
    },
  };
}

const { context } = createApp();
const {
  getPublicModel, normalizeModelPortalUrl, getRasterAnalysisTaskUrl, getModelAnalysisExtent,
  createModelAnalysisParameters, getModelOutputReference, requestModelJson, runModelJob,
} = context;
const settings = { threshold: 0.5, cellSize: 0.3, prompt: "  cars, buildings  ", outputName: "AI_test_123" };

test("uses the verified public Esri model item IDs, without an invented GeoVLM option", () => {
  assert.equal(getPublicModel("buildings").itemId, "a6857359a1cd44839781a4f113cd5934");
  assert.equal(getPublicModel("cars").itemId, "cfc57b507f914d1593f5871bf0d52999");
  assert.equal(getPublicModel("text-sam").itemId, "8df3bf4167bc4c7b967f677f8b362ec3");
  assert.throws(() => getPublicModel("geovlm"), /available public Esri models/);
  assert.doesNotMatch(source, /\/api\/image\/analyze/);
});

test("normalizes the same portal URL forms as the existing sign-in flow", () => {
  for (const suffix of ["", "/", "/sharing", "/sharing/", "/sharing/rest", "/sharing/rest/"]) {
    assert.equal(normalizeModelPortalUrl(`  ${portalUrl}${suffix}  `), portalUrl);
  }
  assert.equal(normalizeModelPortalUrl("https://example.com/portal/sharing/rest"), "https://example.com/portal");
  for (const url of ["http://example.com", "https://user:password@example.com", `${portalUrl}?token=x`, `${portalUrl}#x`, "invalid"]) {
    assert.throws(() => normalizeModelPortalUrl(url), /HTTPS portal URL/);
  }
});

test("discovers raster analysis only from the signed-in portal helper service", () => {
  assert.equal(getRasterAnalysisTaskUrl({ helperServices: { rasterAnalytics: { url: `${serviceUrl}/` } } }), taskUrl);
  for (const portal of [null, {}, { helperServices: {} }]) {
    assert.throws(() => getRasterAnalysisTaskUrl(portal), /no raster-analysis service/);
  }
  assert.throws(() => getRasterAnalysisTaskUrl({ helperServices: { rasterAnalytics: { url: portalUrl } } }), /unsupported/);
});

test("clips the submitted extent to the imagery and handles Web Mercator aliases", () => {
  const mapExtent = { xmin: 0, ymin: 40, xmax: 60, ymax: 300, spatialReference: { wkid: 102100 } };
  assert.deepEqual(structuredClone(getModelAnalysisExtent(mapExtent, extent)), {
    xmin: 10, ymin: 40, xmax: 60, ymax: 220, spatialReference: { wkid: 3857 },
  });
  assert.equal(mapExtent.xmin, 0);
  assert.throws(() => getModelAnalysisExtent({ ...extent, xmin: 110, xmax: 150 }, extent), /Pan back/);
  for (const candidate of [
    null, { ...extent, xmin: NaN }, { ...extent, xmax: Infinity }, { ...extent, ymax: 20 },
    { ...extent, spatialReference: { wkid: 4326 } },
  ]) {
    assert.throws(() => getModelAnalysisExtent(candidate, extent), /valid Web Mercator/);
  }
});

test("submits native imagery, explicit extent, GPU, and uniquely named hosted output using the REST contract", () => {
  for (const id of ["buildings", "cars", "text-sam"]) {
    const parameters = createModelAnalysisParameters(id, extent, settings);
    assert.deepEqual(JSON.parse(parameters.inputRaster), {
      url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Oblique/WU_Ortho/ImageServer",
    });
    assert.deepEqual(JSON.parse(parameters.model), {
      url: `https://www.arcgis.com/sharing/rest/content/items/${getPublicModel(id).itemId}`,
    });
    assert.deepEqual(JSON.parse(parameters.context), { extent, cellSize: 0.3, processorType: "GPU" });
    assert.deepEqual(JSON.parse(parameters.outputObjects), { serviceProperties: { name: settings.outputName } });
    assert.equal(parameters.processAllRasterItems, false);
    assert.equal(parameters.runNMS, true);
    assert.equal(parameters.confidenceScoreField, "Confidence");
    assert.equal(parameters.maxOverlapRatio, 0.1);
    assert.equal(parameters.token, undefined);
  }
});

test("uses polygon extraction for buildings, bounding boxes for cars, and the actual Text SAM arguments", () => {
  assert.deepEqual(JSON.parse(createModelAnalysisParameters("buildings", extent, settings).modelArguments), {
    threshold: 0.5, return_bboxes: "False",
  });
  assert.deepEqual(JSON.parse(createModelAnalysisParameters("cars", extent, settings).modelArguments), {
    threshold: 0.5, return_bboxes: "True",
  });
  assert.deepEqual(JSON.parse(createModelAnalysisParameters("text-sam", extent, settings).modelArguments), {
    text_prompt: "cars, buildings", box_threshold: 0.5, text_threshold: 0.25,
  });
});

test("validates thresholds, cell size, prompt, output name, and extent before a paid submission", () => {
  for (const threshold of [-0.01, 1.01, NaN, Infinity, "0.5"]) {
    assert.throws(() => createModelAnalysisParameters("cars", extent, { ...settings, threshold }), /threshold/);
  }
  for (const threshold of [0, 1]) {
    assert.equal(JSON.parse(createModelAnalysisParameters("cars", extent, { ...settings, threshold }).modelArguments).threshold, threshold);
  }
  for (const cellSize of [0, -1, 0.001, NaN, Infinity]) {
    assert.throws(() => createModelAnalysisParameters("cars", extent, { ...settings, cellSize }), /Cell size/);
  }
  assert.throws(() => createModelAnalysisParameters("text-sam", extent, { ...settings, prompt: " " }), /Text SAM/);
  assert.throws(() => createModelAnalysisParameters("cars", extent, { ...settings, outputName: "bad/name" }), /output layer name/);
  assert.throws(() => createModelAnalysisParameters("cars", {}, settings), /extent/);
});

test("parses hosted output even when GPFeatureRecordSetLayer contains a reference rather than features", () => {
  for (const value of [{ itemId, url: "https://example.com/FeatureServer" }, JSON.stringify({ itemId })]) {
    assert.deepEqual(structuredClone(getModelOutputReference({
      paramName: "outObjects", dataType: "GPFeatureRecordSetLayer", value,
    })), { itemId });
  }
  for (const result of [null, {}, { value: "invalid json" }, { value: { features: [] } }, { value: { itemId: "../other" } }]) {
    assert.throws(() => getModelOutputReference(result), /Check the server job/);
  }
});

test("accepts URL-only feature-layer and feature-service results as objects or JSON strings", () => {
  for (const url of [featureLayerUrl, `${featureLayerUrl}/`, featureLayerUrl.replace(/\/0$/, "")]) {
    for (const value of [{ url }, JSON.stringify({ url })]) {
      assert.deepEqual(structuredClone(getModelOutputReference({
        paramName: "outObjects", dataType: "GPFeatureRecordSetLayer", value,
      })), { url: url.replace(/\/$/, "") });
    }
  }
});

test("rejects malformed or unsafe output references without inventing a hosted item ID", () => {
  for (const url of [
    "", "/FeatureServer/0", "not a URL", "javascript:alert(1)",
    featureLayerUrl.replace("https:", "http:"),
    featureLayerUrl.replace("https://", "https://user:password@"),
    `${featureLayerUrl}?token=test-only-token`, `${featureLayerUrl}#fragment`,
    `${featureLayerUrl}/query`, featureLayerUrl.replace("FeatureServer", "MapServer"),
    featureLayerUrl.replace("/0", "/invalid"), {},
  ]) {
    assert.throws(() => getModelOutputReference({ value: { url } }), /Check the server job/);
  }
});

test("surfaces ArcGIS JSON errors and malformed responses rather than treating HTTP 200 as success", async () => {
  await assert.rejects(requestModelJson(async () => ({ data: { error: { code: 403, message: "Not authorized", details: ["Imagery analysis required"] } } }), taskUrl), /Not authorized/);
  await assert.rejects(requestModelJson(async () => ({ data: null }), taskUrl), /invalid response/);
});

function jobOptions(controller = new AbortController(), overrides = {}) {
  return { signal: controller.signal, onJob() {}, onProgress() {}, wait: async () => {}, ...overrides };
}

test("polls queued and executing jobs, preserves server messages, and fetches outObjects only after success", async () => {
  const calls = [];
  const progress = [];
  let jobLink;
  const responses = [
    { jobId: "j1", jobStatus: "esriJobSubmitted" },
    { jobStatus: "esriJobWaiting" },
    { jobStatus: "esriJobExecuting", messages: [{ description: "Running inference" }] },
    { jobStatus: "esriJobSucceeded" },
    { value: { itemId } },
  ];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { data: responses.shift() };
  };
  const result = await runModelJob(request, taskUrl, { inputRaster: "{}" }, jobOptions(undefined, {
    onJob: (url) => { jobLink = url; }, onProgress: (job) => progress.push(job),
  }));
  assert.equal(result.value.itemId, itemId);
  assert.equal(jobLink, `${taskUrl}/jobs/j1`);
  assert.equal(calls[0].url, `${taskUrl}/submitJob`);
  assert.equal(calls[0].options.method, "post");
  assert.equal(calls[0].options.signal, undefined);
  assert.equal(calls[0].options.query.f, "json");
  assert.equal(calls.at(-1).url, `${taskUrl}/jobs/j1/results/outObjects`);
  assert.deepEqual(progress.map((job) => job.jobStatus), [
    "esriJobSubmitted", "esriJobWaiting", "esriJobExecuting", "esriJobSucceeded",
  ]);
  assert.equal(progress[2].messages[0].description, "Running inference");
});

test("rejects terminal failed, timed-out, canceled, and deleted jobs without fetching fake results", async () => {
  for (const jobStatus of ["esriJobFailed", "esriJobTimedOut", "esriJobCancelled", "esriJobDeleted"]) {
    const calls = [];
    const request = async (url) => {
      calls.push(url);
      return { data: { jobId: "j1", jobStatus, messages: [{ description: "Model could not run" }] } };
    };
    await assert.rejects(runModelJob(request, taskUrl, {}, jobOptions()), /Model could not run/);
    assert.equal(calls.length, 1);
  }
});

test("canceling before submission does not start a paid job", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Canceled before submission"));
  await assert.rejects(runModelJob(async () => assert.fail("Must not submit"), taskUrl, {}, jobOptions(controller)), /Canceled before submission/);
});

test("canceling during submission waits for the job ID and sends server-side cancellation", async () => {
  const submitted = deferred();
  const controller = new AbortController();
  const calls = [];
  const pending = runModelJob(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/submitJob")) return submitted.promise;
    assert.ok(url.endsWith("/jobs/j1/cancel"));
    return { data: { jobStatus: "esriJobCancelled" } };
  }, taskUrl, {}, jobOptions(controller));
  controller.abort(new Error("Analysis canceled."));
  submitted.resolve({ data: { jobId: "j1", jobStatus: "esriJobSubmitted" } });
  await assert.rejects(pending, /Server cancellation confirmed/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "post");
  assert.equal(calls[1].options.signal, undefined);
});

test("waits for terminal cancellation and does not mistake a cancel request for confirmation", async () => {
  const controller = new AbortController();
  const states = ["esriJobSubmitted", "esriJobCancelling", "esriJobCancelled"];
  const delays = [];
  await assert.rejects(runModelJob(async () => ({
    data: { jobId: "j1", jobStatus: states.shift() },
  }), taskUrl, {}, jobOptions(controller, {
    onJob: () => controller.abort(new Error("Stop")),
    wait: async (delay, signal) => { delays.push(delay); assert.equal(signal, undefined); },
  })), /Server cancellation confirmed/);
  assert.deepEqual(delays, [1000]);
});

test("tries to cancel after a polling error and makes unconfirmed cancellation explicit", async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.endsWith("/submitJob")) return { data: { jobId: "j1", jobStatus: "esriJobSubmitted" } };
    if (url.endsWith("/cancel")) throw new Error("Offline");
    throw new Error("Polling failed");
  };
  await assert.rejects(runModelJob(request, taskUrl, {}, jobOptions()), /Polling failed.*cancellation could not be confirmed.*may still consume credits/);
  assert.ok(calls.at(-1).endsWith("/cancel"));
});

test("bounds cancellation confirmation polling and warns that the server might still be running", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runModelJob(async () => ({
    data: { jobId: "j1", jobStatus: ++calls === 1 ? "esriJobSubmitted" : "esriJobCancelling" },
  }), taskUrl, {}, jobOptions(controller, { onJob: () => controller.abort(new Error("Stop")) })),
  /still stopping.*may still consume credits/);
  assert.equal(calls, 12);
});

test("does not claim that a completed job was canceled or delete its saved output", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(runModelJob(async (url) => {
    calls.push(url);
    return { data: { jobId: "j1", jobStatus: "esriJobSucceeded" } };
  }, taskUrl, {}, jobOptions(controller, { onJob: () => controller.abort(new Error("Stop")) })),
  /already completed.*remains in My Content/);
  assert.equal(calls.length, 1);
});

test("ambiguous submission failure warns about possible paid work instead of automatically retrying", async () => {
  let calls = 0;
  await assert.rejects(runModelJob(async () => {
    calls++;
    throw new Error("Connection lost");
  }, taskUrl, {}, jobOptions()), /Submission could not be confirmed.*job may have started/);
  assert.equal(calls, 1);
});

test("loads the same imagery URL, full initial extent, satellite basemap, and login mechanism", async () => {
  const app = createApp();
  await app.initialize();
  const original = readFileSync(join(__dirname, "../find-objects/app.js"), "utf8");
  assert.ok(original.includes(`url: "${app.imagery.url}"`));
  assert.equal(app.view.extent, app.imagery.fullExtent);
  assert.equal(app.view.map.basemap, "satellite");
  assert.equal(app.ui["map-status"].textContent, "Map ready");
  assert.equal(app.ui["analysis-run"].disabled, true);
  await app.signIn();
  assert.equal(app.config.portalUrl, portalUrl);
  assert.equal(app.ui.login.hidden, true);
  assert.equal(app.ui.account.hidden, false);
  assert.equal(app.ui.username.textContent, "test-user");
  assert.match(app.ui["service-status"].textContent, /Raster analysis ready/);
  assert.equal(app.ui["analysis-run"].disabled, true);
});

test("explains missing credit consent rather than saying Ready while Run model is disabled", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  assert.equal(app.ui["map-status"].textContent, "Map ready");
  assert.match(app.ui["service-status"].textContent, /Raster analysis ready/);
  assert.equal(app.ui["analysis-run"].disabled, true);
  assert.match(app.ui["analysis-status"].textContent, /Authorize credit usage/);
  assert.match(app.ui["analysis-run"].title, /Authorize credit usage/);
  app.ui["credit-consent"].checked = true;
  app.ui["credit-consent"].dispatch("change");
  assert.equal(app.ui["analysis-run"].disabled, false);
  assert.equal(app.ui["analysis-status"].textContent, "Ready");
});

test("explains an out-of-imagery extent even with service access and credit consent", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  app.view.extent = { ...app.view.extent, xmin: 300, xmax: 400 };
  app.ui["credit-consent"].checked = true;
  app.ui["credit-consent"].dispatch("change");
  assert.equal(app.ui["map-status"].textContent, "Map ready");
  assert.match(app.ui["service-status"].textContent, /Raster analysis ready/);
  assert.equal(app.ui["credit-consent"].checked, true);
  assert.equal(app.ui["analysis-run"].disabled, true);
  assert.match(app.ui["analysis-status"].textContent, /Pan back to the WU Ortho imagery/);
  assert.match(app.ui["analysis-run"].title, /Pan back to the WU Ortho imagery/);
  await app.ui["analysis-form"].dispatch("submit");
  assert.match(app.ui.error.textContent, /Pan back/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 0);
});

test("runs server analysis while map tiles are loading if the extent is stationary and valid", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  app.view.updating = true;
  app.ui["credit-consent"].checked = true;
  app.watches[0].callback();
  assert.equal(app.ui["analysis-run"].disabled, false);
  assert.equal(app.ui["analysis-status"].textContent, "Ready");
  await app.run();
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 1);
  assert.match(app.ui["analysis-status"].textContent, /3 objects drawn/);
});

test("still blocks a moving map with an explicit reason and no paid submission", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  app.view.stationary = false;
  app.ui["credit-consent"].checked = true;
  app.watches[0].callback();
  assert.equal(app.ui["analysis-run"].disabled, true);
  assert.match(app.ui["analysis-status"].textContent, /map to stop moving/);
  await app.ui["analysis-form"].dispatch("submit");
  assert.match(app.ui.error.textContent, /map to stop moving/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 0);
  app.view.stationary = true;
  app.watches[0].callback();
  assert.equal(app.ui["analysis-run"].disabled, false);
});

test("preserves consent for equivalent extent objects but resets it when the bounds change", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  app.ui["credit-consent"].checked = true;
  app.ui["credit-consent"].dispatch("change");
  app.view.extent = { ...app.view.extent };
  app.watches[1].check();
  assert.equal(app.ui["credit-consent"].checked, true);
  assert.equal(app.ui["analysis-run"].disabled, false);
  app.view.extent = { ...app.view.extent, xmin: extent.xmin + 1 };
  app.watches[1].check();
  assert.equal(app.ui["credit-consent"].checked, false);
  assert.equal(app.ui["analysis-run"].disabled, true);
  assert.match(app.ui["analysis-status"].textContent, /Authorize credit usage/);
});

test("switches model defaults and Text SAM controls and resets credit consent", () => {
  const app = createApp();
  assert.equal(app.ui["analysis-threshold"].value, "0.5");
  assert.equal(app.ui["analysis-cell-size"].value, "0.3");
  assert.equal(app.ui["analysis-prompt"].disabled, true);
  app.ui["credit-consent"].checked = true;
  app.ui["analysis-model"].value = "text-sam";
  app.ui["analysis-model"].dispatch("change");
  assert.equal(app.ui["prompt-field"].hidden, false);
  assert.equal(app.ui["analysis-prompt"].required, true);
  assert.equal(app.ui["analysis-prompt"].disabled, false);
  assert.equal(app.ui["analysis-threshold"].value, "0.25");
  assert.equal(app.ui["credit-consent"].checked, false);
  app.ui["analysis-model"].value = "cars";
  app.ui["analysis-model"].dispatch("change");
  assert.equal(app.ui["analysis-cell-size"].value, "0.1");
  assert.equal(app.ui["prompt-field"].hidden, true);
  assert.equal(app.ui["analysis-prompt"].required, false);
});

test("does not submit without credit consent or with invalid model parameters", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  await app.ui["analysis-form"].dispatch("submit");
  assert.match(app.ui.error.textContent, /Authorize credit/);
  app.ui["credit-consent"].checked = true;
  app.ui["analysis-threshold"].value = "";
  await app.ui["analysis-form"].dispatch("submit");
  assert.match(app.ui.error.textContent, /threshold/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 0);
});

test("draws actual hosted output with popups, a result count, and a portal link, without recording credentials", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  await app.run();
  const layer = app.featureLayers[0];
  assert.equal(app.view.map.layers.length, 2);
  assert.equal(app.view.map.layers[1], layer);
  assert.equal(layer.portalItem.id, itemId);
  assert.equal(layer.portalItem.portal.url, portalUrl);
  assert.equal(layer.renderer.symbol.type, "simple-fill");
  assert.ok(layer.popupTemplate);
  assert.match(app.ui["analysis-status"].textContent, /3 objects drawn/);
  assert.equal(app.ui["result-list"].children.length, 1);
  assert.equal(app.ui["output-link"].href, `${portalUrl}/home/item.html?id=${itemId}`);
  assert.equal(app.ui["output-link"].hidden, false);
  assert.equal(app.ui["job-link"].href, `${taskUrl}/jobs/j123`);
  assert.equal(app.ui["credit-consent"].checked, false);
  assert.doesNotMatch(app.ui["analysis-output"].value, /test-only-credential/);
  assert.doesNotMatch(JSON.stringify(app.requests), /test-only-credential/);
  assert.equal(app.ui["analysis-form"].attributes.get("aria-busy"), "false");
});

test("draws URL-only car detection output and links directly to the returned layer", async () => {
  for (const outputValue of [{ url: featureLayerUrl }, JSON.stringify({ url: featureLayerUrl })]) {
    const app = createApp({ outputValue });
    await app.initialize();
    await app.signIn();
    app.ui["analysis-model"].value = "cars";
    app.ui["analysis-model"].dispatch("change");
    await app.run();
    assert.equal(app.ui.error.hidden, true, app.ui.error.textContent);
    const layer = app.featureLayers[0];
    assert.equal(layer.url, featureLayerUrl);
    assert.equal(layer.portalItem, undefined);
    assert.equal(layer.title, "Car Detection - USA");
    assert.equal(layer.renderer.symbol.type, "simple-fill");
    assert.ok(layer.popupTemplate);
    assert.equal(app.view.map.layers[1], layer);
    assert.match(app.ui["analysis-status"].textContent, /3 objects drawn/);
    assert.equal(app.ui["output-link"].hidden, false);
    assert.equal(app.ui["output-link"].href, featureLayerUrl);
    assert.equal(app.ui["result-list"].children[0].children[1].href, featureLayerUrl);
  }
});

test("does not advertise a nonexistent saved-output link or reuse an earlier one after invalid output", async () => {
  const options = { outputValue: { itemId } };
  const app = createApp(options);
  await app.initialize();
  await app.signIn();
  await app.run();
  const previousLayer = app.featureLayers[0];
  options.outputValue = {};
  await app.run();
  assert.match(app.ui.error.textContent, /Check the server job and My Content/);
  assert.doesNotMatch(app.ui.error.textContent, /use the saved-output link/);
  assert.equal(app.ui["output-link"].hidden, true);
  assert.equal(app.ui["job-link"].hidden, false);
  assert.equal(app.view.map.layers[1], previousLayer);
  assert.equal(previousLayer.destroyed, undefined);
});

test("treats a successful empty result as zero detections, not an error", async () => {
  const app = createApp({ count: 0 });
  await app.initialize();
  await app.signIn();
  await app.run();
  assert.equal(app.ui.error.hidden, true);
  assert.match(app.ui["analysis-status"].textContent, /0 objects drawn/);
});

test("retains different models for comparison and replaces only the rerun model on the map", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  await app.run();
  const firstBuildingLayer = app.featureLayers[0];
  app.ui["analysis-model"].value = "cars";
  app.ui["analysis-model"].dispatch("change");
  await app.run();
  app.ui["analysis-model"].value = "buildings";
  app.ui["analysis-model"].dispatch("change");
  await app.run();
  assert.equal(app.view.map.layers.length, 3);
  assert.equal(app.view.map.layers[0], app.imagery);
  assert.equal(firstBuildingLayer.destroyed, true);
  assert.equal(app.featureLayers[1].destroyed, undefined);
  assert.equal(app.ui["result-list"].children.length, 2);
  const outputNames = app.requests.filter(({ url }) => url.endsWith("/submitJob"))
    .map(({ options }) => JSON.parse(options.query.outputObjects).serviceProperties.name);
  assert.equal(new Set(outputNames).size, 3);
  assert.ok(app.requests.every(({ url }) => !url.includes("/delete")));
});

test("clearing map results and signing out never delete hosted items", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  await app.run();
  app.ui["clear-results"].dispatch("click");
  assert.equal(app.view.map.layers.length, 1);
  assert.equal(app.ui["result-list"].children.length, 0);
  assert.match(app.ui["analysis-status"].textContent, /Saved layers remain/);
  app.ui["sign-out"].dispatch("click");
  assert.equal(app.credentialClears, 1);
  assert.equal(app.ui.login.hidden, false);
  assert.equal(app.ui.account.hidden, true);
  assert.equal(app.ui["analysis-run"].disabled, true);
  assert.ok(app.requests.every(({ url }) => !url.includes("/delete")));
});

test("keeps sign-in but explains missing raster-analysis service and prevents submission", async () => {
  const app = createApp({ portal: { helperServices: {} } });
  await app.initialize();
  await app.signIn();
  assert.equal(app.ui.account.hidden, false);
  assert.match(app.ui.error.textContent, /no raster-analysis service/);
  await app.run();
  assert.match(app.ui.error.textContent, /service is unavailable/);
  assert.equal(app.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 0);
});

test("surfaces sign-in cancellation and expired credentials without starting jobs", async () => {
  const error = new Error("Canceled");
  error.name = "identity-manager:user-aborted";
  const canceled = createApp({ loginError: error });
  await canceled.initialize();
  await canceled.signIn();
  assert.equal(canceled.ui.error.textContent, "Sign-in canceled.");
  assert.equal(canceled.ui.login.hidden, false);
  const expired = createApp({ expires: Date.now() - 1000 });
  await expired.initialize();
  await expired.signIn();
  await expired.run();
  assert.match(expired.ui.error.textContent, /Sign in with ArcGIS/);
  assert.equal(expired.ui.login.hidden, false);
  assert.equal(expired.requests.filter(({ url }) => url.endsWith("/submitJob")).length, 0);
});

test("explains saved outputs when loading them fails rather than reporting inference success", async () => {
  const app = createApp({ outputError: new Error("Feature service unavailable") });
  await app.initialize();
  await app.signIn();
  await app.run();
  assert.match(app.ui.error.textContent, /Feature service unavailable.*completed output remains in My Content/);
  assert.equal(app.ui["output-link"].hidden, false);
  assert.equal(app.view.map.layers.length, 1);
  assert.equal(app.featureLayers[0].destroyed, true);
  assert.match(app.ui["analysis-status"].textContent, /Analysis failed/);
  assert.match(app.ui["analysis-status"].textContent, /Authorize credit usage/);
});

test("keeps a valid URL-only output link available if loading the layer fails", async () => {
  const app = createApp({
    outputValue: { url: featureLayerUrl }, outputError: new Error("Feature service unavailable"),
  });
  await app.initialize();
  await app.signIn();
  await app.run();
  assert.match(app.ui.error.textContent, /Feature service unavailable.*use the saved-output link/);
  assert.equal(app.ui["output-link"].hidden, false);
  assert.equal(app.ui["output-link"].href, featureLayerUrl);
  assert.equal(app.view.map.layers.length, 1);
  assert.equal(app.featureLayers[0].destroyed, true);
});

test("resets consent when the map extent or model arguments change", async () => {
  const app = createApp();
  await app.initialize();
  await app.signIn();
  app.ui["credit-consent"].checked = true;
  app.watches[1].callback();
  assert.equal(app.ui["credit-consent"].checked, false);
  app.ui["credit-consent"].checked = true;
  app.ui["analysis-cell-size"].dispatch("input");
  assert.equal(app.ui["credit-consent"].checked, false);
});

test("blocks navigation while a job is active and handles closing during output loading", async () => {
  const loading = deferred();
  const started = deferred();
  const app = createApp({ loadOutput: () => { started.resolve(); return loading.promise; } });
  await app.initialize();
  await app.signIn();
  const pending = app.run();
  await started.promise;
  assert.equal(app.ui["sign-out"].disabled, true);
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  app.windowEvents.get("beforeunload")(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");
  app.windowEvents.get("pagehide")({ persisted: false });
  loading.resolve();
  await pending;
  assert.equal(app.view.destroyed, true);
  assert.equal(app.featureLayers[0].destroyed, true);
});

test("reports map load failure and keeps model execution unavailable", async () => {
  const app = createApp({ imageryError: new Error("Source imagery unavailable") });
  await app.initialize();
  assert.equal(app.ui["map-status"].textContent, "Map unavailable");
  assert.match(app.ui.error.textContent, /Source imagery unavailable/);
  assert.equal(app.ui["analysis-run"].disabled, true);
});

test("adds home navigation and documents credit usage, output persistence, and the private GeoVLM beta", () => {
  const home = readFileSync(join(__dirname, "../../index.html"), "utf8");
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  assert.match(home, /href="apps\/deep-learning\/index.html"/);
  assert.match(html, /consumes credits/);
  assert.match(html, /does not delete saved layers/);
  assert.match(html, /GeoVLM[\s\S]*private beta/);
  assert.match(html, /value="https:\/\/excalibur\.mapsdevext\.arcgis\.com"/);
});
