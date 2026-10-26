"use strict";

function createDetectionPrompt(objectType) {
  const target = objectType.trim();
  if (!target) return "";
  return `Locate all visible objects of type ${JSON.stringify(target)} in the image and return a tight bounding box around each one. `
    + 'Include plausible candidates, including small objects and objects partly cut off at image edges. Do not invent objects without visible evidence. '
    + 'Use pixel coordinates with (0, 0) at the top-left, x increasing right, and y increasing down. '
    + 'Return only JSON in this format: {"boxes":[{"xmin":10,"ymin":20,"xmax":50,"ymax":60}]}. '
    + 'Coordinates must use the original image dimensions, not normalized values. '
    + 'Return {"boxes":[]} if no matching objects are visible.';
}

function createVerificationPrompt(objectType, boxes) {
  return `Verify the numbered candidate crops of objects of type ${JSON.stringify(objectType.trim())} in this contact sheet. `
    + 'Each panel is an independent padded crop from the same source image. Its label is the original candidate ID. '
    + 'Evaluate only the object inside the yellow box; surrounding objects are context, not additional candidates. '
    + 'Use status "confirmed" when visible evidence supports the requested type, "rejected" when it clearly does not, '
    + 'and "uncertain" when the imagery is too small, obscured, or ambiguous. Do not turn uncertainty into rejection or invent missing detail. '
    + 'Give a brief reason based on visible evidence for each decision. '
    + 'Do not add objects, change coordinates, or renumber boxes. '
    + 'Return only JSON in this format: {"verifications":[{"id":1,"status":"confirmed","reason":"brief visual evidence"}]}. '
    + 'Return exactly one decision for every supplied box ID, and no other IDs. '
    + `Candidate IDs: ${JSON.stringify(boxes.map((box) => box.id))}`;
}

function parseVerificationResults(value, boxes) {
  if (typeof value === "string") {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    try {
      value = JSON.parse(fenced ? fenced[1] : value.trim());
    } catch {
      throw new Error("Verification did not return valid JSON.");
    }
  }
  if (!Array.isArray(value?.verifications) || value.verifications.length !== boxes.length) {
    throw new Error("Verification must contain one decision for every numbered box.");
  }
  const remainingIds = new Set(boxes.map((box) => box.id));
  const decisions = new Map();
  for (const decision of value.verifications) {
    if (!Number.isInteger(decision?.id) || !remainingIds.delete(decision.id)
      || !["confirmed", "rejected", "uncertain"].includes(decision.status)
      || (decision.reason !== undefined && typeof decision.reason !== "string")) {
      throw new Error("Verification contains an invalid or duplicate box ID, status, or reason.");
    }
    decisions.set(decision.id, decision);
  }
  return boxes.map((box) => ({
    ...box, verification: decisions.get(box.id).status, reason: (decisions.get(box.id).reason || "").trim(),
  }));
}

function selectVisibleBoxes(boxes, showUncertain) {
  return boxes.filter((box) => !box.verification || box.verification === "confirmed"
    || (showUncertain && box.verification === "uncertain"));
}

function getBoxStyle(box) {
  const uncertain = box.verification === "uncertain";
  return {
    color: uncertain ? [230, 126, 34] : box.verification === "confirmed" ? [0, 166, 133] : [255, 208, 0],
    dashed: uncertain,
  };
}

function parseHouseBoxes(value, imageWidth, imageHeight) {
  if (typeof value === "string") {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    try {
      value = JSON.parse(fenced ? fenced[1] : value.trim());
    } catch {
      throw new Error("The response does not contain valid bounding-box JSON.");
    }
  }
  const boxes = Array.isArray(value) ? value : value?.boxes;
  if (!Array.isArray(boxes)) throw new Error("The response must contain a boxes array.");
  return boxes.map((box, index) => {
    const coordinates = Array.isArray(box) ? box : [box?.xmin, box?.ymin, box?.xmax, box?.ymax];
    const [xmin, ymin, xmax, ymax] = coordinates;
    if (coordinates.length !== 4 || !coordinates.every(Number.isFinite)
      || xmin < 0 || ymin < 0 || xmax > imageWidth || ymax > imageHeight
      || xmax <= xmin || ymax <= ymin) {
      throw new Error(`Bounding box ${index + 1} is invalid or outside the captured image.`);
    }
    return { xmin, ymin, xmax, ymax };
  });
}

