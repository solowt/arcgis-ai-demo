"use strict";

function createSearchRegions(width, height, gridSize) {
  if (![3, 4, 6].includes(gridSize) || !Number.isInteger(width) || !Number.isInteger(height)
    || width < gridSize || height < gridSize) {
    throw new Error("The captured image is too small for the selected grid.");
  }
  return Array.from({ length: gridSize * gridSize }, (_, index) => {
    const row = Math.floor(index / gridSize);
    const column = index % gridSize;
    const xmin = Math.floor(column * width / gridSize);
    const ymin = Math.floor(row * height / gridSize);
    const xmax = Math.floor((column + 1) * width / gridSize);
    const ymax = Math.floor((row + 1) * height / gridSize);
    const paddingX = Math.ceil((xmax - xmin) * 0.2);
    const paddingY = Math.ceil((ymax - ymin) * 0.2);
    const cropLeft = Math.max(0, xmin - paddingX);
    const cropTop = Math.max(0, ymin - paddingY);
    return {
      id: `${String.fromCharCode(65 + row)}${column + 1}`,
      xmin, ymin, xmax, ymax,
      crop: {
        x: cropLeft, y: cropTop,
        width: Math.min(width, xmax + paddingX) - cropLeft,
        height: Math.min(height, ymax + paddingY) - cropTop,
      },
    };
  });
}

function createRegionImage(imageData, region, outline = true) {
  const canvas = document.createElement("canvas");
  const { crop } = region;
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  context.putImageData(imageData, -crop.x, -crop.y, crop.x, crop.y, crop.width, crop.height);
  if (outline) {
    context.strokeStyle = "#ffd000";
    context.lineWidth = 2;
    context.strokeRect(region.xmin - crop.x, region.ymin - crop.y, region.xmax - region.xmin, region.ymax - region.ymin);
  }
  return canvas.toDataURL("image/png");
}

function createAppearancePrompt(description, region) {
  return `Evaluate region ${JSON.stringify(region.id)} for this visual description: ${JSON.stringify(description.trim())}. `
    + 'The yellow rectangle marks the region being evaluated; imagery outside it is context only. '
    + 'Use "match" when the requested appearance is visibly present within the rectangle. '
    + 'For descriptions involving surroundings, consider the nearby context, but do not match solely on something outside the rectangle. '
    + 'Use "no_match" when the region clearly does not match, and "uncertain" when detail, shadows, or ambiguity prevent a decision. '
    + 'Base the decision only on visible evidence; do not infer ownership, legality, hidden conditions, or precise measurements. '
    + 'Return a brief evidence description and no coordinates. Return only JSON in this format: '
    + `{"id":${JSON.stringify(region.id)},"status":"match","evidence":"Brief visible evidence"}.`;
}

function parseAppearanceResult(value, region) {
  if (typeof value === "string") {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    try {
      value = JSON.parse(fenced ? fenced[1] : value.trim());
    } catch {
      throw new Error(`Region ${region.id}: the service did not return valid JSON.`);
    }
  }
  if (value?.id !== region.id || !["match", "no_match", "uncertain"].includes(value.status)
    || typeof value.evidence !== "string" || !value.evidence.trim()) {
    throw new Error(`Region ${region.id}: expected its ID, a match status, and visible evidence.`);
  }
  return { status: value.status, evidence: value.evidence.trim() };
}

function regionToMapPolygon(region, capture) {
  const toMap = (pixelX, pixelY) => [
    capture.topLeft.x + (capture.topRight.x - capture.topLeft.x) * pixelX / capture.width
      + (capture.bottomLeft.x - capture.topLeft.x) * pixelY / capture.height,
    capture.topLeft.y + (capture.topRight.y - capture.topLeft.y) * pixelX / capture.width
      + (capture.bottomLeft.y - capture.topLeft.y) * pixelY / capture.height,
  ];
  return {
    type: "polygon",
    spatialReference: capture.spatialReference,
    rings: [[
      toMap(region.xmin, region.ymin), toMap(region.xmax, region.ymin),
      toMap(region.xmax, region.ymax), toMap(region.xmin, region.ymax), toMap(region.xmin, region.ymin),
    ]],
  };
}

function filterAppearanceResults(regions, filter) {
  const order = { match: 0, uncertain: 1, no_match: 2 };
  return regions.filter((region) => filter === "all" || region.status === filter)
    .sort((first, second) => order[first.status] - order[second.status] || first.id.localeCompare(second.id));
}

