"use strict";

const MODEL_IMAGERY_URL = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Oblique/WU_Ortho/ImageServer";
const PUBLIC_MODELS = [
  {
    id: "buildings", name: "Building Footprint Extraction - USA",
    itemId: "a6857359a1cd44839781a4f113cd5934", threshold: 0.5, cellSize: 0.3, color: [0, 166, 133],
    description: "Extracts building polygons from US orthorectified RGB imagery. Recommended resolution: 10-40 cm. Footprints are model predictions, not surveyed or regularized boundaries.",
  },
  {
    id: "cars", name: "Car Detection - USA",
    itemId: "cfc57b507f914d1593f5871bf0d52999", threshold: 0.5, cellSize: 0.1, color: [255, 208, 0],
    description: "Detects cars in high-resolution US imagery and returns bounding boxes. Recommended resolution: 5-20 cm.",
  },
  {
    id: "text-sam", name: "Text SAM",
    itemId: "8df3bf4167bc4c7b967f677f8b362ec3", threshold: 0.25, cellSize: 0.3, color: [220, 92, 207],
    description: "Grounding DINO and Segment Anything extract object polygons from text prompts. Confidence controls the box threshold; text association uses 0.25. Adjust cell size for the objects of interest.",
  },
];

function getPublicModel(id) {
  const model = PUBLIC_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error("Select one of the available public Esri models.");
  return model;
}

function normalizeModelPortalUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error("Enter an HTTPS portal URL without credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/sharing(?:\/rest)?\/?$/i, "").replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function getRasterAnalysisTaskUrl(portal) {
  const service = portal?.helperServices?.rasterAnalytics?.url;
  if (!service) {
    throw new Error("This portal has no raster-analysis service. Sign out and choose an ArcGIS Online organization with imagery analysis enabled.");
  }
  const url = normalizeModelPortalUrl(service);
  if (!/\/GPServer$/i.test(url)) throw new Error("The portal returned an unsupported raster-analysis service URL.");
  return `${url}/DetectObjectsUsingDeepLearning`;
}

function getModelAnalysisExtent(extent, imageryExtent) {
  for (const candidate of [extent, imageryExtent]) {
    const wkid = candidate?.spatialReference?.latestWkid || candidate?.spatialReference?.wkid;
    if (![3857, 102100, 102113].includes(wkid)
      || !["xmin", "ymin", "xmax", "ymax"].every((key) => Number.isFinite(candidate[key]))
      || candidate.xmin >= candidate.xmax || candidate.ymin >= candidate.ymax) {
      throw new Error("The analysis requires a valid Web Mercator map extent.");
    }
  }
  const clipped = {
    xmin: Math.max(extent.xmin, imageryExtent.xmin), ymin: Math.max(extent.ymin, imageryExtent.ymin),
    xmax: Math.min(extent.xmax, imageryExtent.xmax), ymax: Math.min(extent.ymax, imageryExtent.ymax),
    spatialReference: { wkid: 3857 },
  };
  if (clipped.xmin >= clipped.xmax || clipped.ymin >= clipped.ymax) {
    throw new Error("Pan back to the WU Ortho imagery before running a model.");
  }
  return clipped;
}

function createModelAnalysisParameters(modelId, extent, { threshold, cellSize, prompt, outputName }) {
  const model = getPublicModel(modelId);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Confidence threshold must be between 0 and 1.");
  }
  if (!Number.isFinite(cellSize) || cellSize < 0.01) {
    throw new Error("Cell size must be at least 0.01 map meters.");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(outputName || "")) throw new Error("The output layer name is invalid.");
  if (modelId === "text-sam" && !prompt?.trim()) throw new Error("Enter the objects Text SAM should segment.");
  const modelArguments = modelId === "text-sam"
    ? { text_prompt: prompt.trim(), box_threshold: threshold, text_threshold: 0.25 }
    : { threshold, return_bboxes: modelId === "cars" ? "True" : "False" };
  return {
    inputRaster: JSON.stringify({ url: MODEL_IMAGERY_URL }),
    model: JSON.stringify({ url: `https://www.arcgis.com/sharing/rest/content/items/${model.itemId}` }),
    modelArguments: JSON.stringify(modelArguments),
    outputObjects: JSON.stringify({ serviceProperties: { name: outputName } }),
    runNMS: true,
    confidenceScoreField: "Confidence",
    maxOverlapRatio: 0.1,
    processAllRasterItems: false,
    context: JSON.stringify({ extent: getModelAnalysisExtent(extent, extent), cellSize, processorType: "GPU" }),
  };
}