function getImageTiles(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error("The captured image is too small to split into four tiles.");
  }
  const overlap = 0.15;
  const tileWidth = Math.ceil(width / (2 - overlap));
  const tileHeight = Math.ceil(height / (2 - overlap));
  return [
    { name: "Top-left", x: 0, y: 0, width: tileWidth, height: tileHeight },
    { name: "Top-right", x: width - tileWidth, y: 0, width: tileWidth, height: tileHeight },
    { name: "Bottom-left", x: 0, y: height - tileHeight, width: tileWidth, height: tileHeight },
    { name: "Bottom-right", x: width - tileWidth, y: height - tileHeight, width: tileWidth, height: tileHeight },
  ];
}

function mergeTileBoxes(tileBoxes) {
  const candidates = tileBoxes.flatMap((boxes, tileIndex) => boxes.map((box) => ({
    box, tileIndex, area: (box.xmax - box.xmin) * (box.ymax - box.ymin),
  }))).map((candidate, index) => ({ ...candidate, index }));
  candidates.sort((first, second) => second.area - first.area);
  const groups = [];
  for (const candidate of candidates) {
    const duplicate = groups.find((group) => {
      if (group.tiles.has(candidate.tileIndex)) return false;
      const width = Math.max(0, Math.min(group.box.xmax, candidate.box.xmax) - Math.max(group.box.xmin, candidate.box.xmin));
      const height = Math.max(0, Math.min(group.box.ymax, candidate.box.ymax) - Math.max(group.box.ymin, candidate.box.ymin));
      const intersection = width * height;
      return intersection / (group.area + candidate.area - intersection) >= 0.5;
    });
    if (duplicate) {
      duplicate.tiles.add(candidate.tileIndex);
      duplicate.index = Math.min(duplicate.index, candidate.index);
    } else {
      groups.push({ ...candidate, tiles: new Set([candidate.tileIndex]) });
    }
  }
  return groups.sort((first, second) => first.index - second.index).map((group) => ({ ...group.box }));
}

function createImageTiles(imageData) {
  const canvas = document.createElement("canvas");
  return getImageTiles(imageData.width, imageData.height).map((tile) => {
    canvas.width = tile.width;
    canvas.height = tile.height;
    canvas.getContext("2d").putImageData(imageData, -tile.x, -tile.y, tile.x, tile.y, tile.width, tile.height);
    return { ...tile, dataUrl: canvas.toDataURL("image/png") };
  });
}

function offsetTileBoxes(boxes, tile) {
  return boxes.map((box) => ({
    xmin: box.xmin + tile.x,
    ymin: box.ymin + tile.y,
    xmax: box.xmax + tile.x,
    ymax: box.ymax + tile.y,
  }));
}

function boxToMapPolygon(box, capture) {
  const { width, height, topLeft, topRight, bottomLeft, spatialReference } = capture;
  const toMap = (pixelX, pixelY) => [
    topLeft.x + (topRight.x - topLeft.x) * pixelX / width + (bottomLeft.x - topLeft.x) * pixelY / height,
    topLeft.y + (topRight.y - topLeft.y) * pixelX / width + (bottomLeft.y - topLeft.y) * pixelY / height,
  ];
  return {
    type: "polygon",
    spatialReference,
    rings: [[
      toMap(box.xmin, box.ymin),
      toMap(box.xmax, box.ymin),
      toMap(box.xmax, box.ymax),
      toMap(box.xmin, box.ymax),
      toMap(box.xmin, box.ymin),
    ]],
  };
}