(() => {
  const ui = Object.fromEntries([
    "map-view", "map-status", "login", "login-status", "portal-url", "sign-in-form", "sign-in",
    "account", "username", "sign-out", "error", "search-form", "search-query", "grid-size",
    "search-sequential",
    "search-run", "search-cancel", "search-status", "results", "results-filter", "results-summary",
    "results-query", "results-list", "results-empty", "result-template", "return-area", "clear-results", "raw-output",
  ].map((id) => [id, document.getElementById(id)]));
  const labels = { match: "Match", uncertain: "Uncertain", no_match: "No match" };
  const colors = { match: [0, 119, 107], uncertain: [190, 111, 0], no_match: [98, 111, 119] };
  let view;
  let Graphic;
  let identityManager;
  let sdkConfig;
  let credential = null;
  let mapState = "loading";
  let pendingRequest = null;
  let searchResult = null;
  let selectedRegion = null;
  let regionGraphics = [];
  let displayGraphics = [];
  let requestStatus = "";
  let lastStatus = "";
  let loadTimeout;
  let closed = false;

  function showError(message = "") {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function update() {
    const busy = Boolean(pendingRequest);
    const ready = mapState === "ready";
    const drawing = ready && (view.updating || !view.stationary);
    ui["map-status"].textContent = mapState === "error" ? "Map unavailable"
      : !ready ? "Loading map..." : drawing ? "Updating map..." : "Map ready";
    ui["search-run"].disabled = busy || !ready || drawing || !credential || !ui["search-query"].value.trim();
    ui["search-query"].disabled = busy;
    ui["grid-size"].disabled = busy;
    ui["search-sequential"].disabled = busy;
    ui["search-cancel"].hidden = !busy;
    ui["search-form"].setAttribute("aria-busy", String(busy));
    ui.results.setAttribute("aria-busy", String(busy));
    ui["results-filter"].disabled = busy || !searchResult;
    ui["return-area"].disabled = busy || !searchResult || !ready;
    ui["clear-results"].disabled = busy || !searchResult;
    ui["results-list"].querySelectorAll("button").forEach((button) => { button.disabled = busy || !ready; });
    ui["search-status"].textContent = busy ? requestStatus : !credential ? "Sign in required"
      : lastStatus || (ready && !drawing ? "Ready" : "Waiting for map");
  }

  function markSelection() {
    ui["results-list"].querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.regionId === selectedRegion));
    });
  }

  async function selectRegion(id, navigate = true) {
    if (pendingRequest || !searchResult || mapState !== "ready") return;
    const result = searchResult;
    const graphic = regionGraphics.find((item) => item.attributes.regionId === id);
    if (!graphic) return;
    selectedRegion = id;
    markSelection();
    if (!navigate) {
      const button = [...ui["results-list"].querySelectorAll("button")].find((item) => item.dataset.regionId === id);
      if (button && window.matchMedia("(min-width: 761px)").matches) button.scrollIntoView({ block: "nearest" });
      return;
    }
    try {
      if (window.matchMedia("(max-width: 760px)").matches) ui["map-view"].scrollIntoView({ block: "start" });
      await view.goTo({ target: graphic.geometry.extent.expand(1.6), rotation: result.capture.rotation }, { animate: false });
      if (searchResult === result && selectedRegion === id && !pendingRequest) {
        view.openPopup({ features: [graphic], location: graphic.geometry.extent.center });
      }
    } catch (error) {
      if (error.name !== "AbortError") showError("Could not navigate to this region.");
    }
  }

  function renderResults() {
    view?.closePopup();
    view?.graphics?.removeMany(displayGraphics);
    displayGraphics = [];
    regionGraphics = [];
    selectedRegion = null;
    ui["results-list"].replaceChildren();
    ui["results-query"].textContent = searchResult?.description || "";
    if (!searchResult) {
      ui["results-summary"].textContent = "";
      ui["results-empty"].textContent = "No search results";
      ui["results-empty"].hidden = false;
      return;
    }
    const result = searchResult;
    const count = (status) => result.regions.filter((region) => region.status === status).length;
    ui["results-summary"].textContent = `${count("match")} matches, ${count("uncertain")} uncertain, ${count("no_match")} no match`;
    const visible = filterAppearanceResults(result.regions, ui["results-filter"].value);
    ui["results-empty"].hidden = visible.length > 0;
    ui["results-empty"].textContent = "No regions in this filter";
    for (const region of visible) {
      const graphic = new Graphic({
        geometry: regionToMapPolygon(region, result.capture),
        attributes: { regionId: region.id, status: region.status, evidence: region.evidence },
        symbol: {
          type: "simple-fill", color: [...colors[region.status], 0.12],
          outline: { color: colors[region.status], width: 2, style: region.status === "uncertain" ? "dash" : "solid" },
        },
        popupTemplate: {
          title: "Region {regionId}",
          content: () => {
            const content = document.createElement("p");
            content.textContent = `${labels[region.status]}: ${region.evidence}`;
            return content;
          },
        },
      });
      regionGraphics.push(graphic);
      displayGraphics.push(graphic, new Graphic({
        geometry: graphic.geometry.extent.center,
        attributes: graphic.attributes,
        popupTemplate: graphic.popupTemplate,
        symbol: { type: "text", text: region.id, color: "#20282b", haloColor: "#ffffff", haloSize: 1.5, font: { size: 11, weight: "bold" } },
      }));
      const item = ui["result-template"].content.firstElementChild.cloneNode(true);
      const button = item.querySelector("button");
      button.dataset.regionId = region.id;
      button.dataset.status = region.status;
      button.setAttribute("aria-pressed", "false");
      item.querySelector("img").src = region.thumbnail;
      item.querySelector("img").alt = `Region ${region.id} imagery`;
      item.querySelector(".region-name").textContent = `Region ${region.id}`;
      item.querySelector(".region-status").textContent = labels[region.status];
      item.querySelector(".region-evidence").textContent = region.evidence;
      button.addEventListener("click", () => selectRegion(region.id));
      ui["results-list"].append(item);
    }
    view.graphics.addMany(displayGraphics);
    window.lucide?.createIcons();
  }

  function clearResults() {
    searchResult = null;
    lastStatus = "";
    ui["raw-output"].value = "";
    renderResults();
  }

  function clearCredential() {
    credential = null;
    identityManager?.destroyCredentials();
    ui.login.hidden = false;
    ui.account.hidden = true;
    ui.username.textContent = "";
    clearResults();
  }

  ui["sign-in-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!identityManager || ui["sign-in"].disabled) return;
    showError();
    let portal;
    try {
      portal = new URL(ui["portal-url"].value.trim());
      if (portal.protocol !== "https:" || portal.username || portal.password || portal.search || portal.hash) throw new Error();
      portal.pathname = portal.pathname.replace(/\/sharing(?:\/rest)?\/?$/i, "").replace(/\/+$/, "");
    } catch {
      showError("Enter an HTTPS portal URL without credentials, a query, or a fragment.");
      return;
    }
    const portalUrl = portal.href.replace(/\/$/, "");
    ui["portal-url"].value = portalUrl;
    ui["sign-in"].disabled = true;
    ui["portal-url"].disabled = true;
    ui["login-status"].textContent = "Signing in...";
    try {
      sdkConfig.portalUrl = portalUrl;
      const signedIn = await identityManager.getCredential(`${portalUrl}/sharing`);
      if (closed) return;
      if (!signedIn?.token) throw new Error();
      credential = signedIn;
      ui.username.textContent = credential.userId || "Signed in";
      ui.login.hidden = true;
      ui.account.hidden = false;
      ui["search-query"].focus();
    } catch (error) {
      clearCredential();
      showError(error.name === "identity-manager:user-aborted" ? "Sign-in canceled."
        : "Sign-in failed. Check your portal URL, connection, and account's sign-in policy.");
    } finally {
      ui["sign-in"].disabled = false;
      ui["portal-url"].disabled = false;
      ui["login-status"].textContent = "";
      update();
    }
  });

  ui["sign-out"].addEventListener("click", () => {
    pendingRequest?.abort();
    clearCredential();
    showError();
    update();
  });

  ui["search-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pendingRequest || mapState !== "ready" || view.updating || !view.stationary) return;
    const description = ui["search-query"].value.trim();
    const gridSize = Number(ui["grid-size"].value);
    const concurrency = ui["search-sequential"].checked ? 1 : 3;
    if (!description) return;
    showError();
    if (!credential?.token || (credential.expires && credential.expires <= Date.now() + 30_000)) {
      clearCredential();
      showError("Sign in with ArcGIS to search the imagery.");
      update();
      return;
    }
    const token = credential.token;
    const controller = new AbortController();
    pendingRequest = controller;
    requestStatus = "Capturing map...";
    lastStatus = "";
    let timedOut = false;
    const abortOnTimeout = () => { timedOut = true; controller.abort(); };
    let timeout = setTimeout(abortOnTimeout, 60_000);
    update();
    try {
      const viewWidth = view.width;
      const viewHeight = view.height;
      const extent = view.extent.clone();
      const rotation = view.rotation;
      const { left, top, right, bottom } = view.padding;
      const areaWidth = viewWidth - left - right;
      const areaHeight = viewHeight - top - bottom;
      const capture = {
        extent, rotation, spatialReference: view.spatialReference.clone(),
        topLeft: view.toMap({ x: left, y: top }),
        topRight: view.toMap({ x: viewWidth - right, y: top }),
        bottomLeft: view.toMap({ x: left, y: viewHeight - bottom }),
      };
      if (areaWidth <= 0 || areaHeight <= 0 || !capture.topLeft || !capture.topRight || !capture.bottomLeft) {
        throw new Error("Could not determine the map coordinates for this screenshot.");
      }
      const scale = Math.min(1, 1600 / areaWidth, 1600 / areaHeight);
      const screenshot = await view.takeScreenshot({
        format: "png", width: Math.max(1, Math.round(areaWidth * scale)), height: Math.max(1, Math.round(areaHeight * scale)),
        layers: view.map.allLayers.toArray(),
      });
      controller.signal.throwIfAborted();
      if (!screenshot.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Could not capture the map.");
      if (!view.extent.equals(extent) || view.rotation !== rotation || view.width !== viewWidth
        || view.height !== viewHeight || !view.stationary) {
        throw new Error("The map moved while capturing the image. Try again once the map is still.");
      }
      capture.width = screenshot.data.width;
      capture.height = screenshot.data.height;
      const regions = createSearchRegions(capture.width, capture.height, gridSize);
      const decisions = [];
      const responses = Array(regions.length).fill(null);
      const output = {
        description, gridSize, concurrency, capturedAt: new Date().toISOString(),
        capture: { width: capture.width, height: capture.height, extent: extent.toJSON(), rotation }, regions: [],
      };
      let completed = 0;
      ui["raw-output"].value = "";
      requestStatus = `Searching regions: 0/${regions.length}`;
      update();
      for (let start = 0; start < regions.length; start += concurrency) {
        controller.signal.throwIfAborted();
        clearTimeout(timeout);
        timeout = setTimeout(abortOnTimeout, 60_000);
        const batch = await Promise.all(regions.slice(start, start + concurrency).map(async (region, index) => {
          const response = await fetch("https://aiutilsdev.arcgis.com/api/image/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Esri-Authorization": `Bearer ${token}` },
            body: JSON.stringify({
              input: createRegionImage(screenshot.data, region),
              data: [{ key: "unique_string_1", context: createAppearancePrompt(description, region) }], inputCulture: "en",
            }),
            signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "origin",
          });
          if (!response.ok) throw Object.assign(new Error(`Region ${region.id}: ArcGIS AI request failed (${response.status}).`), { status: response.status });
          const result = await response.json().catch(() => null);
          controller.signal.throwIfAborted();
          if (result?.error != null) throw Object.assign(new Error(`Region ${region.id}: the ArcGIS AI service failed.`), { status: Number(result.error.code) });
          if (result?.success !== true || !Array.isArray(result.results) || result.results.length !== 1
            || result.results[0]?.value == null || (result.results[0].success !== undefined && result.results[0].success !== true)) {
            throw new Error(`Region ${region.id}: ArcGIS did not return a successful analysis.`);
          }
          responses[start + index] = { ...region, results: result.results };
          output.regions = responses.filter(Boolean);
          ui["raw-output"].value = JSON.stringify(output, null, 2);
          const decision = parseAppearanceResult(result.results[0].value, region);
          completed++;
          requestStatus = `Searching regions: ${completed}/${regions.length}`;
          update();
          return { ...region, ...decision, thumbnail: createRegionImage(screenshot.data, region, false) };
        }));
        decisions.push(...batch);
      }
      controller.signal.throwIfAborted();
      searchResult = { description, gridSize, capture, regions: decisions };
      ui["results-filter"].value = "match";
      lastStatus = `${decisions.length} regions searched`;
      renderResults();
    } catch (error) {
      if (controller.signal.aborted) {
        lastStatus = timedOut ? "Timed out" : "Canceled";
        if (timedOut) showError("The search timed out. Try again.");
      } else if ([401, 498, 499].includes(error.status)) {
        clearCredential();
        showError("ArcGIS rejected the token. Sign in again to continue.");
      } else {
        lastStatus = "Search failed";
        showError(error instanceof TypeError ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy." : error.message);
      }
      controller.abort();
    } finally {
      clearTimeout(timeout);
      if (pendingRequest === controller) pendingRequest = null;
      update();
    }
  });

  ui["search-query"].addEventListener("input", () => { lastStatus = ""; update(); });
  ui["search-cancel"].addEventListener("click", () => pendingRequest?.abort());
  ui["results-filter"].addEventListener("change", () => { if (!pendingRequest) renderResults(); update(); });
  ui["clear-results"].addEventListener("click", () => {
    if (pendingRequest) return;
    clearResults();
    showError();
    update();
  });
  ui["return-area"].addEventListener("click", async () => {
    if (!searchResult || pendingRequest || mapState !== "ready") return;
    view.closePopup();
    try {
      if (window.matchMedia("(max-width: 760px)").matches) ui["map-view"].scrollIntoView({ block: "start" });
      await view.goTo({ target: searchResult.capture.extent, rotation: searchResult.capture.rotation }, { animate: false });
    } catch (error) {
      if (error.name !== "AbortError") showError("Could not return to the searched area.");
    }
  });
  window.addEventListener("pagehide", (event) => {
    pendingRequest?.abort();
    if (!event.persisted) { closed = true; clearTimeout(loadTimeout); view?.destroy(); }
  });

  function mapUnavailable() {
    clearTimeout(loadTimeout);
    mapState = "error";
    pendingRequest?.abort();
    view?.destroy();
    if (!identityManager) ui["login-status"].textContent = "ArcGIS is unavailable.";
    showError("Could not load the map. Check your connection and WebGL support, then reload the page.");
    update();
  }

  window.lucide?.createIcons();
  update();
  if (typeof window.require !== "function") { mapUnavailable(); return; }
  loadTimeout = setTimeout(mapUnavailable, 30_000);
  window.require([
    "esri/Map", "esri/views/MapView", "esri/layers/ImageryLayer", "esri/identity/IdentityManager", "esri/config",
    "esri/core/reactiveUtils", "esri/widgets/LayerList", "esri/widgets/Expand", "esri/Graphic",
  ], async (Map, MapView, ImageryLayer, manager, config, reactiveUtils, LayerList, Expand, GraphicConstructor) => {
    if (closed || mapState === "error") return;
    identityManager = manager;
    sdkConfig = config;
    Graphic = GraphicConstructor;
    ui["sign-in"].disabled = false;
    ui["login-status"].textContent = "";
    try {
      const imageryLayer = new ImageryLayer({ url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Oblique/WU_Ortho/ImageServer" });
      await imageryLayer.load();
      if (closed || mapState === "error") return;
      view = new MapView({
        container: ui["map-view"], map: new Map({ basemap: "satellite", layers: [imageryLayer] }),
        extent: imageryLayer.fullExtent,
      });
      await view.when();
      if (closed || mapState === "error") return;
      view.ui.add(new Expand({ view, content: new LayerList({ view }), expandIcon: "layers", expandTooltip: "Layers", collapseTooltip: "Hide layers" }), "top-right");
      view.on("click", async (event) => {
        if (pendingRequest || !searchResult) return;
        const hit = await view.hitTest(event, { include: displayGraphics });
        const graphic = hit.results.find((result) => displayGraphics.includes(result.graphic))?.graphic;
        if (graphic && !pendingRequest) selectRegion(graphic.attributes.regionId, false);
      });
      clearTimeout(loadTimeout);
      mapState = "ready";
      view.addHandles(reactiveUtils.watch(
        () => [view.updating, view.stationary, view.fatalError],
        () => view.fatalError ? mapUnavailable() : update(),
      ));
      update();
    } catch { mapUnavailable(); }
  }, mapUnavailable);
})();