function getModelOutputReference(result) {
  let value = result?.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("The job returned invalid output JSON. Check the server job and My Content before retrying.");
    }
  }
  if (typeof value?.itemId === "string" && /^[a-f0-9]{32}$/i.test(value.itemId)) {
    return { itemId: value.itemId };
  }
  try {
    const url = new URL(value?.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !/\/FeatureServer(?:\/\d+)?\/?$/i.test(url.pathname)) {
      throw new Error();
    }
    return { url: url.href.replace(/\/$/, "") };
  } catch {
    throw new Error("The job did not return a valid hosted item ID or HTTPS feature-layer URL. Check the server job and My Content before retrying.");
  }
}

function modelErrorMessage(error) {
  const details = error?.details?.messages || error?.details;
  const messages = Array.isArray(details) ? details.filter((value) => typeof value === "string") : [];
  return [...new Set([error?.message || String(error), ...messages])].join(" ");
}

async function requestModelJson(request, url, query = {}, options = {}) {
  const response = await request(url, {
    query: { ...query, f: "json" }, responseType: "json", timeout: 60_000, ...options,
  });
  const data = response?.data;
  if (!data || typeof data !== "object") throw new Error("ArcGIS returned an invalid response.");
  if (data.error) {
    const error = new Error(data.error.message || "ArcGIS rejected the request.");
    error.details = data.error.details;
    error.code = data.error.code;
    throw error;
  }
  return data;
}