function drawCaptureOverlay(canvas, imageData, boxes, showBoxes = true, numberBoxes = false) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");
  context.putImageData(imageData, 0, 0);
  if (!showBoxes) return;
  context.lineWidth = 2;
  for (const box of boxes) {
    const style = getBoxStyle(box);
    context.strokeStyle = `rgb(${style.color.join(",")})`;
    context.setLineDash(style.dashed ? [6, 4] : []);
    context.strokeRect(box.xmin, box.ymin, box.xmax - box.xmin, box.ymax - box.ymin);
  }
  if (!numberBoxes) return;
  context.font = "bold 16px sans-serif";
  context.textBaseline = "top";
  for (const box of boxes) {
    const label = String(box.id);
    const labelWidth = Math.ceil(context.measureText(label).width) + 8;
    const labelHeight = 22;
    const left = Math.max(0, Math.min(box.xmin, canvas.width - labelWidth));
    const top = Math.max(0, box.ymin >= labelHeight ? box.ymin - labelHeight : Math.min(box.ymax, canvas.height - labelHeight));
    context.fillStyle = `rgb(${getBoxStyle(box).color.join(",")})`;
    context.fillRect(left, top, labelWidth, labelHeight);
    context.fillStyle = "#111111";
    context.fillText(label, left + 4, top + 3);
  }
}