function waitForModelJob(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function runModelJob(request, taskUrl, parameters, {
  signal, onJob, onProgress, wait = waitForModelJob,
}) {
  const terminal = new Set(["esriJobSucceeded", "esriJobFailed", "esriJobCancelled", "esriJobTimedOut", "esriJobDeleted"]);
  const statuses = new Set([...terminal, "esriJobNew", "esriJobSubmitted", "esriJobWaiting", "esriJobExecuting", "esriJobCancelling"]);
  let job;
  let jobUrl = "";
  let submitting = false;
  const report = (data) => {
    if (!statuses.has(data.jobStatus)) throw new Error("ArcGIS returned an unknown job status.");
    job = data;
    onProgress(data);
  };
  try {
    signal.throwIfAborted();
    submitting = true;
    // Keep submission alive so cancellation can still obtain and stop the server job.
    const submitted = await requestModelJson(request, `${taskUrl}/submitJob`, parameters, { method: "post" });
    if (!/^[a-zA-Z0-9_-]+$/.test(submitted.jobId || "")) throw new Error("ArcGIS did not return a job ID.");
    jobUrl = `${taskUrl}/jobs/${submitted.jobId}`;
    onJob(jobUrl);
    report(submitted);
    while (!terminal.has(job.jobStatus)) {
      signal.throwIfAborted();
      await wait(3000, signal);
      report(await requestModelJson(request, jobUrl, {}, { signal, cacheBust: true }));
    }
    if (job.jobStatus !== "esriJobSucceeded") {
      const messages = (job.messages || []).map((message) => message.description).filter(Boolean).join(" ");
      throw new Error(`Analysis ended with ${job.jobStatus}. ${messages}`.trim());
    }
    signal.throwIfAborted();
    return await requestModelJson(request, `${jobUrl}/results/outObjects`, {}, { signal });
  } catch (error) {
    let cleanup = "";
    if (jobUrl && !terminal.has(job?.jobStatus)) {
      try {
        report(await requestModelJson(request, `${jobUrl}/cancel`, {}, { method: "post" }));
        for (let attempt = 0; !terminal.has(job.jobStatus) && attempt < 10; attempt++) {
          await wait(1000);
          report(await requestModelJson(request, jobUrl, {}, { timeout: 15_000, cacheBust: true }));
        }
        if (!terminal.has(job.jobStatus)) throw new Error("The server is still stopping the job.");
        cleanup = job.jobStatus === "esriJobCancelled" ? " Server cancellation confirmed."
          : ` The server ended with ${job.jobStatus}; check My Content for any saved output.`;
      } catch (cancelError) {
        cleanup = ` Server cancellation could not be confirmed: ${modelErrorMessage(cancelError)} The job may still consume credits. Check the job-status link before retrying.`;
      }
    } else if (job?.jobStatus === "esriJobSucceeded") {
      cleanup = " The server already completed the job; its output remains in My Content.";
    } else if (submitting && !jobUrl) {
      cleanup = " Submission could not be confirmed; a job may have started. Check your portal's analysis history and My Content before retrying.";
    }
    const failure = new Error(`${modelErrorMessage(error)}${cleanup}`);
    failure.name = signal.aborted ? "AbortError" : "Error";
    throw failure;
  }
}

(() => {
  const ui = Object.fromEntries([
    "map-view", "map-status", "login", "login-status", "portal-url", "sign-in-form",
    "sign-in", "account", "username", "sign-out", "service-status", "analysis-form",
    "analysis-model", "model-description", "model-link", "prompt-field", "analysis-prompt",
    "analysis-threshold", "analysis-cell-size", "extent-info", "credit-consent",
    "analysis-run", "analysis-cancel", "analysis-status", "analysis-output", "job-link",
    "output-link", "clear-results", "result-list", "error",
  ].map((id) => [id, document.getElementById(id)]));
  const results = new Map();
  let view;
  let imageryLayer;
  let identityManager;
  let sdkConfig;
  let sdkRequest;
  let FeatureLayer;
  let credential = null;
  let portalUrl = "";
  let taskUrl = "";
  let signingIn = false;
  let mapState = "loading";
  let activeRun = null;
  let lastStatus = "";
  let closed = false;
  let loadTimeout;

  function showError(message = "") {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function analysisExtent() {
    return getModelAnalysisExtent(view.extent.toJSON(), imageryLayer.fullExtent.toJSON());
  }

  function update() {
    const busy = Boolean(activeRun);
    const ready = mapState === "ready";
    const drawing = ready && (view.updating || !view.stationary);
    let extentError = "";
    if (ready) {
      try {
        const extent = activeRun?.extent || analysisExtent();
        const cellSize = activeRun?.cellSize || Number(ui["analysis-cell-size"].value);
        const pixels = Math.ceil((extent.xmax - extent.xmin) / cellSize) * Math.ceil((extent.ymax - extent.ymin) / cellSize);
        ui["extent-info"].textContent = Number.isFinite(pixels) && cellSize >= 0.01
          ? `${busy ? "Submitted" : "Current"} area: approximately ${(pixels / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} million pixels at ${cellSize} map meters. This is not a credit estimate.`
          : "Enter a valid cell size to see the processing area.";
      } catch (error) {
        extentError = modelErrorMessage(error);
        ui["extent-info"].textContent = extentError;
      }
    }
    ui["map-status"].textContent = mapState === "error" ? "Map unavailable"
      : !ready ? "Loading map..." : drawing ? "Updating map..." : "Map ready";
    const blockingReason = busy ? "Wait for the current analysis to finish or cancel it."
      : signingIn ? (credential ? "Checking raster-analysis access..." : "Signing in...")
      : !credential ? "Sign in required"
      : !taskUrl ? "Raster analysis unavailable"
      : mapState === "error" ? "Map unavailable. Reload the page before running a model."
      : !ready ? "Waiting for map"
      : !view.stationary ? "Wait for the map to stop moving."
      : extentError || (!ui["credit-consent"].checked ? "Authorize credit usage and hosted output for this run." : "");
    ui["analysis-run"].disabled = Boolean(blockingReason);
    ui["analysis-run"].title = blockingReason || "Run the selected model on the current analysis extent";
    for (const id of ["analysis-model", "analysis-threshold", "analysis-cell-size", "credit-consent"]) ui[id].disabled = busy;
    ui["analysis-prompt"].disabled = busy || ui["analysis-model"].value !== "text-sam";
    ui["analysis-cancel"].hidden = !busy;
    ui["analysis-cancel"].disabled = Boolean(activeRun?.controller.signal.aborted);
    ui["sign-out"].disabled = busy || signingIn;
    ui["sign-out"].title = busy ? "Cancel or finish the job before signing out" : "Sign out";
    ui["clear-results"].disabled = busy || !results.size;
    ui["analysis-form"].setAttribute("aria-busy", String(busy));
    ui["analysis-output"].setAttribute("aria-busy", String(busy));
    ui["analysis-status"].textContent = busy ? activeRun.status
      : [lastStatus, blockingReason || (!lastStatus ? "Ready" : "")].filter(Boolean).join(" | ");
  }

  function renderResults() {
    ui["result-list"].replaceChildren(...Array.from(results.values(), ({ model, count, outputUrl }) => {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "result-swatch";
      swatch.style.backgroundColor = `rgb(${model.color.join(",")})`;
      swatch.setAttribute("aria-hidden", "true");
      const link = document.createElement("a");
      link.href = outputUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `${model.name}: ${count.toLocaleString()} objects`;
      item.append(swatch, link);
      return item;
    }));
  }

  function clearResults() {
    for (const { layer } of results.values()) {
      view?.map?.remove(layer);
      layer.destroy();
    }
    results.clear();
    renderResults();
    ui["analysis-output"].value = "";
    ui["job-link"].hidden = true;
    ui["output-link"].hidden = true;
  }

  function clearCredential() {
    credential = null;
    taskUrl = "";
    identityManager?.destroyCredentials();
    ui.login.hidden = false;
    ui.account.hidden = true;
    ui.username.textContent = "";
    ui["service-status"].textContent = "Sign in to discover your portal's raster-analysis service.";
    ui["credit-consent"].checked = false;
    clearResults();
    lastStatus = "";
  }

  ui["sign-in-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!identityManager || signingIn || activeRun) return;
    showError();
    try {
      portalUrl = normalizeModelPortalUrl(ui["portal-url"].value);
    } catch (error) {
      showError(modelErrorMessage(error));
      return;
    }
    signingIn = true;
    ui["portal-url"].value = portalUrl;
    ui["sign-in"].disabled = true;
    ui["portal-url"].disabled = true;
    ui["login-status"].textContent = "Signing in...";
    update();
    try {
      sdkConfig.portalUrl = portalUrl;
      const signedIn = await identityManager.getCredential(`${portalUrl}/sharing`);
      if (closed) return;
      if (!signedIn?.token) throw new Error("Sign-in did not return an ArcGIS credential.");
      credential = signedIn;
      ui.username.textContent = credential.userId || "Signed in";
      ui.login.hidden = true;
      ui.account.hidden = false;
      ui["service-status"].textContent = "Checking raster-analysis access...";
      update();
      const portal = await requestModelJson(sdkRequest, `${portalUrl}/sharing/rest/portals/self`);
      const candidateUrl = getRasterAnalysisTaskUrl(portal);
      const task = await requestModelJson(sdkRequest, candidateUrl);
      if (closed) return;
      const names = new Set(task.parameters?.map((parameter) => parameter.name));
      if (!["inputRaster", "model", "outputObjects", "outObjects"].every((name) => names.has(name))) {
        throw new Error("This service does not expose the expected Detect Objects Using Deep Learning parameters.");
      }
      taskUrl = candidateUrl;
      ui["service-status"].textContent = `Raster analysis ready: ${new URL(taskUrl).host}`;
      ui["analysis-model"].focus();
    } catch (error) {
      if (!credential) clearCredential();
      else ui["service-status"].textContent = "Raster analysis unavailable. Check your privileges, or sign out to choose another portal.";
      showError(error.name === "identity-manager:user-aborted" ? "Sign-in canceled." : modelErrorMessage(error));
    } finally {
      signingIn = false;
      ui["sign-in"].disabled = false;
      ui["portal-url"].disabled = false;
      ui["login-status"].textContent = "";
      update();
    }
  });

  ui["sign-out"].addEventListener("click", () => {
    if (activeRun || signingIn) return;
    clearCredential();
    showError();
    update();
  });

  ui["analysis-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (activeRun || signingIn) return;
    showError();
    let parameters;
    let run;
    try {
      if (!credential?.token || (credential.expires && credential.expires <= Date.now() + 30_000)) {
        clearCredential();
        throw new Error("Sign in with ArcGIS to run a model.");
      }
      if (!taskUrl) throw new Error("Your portal's raster-analysis service is unavailable.");
      if (mapState !== "ready") throw new Error("Wait for the map to load.");
      if (!view.stationary) throw new Error("Wait for the map to stop moving.");
      const model = getPublicModel(ui["analysis-model"].value);
      const extent = analysisExtent();
      if (!ui["credit-consent"].checked) throw new Error("Authorize credit usage and hosted output before running.");
      const cellSize = Number(ui["analysis-cell-size"].value);
      const outputName = `AI_${model.id.replaceAll("-", "_")}_${crypto.randomUUID().replaceAll("-", "")}`;
      parameters = createModelAnalysisParameters(model.id, extent, {
        threshold: ui["analysis-threshold"].valueAsNumber, cellSize,
        prompt: ui["analysis-prompt"].value, outputName,
      });
      run = {
        model, extent, cellSize, controller: new AbortController(), status: "Submitting server job...",
        details: { model: model.name, modelItemId: model.itemId, outputName, parameters },
      };
    } catch (error) {
      showError(modelErrorMessage(error));
      update();
      return;
    }
    activeRun = run;
    lastStatus = "";
    ui["job-link"].hidden = true;
    ui["output-link"].hidden = true;
    const showDetails = () => { ui["analysis-output"].value = JSON.stringify(run.details, null, 2); };
    const timeout = setTimeout(() => run.controller.abort(new Error("Analysis timed out after 30 minutes.")), 30 * 60_000);
    let resultLayer;
    let added = false;
    showDetails();
    update();
    try {
      const output = await runModelJob(sdkRequest, taskUrl, parameters, {
        signal: run.controller.signal,
        onJob: (url) => {
          ui["job-link"].href = url;
          ui["job-link"].hidden = false;
          run.details.jobUrl = url;
        },
        onProgress: (job) => {
          run.status = `${run.model.name}: ${job.jobStatus.replace("esriJob", "")}`;
          run.details.jobStatus = job.jobStatus;
          run.details.messages = job.messages || [];
          showDetails();
          update();
        },
      });
      run.controller.signal.throwIfAborted();
      run.details.output = output;
      showDetails();
      const reference = getModelOutputReference(output);
      const outputUrl = reference.itemId ? `${portalUrl}/home/item.html?id=${reference.itemId}` : reference.url;
      ui["output-link"].href = outputUrl;
      ui["output-link"].hidden = false;
      run.status = "Loading the saved feature layer...";
      update();
      resultLayer = new FeatureLayer({
        ...(reference.itemId
          ? { portalItem: { id: reference.itemId, portal: { url: portalUrl } } }
          : { url: reference.url }),
        title: run.model.name, outFields: ["*"],
        renderer: {
          type: "simple",
          symbol: { type: "simple-fill", color: [...run.model.color, 0.12], outline: { color: run.model.color, width: 2 } },
        },
      });
      await resultLayer.load({ signal: run.controller.signal });
      if (resultLayer.geometryType !== "polygon") throw new Error("The saved layer does not contain the expected polygons. Open the saved output to inspect it.");
      resultLayer.popupTemplate = resultLayer.createPopupTemplate();
      const count = await resultLayer.queryFeatureCount({ where: "1=1" }, { signal: run.controller.signal });
      if (!Number.isInteger(count) || count < 0) throw new Error("Could not read the number of detected objects.");
      run.controller.signal.throwIfAborted();
      view.map.add(resultLayer);
      await view.whenLayerView(resultLayer);
      run.controller.signal.throwIfAborted();
      const previous = results.get(run.model.id);
      if (previous) {
        view.map.remove(previous.layer);
        previous.layer.destroy();
      }
      results.set(run.model.id, { model: run.model, layer: resultLayer, count, outputUrl });
      added = true;
      renderResults();
      lastStatus = `${run.model.name}: ${count.toLocaleString()} objects drawn. Output saved to My Content.`;
      run.details.featureCount = count;
      showDetails();
    } catch (error) {
      lastStatus = run.controller.signal.aborted ? "Analysis stopped" : "Analysis failed";
      const recovery = run.details.output && !ui["output-link"].hidden
        ? " The completed output remains in My Content; use the saved-output link." : "";
      showError(`${modelErrorMessage(error)}${recovery}`);
    } finally {
      if (resultLayer && !added) {
        view?.map?.remove(resultLayer);
        resultLayer.destroy();
      }
      clearTimeout(timeout);
      activeRun = null;
      ui["credit-consent"].checked = false;
      update();
    }
  });

  function updateModel() {
    const model = getPublicModel(ui["analysis-model"].value);
    ui["model-description"].textContent = model.description;
    ui["model-link"].href = `https://www.arcgis.com/home/item.html?id=${model.itemId}`;
    ui["analysis-threshold"].value = String(model.threshold);
    ui["analysis-cell-size"].value = String(model.cellSize);
    ui["prompt-field"].hidden = model.id !== "text-sam";
    ui["analysis-prompt"].required = model.id === "text-sam";
    ui["credit-consent"].checked = false;
    lastStatus = "";
    update();
  }

  ui["analysis-model"].addEventListener("change", updateModel);
  for (const id of ["analysis-threshold", "analysis-cell-size", "analysis-prompt"]) {
    ui[id].addEventListener("input", () => {
      ui["credit-consent"].checked = false;
      update();
    });
  }
  ui["credit-consent"].addEventListener("change", update);
  ui["analysis-cancel"].addEventListener("click", () => {
    activeRun?.controller.abort(new Error("Analysis canceled."));
    if (activeRun) activeRun.status = "Requesting server cancellation...";
    update();
  });
  ui["clear-results"].addEventListener("click", () => {
    if (activeRun) return;
    clearResults();
    lastStatus = "Map results cleared. Saved layers remain in My Content.";
    update();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!activeRun) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", (event) => {
    activeRun?.controller.abort(new Error("Page closed; stopping analysis."));
    if (!event.persisted) {
      closed = true;
      clearTimeout(loadTimeout);
      view?.destroy();
    }
  });

  function mapUnavailable(error) {
    clearTimeout(loadTimeout);
    mapState = "error";
    activeRun?.controller.abort(new Error("Map unavailable; stopping analysis."));
    view?.destroy();
    if (!identityManager) ui["login-status"].textContent = "ArcGIS is unavailable.";
    showError(`Could not load the map. Check your connection and WebGL support, then reload the page.${error?.message ? ` ${error.message}` : ""}`);
    update();
  }

  window.lucide?.createIcons();
  updateModel();
  if (typeof window.require !== "function") {
    mapUnavailable();
    return;
  }
  loadTimeout = setTimeout(mapUnavailable, 30_000);
  window.require([
    "esri/Map", "esri/views/MapView", "esri/layers/ImageryLayer", "esri/identity/IdentityManager", "esri/config",
    "esri/core/reactiveUtils", "esri/widgets/LayerList", "esri/widgets/Expand", "esri/layers/FeatureLayer", "esri/request",
  ], async (ArcGISMap, MapView, ImageryLayer, manager, config, reactiveUtils, LayerList, Expand, FeatureLayerConstructor, request) => {
    if (closed || mapState === "error") return;
    identityManager = manager;
    sdkConfig = config;
    sdkRequest = request;
    FeatureLayer = FeatureLayerConstructor;
    ui["sign-in"].disabled = false;
    ui["login-status"].textContent = "";
    try {
      imageryLayer = new ImageryLayer({ url: MODEL_IMAGERY_URL });
      await imageryLayer.load();
      if (closed || mapState === "error") return;
      view = new MapView({
        container: ui["map-view"],
        map: new ArcGISMap({ basemap: "streets", layers: [imageryLayer] }),
        extent: imageryLayer.fullExtent,
      });
      await view.when();
      if (closed || mapState === "error") return;
      view.ui.add(new Expand({
        view, content: new LayerList({ view }), expandIcon: "layers",
        expandTooltip: "Layers", collapseTooltip: "Hide layers",
      }), "top-right");
      clearTimeout(loadTimeout);
      mapState = "ready";
      view.addHandles(reactiveUtils.watch(
        () => [view.updating, view.stationary, view.fatalError],
        () => view.fatalError ? mapUnavailable(view.fatalError) : update(),
      ));
      view.addHandles(reactiveUtils.watch(() => [
        view.extent?.xmin, view.extent?.ymin, view.extent?.xmax, view.extent?.ymax,
      ], () => {
        ui["credit-consent"].checked = false;
        update();
      }));
      update();
    } catch (error) {
      mapUnavailable(error);
    }
  }, mapUnavailable);
})();