function getVerificationCrop(box, imageWidth, imageHeight) {
  const paddingX = Math.max(12, (box.xmax - box.xmin) / 2);
  const paddingY = Math.max(12, (box.ymax - box.ymin) / 2);
  const left = Math.max(0, Math.floor(box.xmin - paddingX));
  const top = Math.max(0, Math.floor(box.ymin - paddingY));
  const right = Math.min(imageWidth, Math.ceil(box.xmax + paddingX));
  const bottom = Math.min(imageHeight, Math.ceil(box.ymax + paddingY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function createVerificationSheet(imageData, boxes) {
  if (!boxes.length || boxes.length > 4) throw new Error("A verification sheet must contain one to four candidates.");
  const source = document.createElement("canvas");
  source.width = imageData.width;
  source.height = imageData.height;
  source.getContext("2d").putImageData(imageData, 0, 0);
  const canvas = document.createElement("canvas");
  const columns = Math.min(2, boxes.length);
  canvas.width = columns * 320;
  canvas.height = Math.ceil(boxes.length / columns) * 352;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3f6f8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "bold 18px sans-serif";
  context.textBaseline = "top";
  context.lineWidth = 2;
  const panels = boxes.map((box, index) => {
    const crop = getVerificationCrop(box, imageData.width, imageData.height);
    const scale = Math.min(4, 288 / crop.width, 288 / crop.height);
    const cellLeft = (index % columns) * 320;
    const cellTop = Math.floor(index / columns) * 352;
    const width = crop.width * scale;
    const height = crop.height * scale;
    const left = cellLeft + 16 + (288 - width) / 2;
    const top = cellTop + 48 + (288 - height) / 2;
    context.imageSmoothingEnabled = scale < 1;
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, left, top, width, height);
    const outline = {
      xmin: left + (box.xmin - crop.x) * scale,
      ymin: top + (box.ymin - crop.y) * scale,
      xmax: left + (box.xmax - crop.x) * scale,
      ymax: top + (box.ymax - crop.y) * scale,
    };
    context.strokeStyle = "#ffd000";
    context.strokeRect(outline.xmin, outline.ymin, outline.xmax - outline.xmin, outline.ymax - outline.ymin);
    context.fillStyle = "#111111";
    context.fillText(`#${box.id}`, cellLeft + 16, cellTop + 8);
    return { id: box.id, crop, image: { x: left, y: top, width, height }, outline };
  });
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, panels };
}

(() => {
  const ui = Object.fromEntries([
    "map-view", "map-status", "login", "login-status", "portal-url", "sign-in-form",
    "sign-in", "account", "username", "sign-out", "analysis-form", "analysis-object", "analysis-prompt", "analysis-verify",
    "analysis-sequential", "analysis-uncertain", "analysis-legend",
    "analysis-run", "analysis-cancel", "analysis-status", "analysis-output", "error",
    "capture-open", "capture-dialog", "capture-close", "capture-info", "capture-canvas",
    "capture-boxes", "capture-fit", "capture-actual", "capture-viewport",
  ].map((id) => [id, document.getElementById(id)]));
  let view;
  let identityManager;
  let sdkConfig;
  let Graphic;
  let houseGraphics = [];
  let detectionResult = null;
  let capturePreview = null;
  let credential = null;
  let mapState = "loading";
  let pendingRequest = null;
  let requestStatus = "";
  let lastStatus = "";
  let closed = false;
  let loadTimeout;

  function showError(message = "") {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function renderCapturePreview() {
    ui["capture-open"].disabled = !capturePreview;
    if (!capturePreview) {
      ui["capture-dialog"].close();
      ui["capture-canvas"].width = 0;
      ui["capture-canvas"].height = 0;
      ui["capture-info"].textContent = "";
      return;
    }
    const { imageData, boxes, status, numbered } = capturePreview;
    ui["capture-info"].textContent = `${imageData.width} x ${imageData.height} px | ${status}`;
    drawCaptureOverlay(ui["capture-canvas"], imageData, boxes, ui["capture-boxes"].checked, numbered);
    ui["capture-canvas"].setAttribute("aria-label", ui["capture-boxes"].checked
      ? `Captured image with ${numbered ? "numbered" : "returned"} bounding boxes` : "Captured image without bounding boxes");
  }

  function renderDetectionResult() {
    if (!detectionResult) return;
    const { boxes, capture, objectType, verified, preview } = detectionResult;
    const visibleBoxes = selectVisibleBoxes(boxes, ui["analysis-uncertain"].checked);
    const graphics = visibleBoxes.map(({ id, verification, reason, ...box }) => {
      const style = getBoxStyle({ verification });
      return new Graphic({
        geometry: boxToMapPolygon(box, capture),
        symbol: {
          type: "simple-fill",
          color: [...style.color, 0.08],
          outline: { color: style.color, width: 2, style: style.dashed ? "dash" : "solid" },
        },
        attributes: { objectId: id, objectType, verification: verification || "unverified", reason: reason || "", ...box },
        popupTemplate: {
          title: "Detection {objectId}",
          content: [{ type: "fields", fieldInfos: [
            { fieldName: "objectType", label: "Object" },
            { fieldName: "verification", label: "Verification" },
            { fieldName: "reason", label: "Reason" },
          ] }],
        },
      });
    });
    view.graphics.removeMany(houseGraphics);
    view.graphics.addMany(graphics);
    houseGraphics = graphics;
    const count = (status) => boxes.filter((box) => box.verification === status).length;
    const summary = verified
      ? `${count("confirmed")} confirmed, ${count("uncertain")} uncertain, ${count("rejected")} rejected; ${visibleBoxes.length} shown`
      : boxes.length ? `${boxes.length} candidates` : "none found";
    lastStatus = `${objectType}: ${summary}`;
    if (capturePreview === preview) {
      preview.boxes = visibleBoxes;
      preview.status = summary;
      renderCapturePreview();
    }
  }

  ui["capture-open"].addEventListener("click", () => {
    if (capturePreview) ui["capture-dialog"].showModal();
  });
  ui["capture-close"].addEventListener("click", () => ui["capture-dialog"].close());
  ui["capture-dialog"].addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    ui["capture-dialog"].close();
  });
  ui["capture-boxes"].addEventListener("change", renderCapturePreview);
  for (const id of ["capture-fit", "capture-actual"]) {
    ui[id].addEventListener("change", () => {
      ui["capture-viewport"].dataset.size = ui["capture-actual"].checked ? "actual" : "fit";
    });
  }

  function update() {
    const busy = Boolean(pendingRequest);
    const ready = mapState === "ready";
    const drawing = ready && (view.updating || !view.stationary);
    ui["map-status"].textContent = mapState === "error" ? "Map unavailable"
      : !ready ? "Loading map..." : drawing ? "Updating map..." : "Map ready";
    ui["analysis-run"].disabled = busy || !ready || drawing || !credential
      || !ui["analysis-object"].value.trim() || !ui["analysis-prompt"].value.trim();
    ui["analysis-object"].disabled = busy;
    ui["analysis-prompt"].disabled = busy;
    ui["analysis-verify"].disabled = busy;
    ui["analysis-sequential"].disabled = busy;
    ui["analysis-uncertain"].disabled = busy || !detectionResult?.verified;
    ui["analysis-legend"].hidden = !detectionResult?.verified;
    ui["analysis-cancel"].hidden = !busy;
    ui["analysis-form"].setAttribute("aria-busy", String(busy));
    ui["analysis-output"].setAttribute("aria-busy", String(busy));
    ui["analysis-status"].textContent = busy ? requestStatus : !credential ? "Sign in required"
      : lastStatus || (ready && !drawing ? "Ready" : "Waiting for map");
  }

  function clearCredential() {
    credential = null;
    identityManager?.destroyCredentials();
    ui.login.hidden = false;
    ui.account.hidden = true;
    ui.username.textContent = "";
    ui["analysis-output"].value = "";
    view?.graphics?.removeMany(houseGraphics);
    houseGraphics = [];
    detectionResult = null;
    capturePreview = null;
    renderCapturePreview();
    lastStatus = "";
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
      ui["analysis-prompt"].focus();
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

  ui["analysis-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pendingRequest || mapState !== "ready" || view.updating || !view.stationary) return;
    const objectType = ui["analysis-object"].value.trim();
    const prompt = ui["analysis-prompt"].value.trim();
    const verifyDetections = ui["analysis-verify"].checked;
    const sequentialRequests = ui["analysis-sequential"].checked;
    if (!objectType || !prompt) return;
    showError();
    if (!credential?.token || (credential.expires && credential.expires <= Date.now() + 30_000)) {
      clearCredential();
      showError("Sign in with ArcGIS to analyze the map.");
      update();
      ui["sign-in"].focus();
      return;
    }

    const token = credential.token;
    const controller = new AbortController();
    pendingRequest = controller;
    requestStatus = "Capturing map...";
    lastStatus = "";
    let requestPreview = null;
    let timedOut = false;
    let stage = "Analysis";
    const abortOnTimeout = () => {
      timedOut = true;
      controller.abort();
    };
    let timeout = setTimeout(abortOnTimeout, 60_000);
    async function analyzeImage(input, context, label) {
      const response = await fetch("https://aiutilsdev.arcgis.com/api/image/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Esri-Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ input, data: [{ key: "unique_string_1", context }], inputCulture: "en" }),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "origin",
      });
      if (!response.ok) {
        throw Object.assign(new Error(`${label}: ArcGIS AI request failed (${response.status}).`), { status: response.status });
      }
      const result = await response.json().catch(() => null);
      controller.signal.throwIfAborted();
      if (result?.error != null) {
        throw Object.assign(new Error(`${label}: The ArcGIS AI service failed.`), { status: Number(result.error.code) });
      }
      if (result?.success !== true || !Array.isArray(result.results) || !result.results.length || result.results.some(
        (entry) => entry?.value == null || (entry.success !== undefined && entry.success !== true),
      )) throw new Error(`${label}: ArcGIS did not return a successful image analysis.`);
      return result.results;
    }
    update();
    try {
      const viewWidth = view.width;
      const viewHeight = view.height;
      const capturedExtent = view.extent.clone();
      const capturedRotation = view.rotation;
      const { left, top, right, bottom } = view.padding;
      const areaWidth = viewWidth - left - right;
      const areaHeight = viewHeight - top - bottom;
      const capture = {
        topLeft: view.toMap({ x: left, y: top }),
        topRight: view.toMap({ x: viewWidth - right, y: top }),
        bottomLeft: view.toMap({ x: left, y: viewHeight - bottom }),
        spatialReference: view.spatialReference.clone(),
      };
      if (areaWidth <= 0 || areaHeight <= 0 || !capture.topLeft || !capture.topRight || !capture.bottomLeft) {
        throw new Error("Could not determine the map coordinates for this screenshot.");
      }
      const scale = Math.min(1, 1600 / areaWidth, 1600 / areaHeight);
      const screenshot = await view.takeScreenshot({
        format: "png",
        width: Math.max(1, Math.round(areaWidth * scale)),
        height: Math.max(1, Math.round(areaHeight * scale)),
        layers: view.map.allLayers.toArray(),
      });
      controller.signal.throwIfAborted();
      if (!screenshot.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Could not capture the map.");
      if (!view.extent.equals(capturedExtent) || view.rotation !== capturedRotation
        || view.width !== viewWidth || view.height !== viewHeight || !view.stationary) {
        throw new Error("The map moved while capturing the image. Try again once the map is still.");
      }
      capture.width = screenshot.data.width;
      capture.height = screenshot.data.height;
      const tiles = createImageTiles(screenshot.data);
      requestPreview = { imageData: screenshot.data, boxes: [], status: `Analyzing tiles: 0/${tiles.length}`, pending: true };
      capturePreview = requestPreview;
      ui["analysis-output"].value = "";
      renderCapturePreview();
      requestStatus = requestPreview.status;
      update();
      const tileResponses = Array(tiles.length).fill(null);
      let completedTiles = 0;
      const tileBoxes = [];
      const tileConcurrency = sequentialRequests ? 1 : tiles.length;
      for (let start = 0; start < tiles.length; start += tileConcurrency) {
        controller.signal.throwIfAborted();
        clearTimeout(timeout);
        timeout = setTimeout(abortOnTimeout, 60_000);
        const completed = await Promise.all(tiles.slice(start, start + tileConcurrency).map(async (tile, index) => {
          const imagePrompt = `${prompt}\n\nThe image is ${tile.width} pixels wide and ${tile.height} pixels high. `
            + `Use pixel-edge coordinates: 0 <= xmin < xmax <= ${tile.width} and 0 <= ymin < ymax <= ${tile.height}. `
            + 'Coordinates must be local to this image, with (0, 0) at its top-left. '
            + 'Return only {"boxes":[{"xmin":number,"ymin":number,"xmax":number,"ymax":number}]}.';
          const results = await analyzeImage(tile.dataUrl, imagePrompt, `${tile.name} tile`);
          tileResponses[start + index] = {
            tile: tile.name, offset: { x: tile.x, y: tile.y }, width: tile.width, height: tile.height, results,
          };
          ui["analysis-output"].value = JSON.stringify(tileResponses.filter(Boolean), null, 2);
          let boxes;
          try {
            boxes = results.flatMap((entry) => parseHouseBoxes(entry.value, tile.width, tile.height));
          } catch (error) {
            throw new Error(`${tile.name} tile: ${error.message}`);
          }
          completedTiles++;
          requestStatus = `Analyzing tiles: ${completedTiles}/${tiles.length}`;
          requestPreview.status = requestStatus;
          renderCapturePreview();
          update();
          return offsetTileBoxes(boxes, tile);
        }));
        tileBoxes.push(...completed);
      }
      controller.signal.throwIfAborted();
      let boxes = mergeTileBoxes(tileBoxes).map((box, index) => ({ ...box, id: index + 1 }));
      const candidateCount = boxes.length;
      const rawCount = tileBoxes.reduce((count, tile) => count + tile.length, 0);
      const analysisResponse = {
        sequentialRequests, tiles: tileResponses, detection: { rawCount, duplicatesMerged: rawCount - candidateCount, candidates: boxes },
      };
      ui["analysis-output"].value = JSON.stringify(analysisResponse, null, 2);
      const verificationApplied = verifyDetections && candidateCount > 0;
      if (verificationApplied) {
        stage = "Verification";
        const batches = Array.from({ length: Math.ceil(candidateCount / 4) }, (_, index) => boxes.slice(index * 4, index * 4 + 4));
        const batchResponses = Array(batches.length).fill(null);
        const verifiedBoxes = [];
        let completedBatches = 0;
        analysisResponse.verification = { batches: [] };
        requestStatus = `Verifying crops: 0/${batches.length}`;
        requestPreview.boxes = boxes;
        requestPreview.numbered = true;
        requestPreview.status = requestStatus;
        renderCapturePreview();
        update();
        const verificationConcurrency = sequentialRequests ? 1 : 2;
        for (let start = 0; start < batches.length; start += verificationConcurrency) {
          controller.signal.throwIfAborted();
          clearTimeout(timeout);
          timeout = setTimeout(abortOnTimeout, 60_000);
          const completed = await Promise.all(batches.slice(start, start + verificationConcurrency).map(async (batch, index) => {
            const batchIndex = start + index;
            const label = `Verification batch ${batchIndex + 1}`;
            const sheet = createVerificationSheet(screenshot.data, batch);
            const results = await analyzeImage(sheet.dataUrl, createVerificationPrompt(objectType, batch), label);
            batchResponses[batchIndex] = {
              batch: batchIndex + 1, width: sheet.width, height: sheet.height, panels: sheet.panels, results,
            };
            analysisResponse.verification.batches = batchResponses.filter(Boolean);
            ui["analysis-output"].value = JSON.stringify(analysisResponse, null, 2);
            let decisions;
            try {
              if (results.length !== 1) throw new Error("Verification must return a single set of decisions.");
              decisions = parseVerificationResults(results[0].value, batch);
            } catch (error) {
              throw new Error(`${label}: ${error.message}`);
            }
            completedBatches++;
            requestStatus = `Verifying crops: ${completedBatches}/${batches.length}`;
            requestPreview.status = requestStatus;
            renderCapturePreview();
            update();
            return decisions;
          }));
          verifiedBoxes.push(...completed.flat());
        }
        boxes = verifiedBoxes;
        analysisResponse.verification.decisions = boxes;
      }
      controller.signal.throwIfAborted();
      ui["analysis-output"].value = JSON.stringify(analysisResponse, null, 2);
      requestPreview.pending = false;
      detectionResult = { boxes, capture, objectType, verified: verificationApplied, preview: requestPreview };
      renderDetectionResult();
    } catch (error) {
      if (controller.signal.aborted) {
        lastStatus = timedOut ? "Timed out" : "Canceled";
        if (timedOut) showError(`The ${stage.toLowerCase()} request timed out. Try again.`);
      } else if ([401, 498, 499].includes(error.status)) {
        clearCredential();
        showError("ArcGIS rejected the token. Sign in again to continue.");
      } else {
        lastStatus = `${stage} failed`;
        showError(error instanceof TypeError
          ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy."
          : error.message);
      }
      controller.abort();
    } finally {
      clearTimeout(timeout);
      if (requestPreview && capturePreview === requestPreview && requestPreview.pending) {
        requestPreview.pending = false;
        requestPreview.status = lastStatus || "No overlay";
        renderCapturePreview();
      }
      if (pendingRequest === controller) {
        pendingRequest = null;
        update();
      }
    }
  });

  function updateObjectPrompt() {
    ui["analysis-prompt"].value = createDetectionPrompt(ui["analysis-object"].value);
    lastStatus = "";
    update();
  }

  ui["analysis-object"].addEventListener("input", updateObjectPrompt);
  ui["analysis-prompt"].addEventListener("input", () => {
    lastStatus = "";
    update();
  });
  ui["analysis-uncertain"].addEventListener("change", () => {
    if (pendingRequest) return;
    renderDetectionResult();
    update();
  });
  ui["analysis-cancel"].addEventListener("click", () => pendingRequest?.abort());
  window.addEventListener("pagehide", (event) => {
    pendingRequest?.abort();
    if (!event.persisted) {
      closed = true;
      clearTimeout(loadTimeout);
      view?.destroy();
    }
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
  updateObjectPrompt();
  if (typeof window.require !== "function") {
    mapUnavailable();
    return;
  }
  loadTimeout = setTimeout(mapUnavailable, 30_000);
  window.require([
    "esri/Map", "esri/views/MapView", "esri/layers/ImageryLayer", "esri/identity/IdentityManager", "esri/config", "esri/core/reactiveUtils",
    "esri/widgets/LayerList", "esri/widgets/Expand", "esri/Graphic",
  ], async (Map, MapView, ImageryLayer, manager, config, reactiveUtils, LayerList, Expand, GraphicConstructor) => {
    if (closed || mapState === "error") return;
    identityManager = manager;
    sdkConfig = config;
    Graphic = GraphicConstructor;
    ui["sign-in"].disabled = false;
    ui["login-status"].textContent = "";
    try {
      const imageryLayer = new ImageryLayer({
        url: "https://imagery.idt.geocloud.com/image/rest/services/satellite/sanfran_wv2_ms_PS/ImageServer",
      });
      await imageryLayer.load();
      if (closed || mapState === "error") return;
      view = new MapView({
        container: ui["map-view"],
        map: new Map({ basemap: "satellite", layers: [imageryLayer] }),
        extent: imageryLayer.fullExtent,
        zoom: 17
      });
      await view.when();
      if (closed || mapState === "error") return;
      view.ui.add(new Expand({
        view,
        content: new LayerList({ view }),
        expandIcon: "layers",
        expandTooltip: "Layers",
        collapseTooltip: "Hide layers",
      }), "top-right");
      clearTimeout(loadTimeout);
      mapState = "ready";
      view.addHandles(reactiveUtils.watch(
        () => [view.updating, view.stationary, view.fatalError],
        () => view.fatalError ? mapUnavailable() : update(),
      ));
      update();
    } catch {
      mapUnavailable();
    }
  }, mapUnavailable);
})();