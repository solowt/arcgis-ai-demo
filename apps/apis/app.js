"use strict";

async function requestAiDirect(endpoint, payload, token, signal, audioResponse = false) {
  const response = await fetch(`https://aiutilsdev.arcgis.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Esri-Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(60_000),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "origin",
  });
  if (!response.ok) {
    throw Object.assign(new Error(`ArcGIS AI request failed (${response.status}).`), {
      status: response.status,
    });
  }
  const contentType = response.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (audioResponse && (mediaType.startsWith("audio/") || mediaType === "application/octet-stream")) {
    return {
      success: true,
      meta: { contentType, contentLength: response.headers.get("content-length") },
      results: [{
        success: true,
        value: await encodeAiBlob(await response.blob()),
        key: "key:1",
      }],
    };
  }
  const result = await response.json().catch(() => null);
  if (result?.error != null) {
    throw Object.assign(new Error("The ArcGIS AI service failed."), {
      status: Number(result.error.code),
    });
  }
  if (result?.success !== true) {
    throw new Error("ArcGIS did not return a successful AI result.");
  }
  return result;
}

async function encodeAiBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function createAiMediaInput(media) {
  if (typeof media === "string" && media) return media;
  if (!(media instanceof Blob)) {
    throw new Error("Provide a media Blob, HTTPS URL, or base64 data URL.");
  }
  const mediaType = media.type.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType) throw new Error("The media is missing its MIME type.");
  return `data:${mediaType};base64,${await encodeAiBlob(media)}`;
}

function createAiPromptData(prompt, singleKey = "unique_string_1") {
  if (typeof prompt === "string") return [{ key: singleKey, context: prompt }];
  if (Array.isArray(prompt) && prompt.length) {
    if (prompt.every((item) => typeof item === "string")) {
      return prompt.map((context, index) => ({ key: `unique_string_${index}`, context }));
    }
    if (prompt.every((item) => typeof item?.key === "string" && typeof item?.context === "string")) {
      return prompt;
    }
  }
  throw new Error("Provide a prompt string, a nonempty list of strings, or keyed prompts.");
}

async function translateTextDirect(text, toLanguages, token, { fromLanguage = "en", signal } = {}) {
  let input;
  if (typeof text === "string") {
    input = [{ key: "key:1", text }];
  } else if (Array.isArray(text) && text.length && text.every((item) => typeof item === "string")) {
    input = text.map((value, index) => ({ key: `key:${index}`, text: value }));
  } else {
    throw new Error("Provide a text string or a nonempty list of strings to translate.");
  }
  const outputCultures = typeof toLanguages === "string" ? [toLanguages] : toLanguages;
  if (!Array.isArray(outputCultures) || !outputCultures.length || !outputCultures.every((language) => typeof language === "string" && language)) {
    throw new Error("Provide at least one target language.");
  }
  return requestAiDirect("text/translate", {
    input,
    outputCultures,
    inputCulture: fromLanguage ?? "en",
  }, token, signal);
}

async function analyzeTextDirect(text, prompt, token, { fromLanguage, toLanguage, signal } = {}) {
  const payload = { input: text, data: createAiPromptData(prompt, "key:1") };
  if (fromLanguage) payload.inputCulture = fromLanguage;
  if (toLanguage) payload.outputCulture = toLanguage;
  return requestAiDirect("text/analyze", payload, token, signal);
}

async function analyzeImageDirect(image, prompt, token, { fromLanguage = "en", toLanguage, signal } = {}) {
  const payload = {
    data: createAiPromptData(prompt),
    input: await createAiMediaInput(image),
    inputCulture: fromLanguage,
  };
  if (toLanguage) payload.outputCulture = toLanguage;
  return requestAiDirect("image/analyze", payload, token, signal);
}

async function extractImageTextDirect(image, prompt, token, { fromLanguage = "en", toLanguage, signal } = {}) {
  const payload = {
    data: createAiPromptData(prompt),
    input: await createAiMediaInput(image),
    inputCulture: fromLanguage,
  };
  if (toLanguage) payload.outputCulture = toLanguage;
  return requestAiDirect("image/extractText", payload, token, signal);
}

async function analyzeFileDirect(file, prompt, token, { fromLanguage, toLanguage, signal } = {}) {
  const payload = { data: createAiPromptData(prompt), input: await createAiMediaInput(file) };
  if (fromLanguage) payload.inputCulture = fromLanguage;
  if (toLanguage) payload.outputCulture = toLanguage;
  return requestAiDirect("file/analyze", payload, token, signal);
}

async function generateEmbeddingsDirect(payload, token, { signal } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Provide an embeddings request object.");
  }
  return requestAiDirect("embeddings", payload, token, signal);
}

async function generateSpeechDirect(text, token, { fromLanguage = "en", outputSpeechRate, signal } = {}) {
  const payload = { input: text };
  if (fromLanguage) payload.inputCulture = fromLanguage;
  if (outputSpeechRate) payload.outputSpeechRate = outputSpeechRate;
  return requestAiDirect("audio/speech", payload, token, signal, true);
}

async function transcribeAudioDirect(blob, token, language = "en", signal) {
  const mediaType = blob.type.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType) throw new Error("The recording is missing its audio MIME type.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const response = await fetch("https://aiutilsdev.arcgis.com/api/audio/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Esri-Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      input: `data:${mediaType};base64,${btoa(binary)}`,
      inputCulture: language,
    }),
    signal: signal ?? AbortSignal.timeout(60_000),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "origin",
  });
  if (!response.ok) {
    throw Object.assign(new Error(`ArcGIS transcription failed (${response.status}).`), {
      status: response.status,
    });
  }
  const result = await response.json().catch(() => null);
  if (result?.error != null) {
    throw Object.assign(new Error("The ArcGIS transcription service failed."), {
      status: Number(result.error.code),
    });
  }
  if (
    result?.success !== true
    || !Array.isArray(result.results)
    || !result.results.length
  ) {
    throw new Error("ArcGIS did not return a successful transcription.");
  }
  const segments = result.results.map((segment) => {
    if (
      typeof segment?.value !== "string"
      || (segment.success !== undefined && segment.success !== true)
    ) {
      throw new Error("ArcGIS returned an unsuccessful audio result.");
    }
    return segment.value;
  });
  return segments.join("\n");
}

(() => {
  const element = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "login", "workspace", "account", "username", "portal-url", "sign-in",
    "sign-in-form", "sign-out", "login-status", "error", "language",
    "transcript", "word-count", "copy", "clear", "talk", "cancel",
    "status", "duration", "waveform", "engine-browser", "engine-esri", "browser-option",
    "text-analysis", "analysis-form", "analysis-input", "analysis-prompt", "analysis-output",
    "analysis-run", "analysis-cancel", "analysis-copy", "analysis-clear-input", "analysis-clear-output",
    "analysis-sign-in", "analysis-status", "analysis-error", "analysis-word-count",
    "text-translation", "translation-form", "translation-input", "translation-output",
    "translation-from", "translation-to", "translation-swap", "translation-run", "translation-cancel",
    "translation-copy", "translation-clear-input", "translation-clear-output",
    "translation-sign-in", "translation-status", "translation-error", "translation-word-count",
  ].map((id) => [id, element(id)]));
  const maxRecordingMs = 120_000;
  const maxAudioBytes = 10 * 1024 * 1024;
  const mediaSupported = window.isSecureContext && Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder,
  );
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const browserSpeechSupported = window.isSecureContext && Boolean(SpeechRecognition);
  let identityManager;
  let sdkConfig;
  let credential = null;
  let transcriptOwner = null;
  let phase = "idle";
  let activeRecording = null;
  let pendingRequest = null;
  let pendingAnalysis = null;
  let pendingTranslation = null;
  let signInTarget = null;
  let heldBy = null;
  const requestSections = [];

  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });

  function showError(message = "") {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function updateTranscript() {
    const text = ui.transcript.value.trim();
    const count = text ? text.split(/\s+/u).length : 0;
    ui["word-count"].textContent = `${count} ${count === 1 ? "word" : "words"}`;
    ui.copy.disabled = !text;
    ui.clear.disabled = !text || phase !== "idle";
  }

  function showAnalysisError(message = "") {
    ui["analysis-error"].textContent = message;
    ui["analysis-error"].hidden = !message;
  }

  function updateAnalysisControls(message) {
    const text = ui["analysis-input"].value.trim();
    const output = ui["analysis-output"].value.trim();
    const count = text ? text.split(/\s+/u).length : 0;
    const busy = Boolean(pendingAnalysis);
    ui["analysis-word-count"].textContent = `${count} ${count === 1 ? "word" : "words"}`;
    ui["analysis-run"].disabled = busy || !credential || !text || !ui["analysis-prompt"].value.trim();
    ui["analysis-cancel"].hidden = !busy;
    ui["analysis-copy"].disabled = !output;
    ui["analysis-clear-input"].disabled = busy || !text;
    ui["analysis-clear-output"].disabled = busy || !output;
    ui["analysis-sign-in"].hidden = Boolean(credential);
    ui["analysis-sign-in"].disabled = !identityManager || ui["sign-in"].disabled;
    ui["analysis-output"].setAttribute("aria-busy", String(busy));
    ui["analysis-status"].textContent = message || (busy ? "Analyzing" : credential ? "Ready" : "Sign in required");
  }

  async function analyzeText(event) {
    event.preventDefault();
    if (pendingAnalysis) return;
    showAnalysisError();
    const text = ui["analysis-input"].value;
    const prompt = ui["analysis-prompt"].value.trim();
    if (!text.trim() || !prompt) {
      showAnalysisError("Enter source text and an analysis prompt.");
      return;
    }
    if (!credentialIsCurrent()) {
      signInTarget = ui["analysis-input"];
      requireSignIn("Sign in with ArcGIS before analyzing text.");
      return;
    }
    const controller = new AbortController();
    pendingAnalysis = controller;
    let timedOut = false;
    let finalStatus;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    updateAnalysisControls();
    try {
      const result = await analyzeTextDirect(text, prompt, credential.token, { signal: controller.signal });
      if (controller.signal.aborted) {
        finalStatus = "Canceled";
        return;
      }
      if (!Array.isArray(result.results) || !result.results.length || result.results.some(
        (entry) => entry?.value === undefined || (entry.success !== undefined && entry.success !== true),
      )) {
        throw new Error("ArcGIS did not return a successful text analysis result.");
      }
      const response = result.results.map((entry) => (
        typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2)
      )).join("\n\n").trim();
      if (!response) throw new Error("ArcGIS returned an empty text analysis response.");
      const existing = ui["analysis-output"].value.trimEnd();
      ui["analysis-output"].value = existing ? `${existing}\n\n${response}` : response;
      ui["analysis-output"].scrollTop = ui["analysis-output"].scrollHeight;
      finalStatus = "Response added";
    } catch (error) {
      if (controller.signal.aborted) {
        finalStatus = timedOut ? "Timed out" : "Canceled";
        if (timedOut) showAnalysisError("The text analysis request timed out. Try again.");
      } else if ([401, 498, 499].includes(error.status)) {
        signInTarget = ui["analysis-input"];
        requireSignIn("ArcGIS rejected the token. Sign in again before analyzing text.");
      } else {
        finalStatus = "Analysis failed";
        showAnalysisError(error instanceof TypeError
          ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy."
          : error.message);
      }
    } finally {
      clearTimeout(timeout);
      if (pendingAnalysis === controller) {
        pendingAnalysis = null;
        updateAnalysisControls(finalStatus);
      }
    }
  }

  function showTranslationError(message = "") {
    ui["translation-error"].textContent = message;
    ui["translation-error"].hidden = !message;
  }

  function updateTranslationControls(message) {
    const text = ui["translation-input"].value.trim();
    const output = ui["translation-output"].value.trim();
    const count = text ? text.split(/\s+/u).length : 0;
    const busy = Boolean(pendingTranslation);
    ui["translation-word-count"].textContent = `${count} ${count === 1 ? "word" : "words"}`;
    ui["translation-run"].disabled = busy || !credential || !text || !ui["translation-from"].value || !ui["translation-to"].value;
    ui["translation-cancel"].hidden = !busy;
    ui["translation-copy"].disabled = !output;
    ui["translation-clear-input"].disabled = busy || !text;
    ui["translation-clear-output"].disabled = busy || !output;
    ui["translation-from"].disabled = busy;
    ui["translation-to"].disabled = busy;
    ui["translation-swap"].disabled = busy;
    ui["translation-sign-in"].hidden = Boolean(credential);
    ui["translation-sign-in"].disabled = !identityManager || ui["sign-in"].disabled;
    ui["translation-output"].setAttribute("aria-busy", String(busy));
    ui["translation-status"].textContent = message || (busy ? "Translating" : credential ? "Ready" : "Sign in required");
  }

  async function translateText(event) {
    event.preventDefault();
    if (pendingTranslation) return;
    showTranslationError();
    const text = ui["translation-input"].value;
    const fromLanguage = ui["translation-from"].value;
    const toLanguage = ui["translation-to"].value;
    if (!text.trim() || !fromLanguage || !toLanguage) {
      showTranslationError("Enter source text and select source and target languages.");
      return;
    }
    if (!credentialIsCurrent()) {
      signInTarget = ui["translation-input"];
      requireSignIn("Sign in with ArcGIS before translating text.");
      return;
    }
    const controller = new AbortController();
    pendingTranslation = controller;
    let timedOut = false;
    let finalStatus;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    updateTranslationControls();
    try {
      const result = await translateTextDirect(text, toLanguage, credential.token, { fromLanguage, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!Array.isArray(result.results) || !result.results.length) {
        throw new Error("ArcGIS did not return a successful translation result.");
      }
      const translatedText = result.results.map((entry) => {
        if (!Array.isArray(entry?.translations) || (entry.success !== undefined && entry.success !== true)) {
          throw new Error("ArcGIS returned an invalid translation result.");
        }
        const translation = entry.translations.find((item) => item?.to === toLanguage);
        if (typeof translation?.text !== "string" || !translation.text.trim()) {
          throw new Error("ArcGIS did not return text in the selected target language.");
        }
        return translation.text.trim();
      }).join("\n\n");
      const existing = ui["translation-output"].value.trimEnd();
      ui["translation-output"].value = existing ? `${existing}\n\n${translatedText}` : translatedText;
      ui["translation-output"].scrollTop = ui["translation-output"].scrollHeight;
      finalStatus = "Translation added";
    } catch (error) {
      if (controller.signal.aborted) {
        finalStatus = timedOut ? "Timed out" : "Canceled";
        if (timedOut) showTranslationError("The translation request timed out. Try again.");
      } else if ([401, 498, 499].includes(error.status)) {
        signInTarget = ui["translation-input"];
        requireSignIn("ArcGIS rejected the token. Sign in again before translating text.");
      } else {
        finalStatus = "Translation failed";
        showTranslationError(error instanceof TypeError
          ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy."
          : error.message);
      }
    } finally {
      clearTimeout(timeout);
      if (pendingTranslation === controller) {
        pendingTranslation = null;
        updateTranslationControls(finalStatus);
      }
    }
  }

  function createRequestSection(prefix, options) {
    const fields = Object.fromEntries(["form", "run", "cancel", "sign-in", "status", "error"].map(
      (name) => [name, element(`${prefix}-${name}`)],
    ));
    const section = {
      root: element(prefix),
      pending: null,
      error(message = "") {
        fields.error.textContent = message;
        fields.error.hidden = !message;
      },
      update(message) {
        const busy = Boolean(section.pending);
        fields.run.disabled = busy || !credential || !options.ready();
        fields.cancel.hidden = !busy;
        fields["sign-in"].hidden = Boolean(credential);
        fields["sign-in"].disabled = !identityManager || ui["sign-in"].disabled;
        fields.form.setAttribute("aria-busy", String(busy));
        fields.status.textContent = message || (busy ? options.busyMessage : credential ? "Ready" : "Sign in required");
        options.update(busy);
      },
      abort() { section.pending?.abort(); },
      reset() {
        section.abort();
        options.reset();
        section.error();
        section.update();
      },
    };
    fields.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (section.pending) return;
      section.error();
      if (!options.ready()) {
        section.error("Complete the required inputs before submitting.");
        return;
      }
      if (!credentialIsCurrent()) {
        signInTarget = options.input;
        requireSignIn("Sign in with ArcGIS to continue.");
        return;
      }
      const controller = new AbortController();
      section.pending = controller;
      let timedOut = false;
      let finalStatus;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 60_000);
      section.update();
      try {
        const result = await options.request(credential.token, controller.signal);
        controller.signal.throwIfAborted();
        options.render(result);
        finalStatus = options.completeMessage;
      } catch (error) {
        if (controller.signal.aborted) {
          finalStatus = timedOut ? "Timed out" : "Canceled";
          if (timedOut) section.error("The request timed out. Try again.");
        } else if ([401, 498, 499].includes(error.status)) {
          signInTarget = options.input;
          requireSignIn("ArcGIS rejected the token. Sign in again to continue.");
        } else {
          finalStatus = "Request failed";
          section.error(error instanceof TypeError
            ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy."
            : error.message);
        }
      } finally {
        clearTimeout(timeout);
        if (section.pending === controller) {
          section.pending = null;
          section.update(finalStatus);
        }
      }
    });
    fields.cancel.addEventListener("click", () => section.abort());
    fields["sign-in"].addEventListener("click", () => {
      signInTarget = options.input;
      ui.login.hidden = false;
      ui["sign-in"].focus();
    });
    requestSections.push(section);
    return section;
  }

  function getAiResultValues(result) {
    if (!Array.isArray(result.results) || !result.results.length || result.results.some(
      (entry) => entry?.value == null || (entry.success !== undefined && entry.success !== true),
    )) {
      throw new Error("ArcGIS did not return a successful result.");
    }
    return result.results.map((entry) => entry.value);
  }

  function createMediaSection(prefix, request, pdf = false) {
    const fields = Object.fromEntries(["input", "prompt", "output", "file-info", "clear-input", "clear-output", "copy"].map(
      (name) => [name, element(`${prefix}-${name}`)],
    ));
    const preview = pdf ? null : element(`${prefix}-preview`);
    const mediaTypes = pdf ? { pdf: "application/pdf" } : {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
    };
    let selectedFile = null;
    let previewUrl = null;
    let scene = null;
    const clearFile = (clearInput = true) => {
      scene?.reset();
      selectedFile = null;
      if (clearInput) fields.input.value = "";
      fields["file-info"].textContent = "";
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
    };
    const section = createRequestSection(prefix, {
      input: fields.input,
      ready: () => Boolean(selectedFile && fields.prompt.value.trim()),
      busyMessage: prefix === "image-extract" ? "Extracting text" : "Analyzing",
      completeMessage: "Response added",
      request: (token, signal) => request(selectedFile, fields.prompt.value.trim(), token, { signal }),
      render(result) {
        const text = getAiResultValues(result).map((value) => (
          typeof value === "string" ? value : JSON.stringify(value, null, 2)
        )).join("\n\n").trim();
        if (!text) throw new Error("ArcGIS returned an empty response.");
        const existing = fields.output.value.trimEnd();
        fields.output.value = existing ? `${existing}\n\n${text}` : text;
        fields.output.scrollTop = fields.output.scrollHeight;
      },
      update(busy) {
        fields.input.disabled = busy;
        fields.prompt.disabled = busy;
        fields["clear-input"].disabled = busy || !selectedFile;
        fields["clear-output"].disabled = busy || !fields.output.value;
        fields.copy.disabled = !fields.output.value;
        fields.output.setAttribute("aria-busy", String(busy));
        scene?.update(busy);
      },
      reset() {
        clearFile();
        fields.output.value = "";
        fields.prompt.value = fields.prompt.defaultValue;
      },
    });
    const selectFile = (file) => {
      clearFile(false);
      section.error();
      if (file) {
        const extension = file.name?.split(".").at(-1).toLowerCase();
        const mediaType = file.type.split(";", 1)[0].trim().toLowerCase() || mediaTypes[extension];
        if (!Object.values(mediaTypes).includes(mediaType)) {
          section.error(pdf ? "Select a PDF document." : "Select a PNG, JPEG, WebP, GIF, or BMP image.");
        } else if (!file.size || file.size > 10 * 1024 * 1024) {
          section.error("Select a nonempty file no larger than 10 MiB.");
        } else {
          selectedFile = file.type === mediaType ? file : new Blob([file], { type: mediaType });
          fields["file-info"].textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KiB)`;
          if (preview) {
            previewUrl = URL.createObjectURL(selectedFile);
            preview.src = previewUrl;
            preview.alt = file.name;
            preview.hidden = false;
          }
        }
      }
      section.update();
      return Boolean(selectedFile);
    };
    fields.input.addEventListener("change", () => selectFile(fields.input.files?.[0]));
    fields.prompt.addEventListener("input", () => section.update());
    fields["clear-input"].addEventListener("click", () => { clearFile(); section.error(); section.update(); });
    fields["clear-output"].addEventListener("click", () => {
      if (!window.confirm("Clear the responses?")) return;
      fields.output.value = "";
      section.error();
      section.update();
    });
    fields.copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(fields.output.value);
        section.update("Copied");
      } catch {
        fields.output.focus();
        fields.output.select();
        section.error("Clipboard access was denied. The response is selected for copying.");
      }
    });
    if (prefix === "image-analysis") {
      scene = createImageScene((file) => {
        if (section.pending) return false;
        const selection = new DataTransfer();
        selection.items.add(file);
        fields.input.files = selection.files;
        return selectFile(file);
      });
    }
  }

  function createImageScene(selectImage) {
    const container = element("image-analysis-scene");
    const button = element("image-analysis-capture");
    const status = element("image-analysis-scene-status");
    const error = element("image-analysis-scene-error");
    let view = null;
    let ready = false;
    let busy = false;
    let closed = false;
    let capture = null;
    let loadTimeout;
    let message = "Ready";
    const showSceneError = (text = "") => {
      error.textContent = text;
      error.hidden = !text;
    };
    const update = (requestBusy = busy) => {
      busy = requestBusy;
      if (busy) capture = null;
      const updating = ready && (view.updating || !view.stationary);
      button.disabled = !ready || closed || busy || updating || Boolean(capture);
      button.setAttribute("aria-busy", String(Boolean(capture)));
      status.textContent = closed ? "Scene unavailable" : !ready ? "Loading scene"
        : capture ? "Capturing..." : updating ? "Updating scene" : message;
    };
    const reset = () => {
      capture = null;
      message = "Ready";
      if (ready) showSceneError();
      update();
    };
    const unavailable = () => {
      if (closed) return;
      closed = true;
      ready = false;
      capture = null;
      clearTimeout(loadTimeout);
      view?.destroy();
      container.hidden = true;
      showSceneError("Could not load the scene. Check your connection and WebGL support.");
      update();
    };

    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const currentCapture = {};
      capture = currentCapture;
      showSceneError();
      update();
      try {
        const scale = Math.min(1, 1600 / view.width, 1600 / view.height);
        const screenshot = await view.takeScreenshot({
          format: "png",
          width: Math.max(1, Math.round(view.width * scale)),
          height: Math.max(1, Math.round(view.height * scale)),
        });
        if (capture !== currentCapture || closed) return;
        const prefix = "data:image/png;base64,";
        if (!screenshot.dataUrl?.startsWith(prefix)) throw new Error("Invalid screenshot.");
        const bytes = Uint8Array.from(atob(screenshot.dataUrl.slice(prefix.length)), (character) => character.charCodeAt(0));
        const file = new File([bytes], "scene-screenshot.png", { type: "image/png" });
        message = selectImage(file) ? "Screenshot selected" : "Screenshot not selected";
      } catch {
        if (capture === currentCapture && !closed) {
          message = "Capture failed";
          showSceneError("Could not capture the scene. Try again once the view has finished drawing.");
        }
      } finally {
        if (capture === currentCapture) capture = null;
        update();
      }
    });
    window.addEventListener("pagehide", () => {
      closed = true;
      ready = false;
      capture = null;
      clearTimeout(loadTimeout);
      view?.destroy();
      update();
    });

    update();
    if (typeof window.require !== "function") {
      unavailable();
    } else {
      loadTimeout = setTimeout(unavailable, 30_000);
      window.require([
        "esri/Map", "esri/views/SceneView", "esri/Basemap", "esri/widgets/Home",
        "esri/widgets/Search", "esri/widgets/BasemapGallery", "esri/widgets/Expand",
        "esri/widgets/Fullscreen", "esri/core/reactiveUtils",
      ], async (Map, SceneView, Basemap, Home, Search, BasemapGallery, Expand, Fullscreen, reactiveUtils) => {
        if (closed) return;
        try {
          view = new SceneView({
            container,
            map: new Map({ basemap: "satellite", ground: "world-elevation" }),
            camera: {
              position: { longitude: -119.63, latitude: 37.71, z: 3600 },
              heading: 25,
              tilt: 65,
            },
            qualityProfile: "medium",
            ui: { components: ["attribution", "zoom", "compass", "navigation-toggle"] },
          });
          view.ui.add(new Home({ view }), { position: "top-left", index: 1 });
          view.ui.add(new Fullscreen({ view, element: container }), "top-left");
          view.ui.add(new Expand({
            view, content: new Search({ view }), group: "scene-tools",
            expandIcon: "search", expandTooltip: "Find a place",
          }), "top-right");
          view.ui.add(new Expand({
            view,
            content: new BasemapGallery({
              view,
              source: ["satellite", "hybrid", "topo-vector", "streets-vector", "gray-vector", "osm"].map(
                (id) => Basemap.fromId(id),
              ),
            }),
            group: "scene-tools", expandIcon: "basemap", expandTooltip: "Basemaps",
          }), "top-right");
          await view.when();
          if (closed) return;
          ready = true;
          clearTimeout(loadTimeout);
          view.addHandles(reactiveUtils.watch(
            () => [view.updating, view.stationary, view.fatalError],
            () => view.fatalError ? unavailable() : update(),
          ));
          update();
        } catch {
          unavailable();
        }
      }, unavailable);
    }
    return { update, reset };
  }

  function decodeSpeechAudio(value, contentType) {
    if (typeof value !== "string" || !value.trim()) throw new Error("ArcGIS returned an empty audio result.");
    let encoded = value.trim();
    let mediaType = typeof contentType === "string" ? contentType : "application/octet-stream";
    if (encoded.slice(0, 5).toLowerCase() === "data:") {
      const separator = encoded.indexOf(",");
      const parts = encoded.slice(5, separator).split(";");
      if (separator < 0 || parts.at(-1).toLowerCase() !== "base64") {
        throw new Error("ArcGIS returned an invalid audio data URL.");
      }
      mediaType = parts[0];
      encoded = encoded.slice(separator + 1);
    }
    mediaType = mediaType.split(";", 1)[0].trim().toLowerCase();
    if (!mediaType.startsWith("audio/") && mediaType !== "application/octet-stream") {
      throw new Error("ArcGIS returned a non-audio content type.");
    }
    let binary;
    try {
      binary = atob(encoded);
    } catch {
      throw new Error("ArcGIS returned invalid base64 audio.");
    }
    if (!binary.length) throw new Error("ArcGIS returned empty audio.");
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: mediaType });
  }

  function createSpeechSection() {
    const fields = Object.fromEntries(["input", "language", "rate", "output", "word-count", "clear-input", "clear-output"].map(
      (name) => [name, element(`audio-speech-${name}`)],
    ));
    const extensions = {
      "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav",
      "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac",
    };
    let clips = [];
    const clearAudio = () => {
      for (const clip of clips) {
        clip.player.pause();
        clip.player.removeAttribute("src");
        clip.player.load();
        URL.revokeObjectURL(clip.url);
      }
      clips = [];
      fields.output.replaceChildren();
    };
    const section = createRequestSection("audio-speech", {
      input: fields.input,
      ready: () => Boolean(fields.input.value.trim() && fields.language.value && fields.rate.value),
      busyMessage: "Generating audio",
      completeMessage: "Audio added",
      request: (token, signal) => generateSpeechDirect(fields.input.value, token, {
        fromLanguage: fields.language.value,
        outputSpeechRate: fields.rate.value,
        signal,
      }),
      render(result) {
        const blobs = getAiResultValues(result).map((value) => decodeSpeechAudio(value, result.meta?.contentType));
        const additions = [];
        try {
          for (const blob of blobs) {
            const clip = { url: URL.createObjectURL(blob), player: document.createElement("audio"), row: document.createElement("li") };
            additions.push(clip);
            const number = clips.length + additions.length;
            const label = document.createElement("span");
            label.className = "muted clip-label";
            label.textContent = `Audio ${number}`;
            clip.player.controls = true;
            clip.player.preload = "none";
            clip.player.src = clip.url;
            clip.player.setAttribute("aria-label", `Generated audio ${number}`);
            clip.player.addEventListener("play", () => {
              clips.forEach((other) => { if (other !== clip) other.player.pause(); });
            });
            clip.player.addEventListener("error", () => {
              if (clips.includes(clip)) section.error("This browser could not play the generated audio. Download it to use another player.");
            });
            const download = document.createElement("a");
            download.className = "icon-button";
            download.href = clip.url;
            download.download = `speech-${number}.${extensions[blob.type] || "bin"}`;
            download.title = "Download audio";
            download.setAttribute("aria-label", `Download audio ${number}`);
            const icon = document.createElement("i");
            icon.setAttribute("data-lucide", "download");
            icon.setAttribute("aria-hidden", "true");
            download.append(icon);
            clip.row.className = "speech-clip";
            clip.row.append(label, clip.player, download);
          }
        } catch (error) {
          additions.forEach((clip) => URL.revokeObjectURL(clip.url));
          throw error;
        }
        fields.output.append(...additions.map((clip) => clip.row));
        clips.push(...additions);
        window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
      },
      update(busy) {
        const text = fields.input.value.trim();
        const count = text ? text.split(/\s+/u).length : 0;
        fields["word-count"].textContent = `${count} ${count === 1 ? "word" : "words"}`;
        fields.input.disabled = busy;
        fields.language.disabled = busy;
        fields.rate.disabled = busy;
        fields["clear-input"].disabled = busy || !text;
        fields["clear-output"].disabled = busy || !clips.length;
        fields.output.setAttribute("aria-busy", String(busy));
      },
      reset() { fields.input.value = ""; clearAudio(); },
    });
    fields.input.addEventListener("input", () => section.update());
    fields.language.addEventListener("change", () => section.update());
    fields.rate.addEventListener("change", () => section.update());
    fields["clear-input"].addEventListener("click", () => {
      if (!window.confirm("Clear the speech text?")) return;
      fields.input.value = "";
      section.error();
      section.update();
    });
    fields["clear-output"].addEventListener("click", () => {
      if (!window.confirm("Clear the generated audio?")) return;
      clearAudio();
      section.error();
      section.update();
    });
  }

  function transcriptionIsActive() {
    if (document.hidden || ui.workspace.hidden) return false;
    const bounds = ui.workspace.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > window.innerHeight * 0.25 && bounds.top < window.innerHeight * 0.75;
  }

  function transcriptionHasFocus() {
    const target = document.activeElement;
    return target === document.body || target === document.documentElement || (
      ui.workspace.contains(target) && !ui.login.contains(target) && !target.closest("dialog, [role='dialog']")
    );
  }

  function usingBrowserSpeech() {
    return ui["engine-browser"].checked;
  }

  function updateTalkAvailability() {
    const available = usingBrowserSpeech() ? browserSpeechSupported : credential && mediaSupported;
    ui.talk.disabled = !transcriptionIsActive() || !available || ["stopping", "transcribing"].includes(phase);
  }

  function updatePttScope() {
    if (!transcriptionIsActive() || !transcriptionHasFocus()) stopRecording(true);
    updateTalkAvailability();
  }

  function setPhase(nextPhase, message) {
    phase = nextPhase;
    document.body.dataset.phase = phase;
    const messages = {
      idle: usingBrowserSpeech() || credential ? "Ready" : "Sign in required",
      permission: "Microphone access", recording: "Listening",
      stopping: "Finishing recording", transcribing: "Transcribing",
    };
    ui.status.textContent = message || messages[phase];
    updateTalkAvailability();
    ui.talk.setAttribute("aria-pressed", String(phase === "recording"));
    ui.language.disabled = phase !== "idle";
    ui["engine-browser"].disabled = phase !== "idle" || !browserSpeechSupported;
    ui["engine-esri"].disabled = phase !== "idle";
    ui.cancel.hidden = phase === "idle";
    updateTranscript();
  }

  function drawWaveform(samples) {
    const context = ui.waveform.getContext("2d");
    if (!context) return;
    const { width, height } = ui.waveform;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = samples ? "#b53043" : "#a7b6b5";
    context.lineWidth = 2;
    context.beginPath();
    if (samples) {
      samples.forEach((sample, index) => {
        const horizontal = index * width / (samples.length - 1);
        const vertical = sample / 255 * height;
        if (index === 0) context.moveTo(horizontal, vertical);
        else context.lineTo(horizontal, vertical);
      });
    } else {
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
    }
    context.stroke();
  }

  function stopMedia(session) {
    clearInterval(session.timer);
    cancelAnimationFrame(session.frame);
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.audioContext && session.audioContext.state !== "closed") {
      session.audioContext.close().catch(() => {});
    }
    drawWaveform();
  }

  function startMeter(session) {
    try {
      session.audioContext = new AudioContext();
      const analyser = session.audioContext.createAnalyser();
      analyser.fftSize = 256;
      session.audioContext.createMediaStreamSource(session.stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(samples);
        drawWaveform(samples);
        session.frame = requestAnimationFrame(draw);
      };
      session.audioContext.resume().catch(() => {});
      draw();
    } catch {
      drawWaveform();
    }
  }

  function startRecordingTimer(session) {
    session.startedAt = Date.now();
    setPhase("recording");
    session.timer = setInterval(() => {
      const elapsed = Date.now() - session.startedAt;
      const seconds = Math.floor(elapsed / 1000);
      ui.duration.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      if (elapsed >= maxRecordingMs) stopRecording();
    }, 200);
  }

  function appendTranscript(transcription) {
    const text = transcription.trim();
    if (text) {
      const existing = ui.transcript.value.trimEnd();
      ui.transcript.value = existing ? `${existing}\n\n${text}` : text;
      ui.transcript.scrollTop = ui.transcript.scrollHeight;
    }
    setPhase("idle", text ? "Text added" : "No speech detected");
  }

  function finishBrowserRecording(session) {
    clearTimeout(session.finishTimer);
    if (activeRecording !== session) return;
    stopMedia(session);
    activeRecording = null;
    heldBy = null;
    if (session.discard) setPhase("idle");
    else appendTranscript(session.results.filter(Boolean).join(" "));
  }

  function startBrowserRecording(session) {
    const recognition = new SpeechRecognition();
    session.recognition = recognition;
    session.results = [];
    recognition.lang = session.language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (activeRecording !== session || session.released) {
        recognition.abort();
        return;
      }
      if (!transcriptionIsActive() || !transcriptionHasFocus()) {
        stopRecording(true);
        return;
      }
      startRecordingTimer(session);
    };
    recognition.onresult = (event) => {
      if (activeRecording !== session || session.discard) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) session.results[index] = result[0].transcript;
      }
    };
    recognition.onend = () => finishBrowserRecording(session);
    recognition.onerror = (event) => {
      if (activeRecording !== session || session.discard) return;
      if (event.error !== "no-speech") {
        session.discard = true;
        const messages = {
          "not-allowed": "Speech permission was denied. Allow microphone access in your browser's site settings.",
          "service-not-allowed": "Browser speech recognition is unavailable for this browser or profile.",
          "audio-capture": "The microphone is unavailable. Check your audio input device.",
          "network": "The browser speech service could not be reached. Check your connection.",
          "language-not-supported": "The browser speech service does not support the selected language.",
        };
        showError(messages[event.error] || "The browser speech service could not transcribe this recording.");
      }
      finishBrowserRecording(session);
      recognition.abort();
    };
    recognition.start();
  }

  function stopRecording(discard = false) {
    heldBy = null;
    const session = activeRecording;
    if (!session) return;
    session.released = true;
    if (discard) session.discard = true;
    if (session.recognition) {
      stopMedia(session);
      clearTimeout(session.finishTimer);
      if (session.discard || !session.startedAt) {
        session.discard = true;
        finishBrowserRecording(session);
        session.recognition.abort();
      } else {
        setPhase("stopping");
        session.finishTimer = setTimeout(() => {
          if (activeRecording !== session) return;
          session.discard = true;
          finishBrowserRecording(session);
          session.recognition.abort();
          showError("The browser speech service did not finish in time. Try again.");
        }, 10_000);
        session.recognition.stop();
      }
      return;
    }
    if (session.recorder) {
      setPhase("stopping");
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } else {
      activeRecording = null;
      setPhase("idle");
    }
    stopMedia(session);
  }

  function cancelWork() {
    stopRecording(true);
    pendingRequest?.abort();
  }

  function requireSignIn(message) {
    cancelWork();
    pendingAnalysis?.abort();
    pendingTranslation?.abort();
    requestSections.forEach((section) => section.abort());
    credential = null;
    identityManager?.destroyCredentials();
    ui.account.hidden = true;
    ui.login.hidden = false;
    setPhase("idle");
    updateAnalysisControls();
    updateTranslationControls();
    requestSections.forEach((section) => section.update());
    showError(message);
    ui["sign-in"].focus();
  }

  function credentialIsCurrent() {
    return credential?.token && (!credential.expires || credential.expires > Date.now());
  }

  async function transcribe(blob, language) {
    if (!credentialIsCurrent()) {
      requireSignIn("Your session expired. Sign in again before recording.");
      return;
    }
    if (!blob.size) {
      setPhase("idle");
      showError("No audio was captured. Hold the microphone button a little longer.");
      return;
    }
    const controller = new AbortController();
    pendingRequest = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    setPhase("transcribing");
    try {
      const transcription = await transcribeAudioDirect(blob, credential.token, language, controller.signal);
      if (controller.signal.aborted) return;
      appendTranscript(transcription);
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) showError("The transcription request timed out. Try a shorter recording.");
      } else if ([401, 498, 499].includes(error.status)) {
        requireSignIn("ArcGIS rejected the token. Sign in again before recording.");
        return;
      } else {
        showError(error instanceof TypeError
          ? "Could not reach the ArcGIS AI service. Check your connection and the service's CORS policy."
          : error.message);
      }
      setPhase("idle");
    } finally {
      clearTimeout(timeout);
      if (pendingRequest === controller) pendingRequest = null;
    }
  }

  async function startRecording(source) {
    if (!transcriptionIsActive() || !transcriptionHasFocus() || phase !== "idle") return;
    const browserMode = usingBrowserSpeech();
    if (browserMode ? !browserSpeechSupported : !credential || !mediaSupported) return;
    if (!browserMode && !credentialIsCurrent()) {
      requireSignIn("Your session expired. Sign in again before recording.");
      return;
    }
    showError();
    heldBy = source;
    const session = { released: false, discard: false, chunks: [], bytes: 0, language: ui.language.value };
    activeRecording = session;
    ui.duration.textContent = "00:00";
    setPhase("permission");
    try {
      if (browserMode) {
        startBrowserRecording(session);
        return;
      }
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (activeRecording !== session || session.released || !credential) {
        stopMedia(session);
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) throw new Error("unsupported-format");
      session.recorder = new MediaRecorder(session.stream, { mimeType, audioBitsPerSecond: 64000 });
      session.recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || session.discard) return;
        session.bytes += event.data.size;
        if (session.bytes > maxAudioBytes) {
          showError("The recording exceeded 10 MiB and was discarded. Try a shorter recording.");
          stopRecording(true);
        } else {
          session.chunks.push(event.data);
        }
      });
      session.recorder.addEventListener("error", () => {
        session.discard = true;
        showError("The microphone recording failed. Check your audio device and try again.");
        stopRecording(true);
      });
      session.recorder.addEventListener("stop", () => {
        stopMedia(session);
        if (activeRecording !== session) return;
        activeRecording = null;
        heldBy = null;
        if (session.discard || !credential) {
          setPhase("idle");
          return;
        }
        const blob = new Blob(session.chunks, { type: session.recorder.mimeType || mimeType });
        void transcribe(blob, session.language);
      }, { once: true });
      session.recorder.start(1000);
      startRecordingTimer(session);
      startMeter(session);
    } catch (error) {
      stopMedia(session);
      if (activeRecording !== session) return;
      activeRecording = null;
      heldBy = null;
      setPhase("idle");
      const messages = {
        NotAllowedError: "Microphone permission was denied. Allow microphone access in your browser's site settings.",
        NotFoundError: "No microphone was found. Connect an audio input device and try again.",
        NotReadableError: "The microphone is unavailable. Check whether another application is using it.",
      };
      showError(messages[error.name] || (browserMode
        ? "Browser speech recognition could not start. Check microphone permissions and browser support."
        : "This browser could not start an audio recording. Try a current version of Chrome, Firefox, or Safari."));
    }
  }

  for (const engine of [ui["engine-browser"], ui["engine-esri"]]) {
    engine.addEventListener("change", () => {
      if (phase !== "idle") return;
      showError();
      ui.login.hidden = usingBrowserSpeech() || Boolean(credential);
      setPhase("idle");
    });
  }

  ui["analysis-form"].addEventListener("submit", (event) => { void analyzeText(event); });
  ui["analysis-input"].addEventListener("input", () => updateAnalysisControls());
  ui["analysis-prompt"].addEventListener("input", () => updateAnalysisControls());
  ui["analysis-cancel"].addEventListener("click", () => pendingAnalysis?.abort());
  ui["analysis-sign-in"].addEventListener("click", () => {
    signInTarget = ui["analysis-input"];
    ui.login.hidden = false;
    ui["sign-in"].focus();
  });
  ui["analysis-copy"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui["analysis-output"].value);
      ui["analysis-status"].textContent = "Copied";
    } catch {
      ui["analysis-output"].focus();
      ui["analysis-output"].select();
      showAnalysisError("Clipboard access was denied. The response is selected for copying.");
    }
  });
  for (const target of ["input", "output"]) {
    ui[`analysis-clear-${target}`].addEventListener("click", () => {
      if (!window.confirm(target === "input" ? "Clear the source text?" : "Clear the analysis responses?")) return;
      ui[`analysis-${target}`].value = "";
      showAnalysisError();
      updateAnalysisControls();
    });
  }

  ui["translation-form"].addEventListener("submit", (event) => { void translateText(event); });
  ui["translation-input"].addEventListener("input", () => updateTranslationControls());
  for (const language of ["from", "to"]) {
    ui[`translation-${language}`].addEventListener("change", () => updateTranslationControls());
  }
  ui["translation-swap"].addEventListener("click", () => {
    if (pendingTranslation) return;
    const fromLanguage = ui["translation-from"].value;
    ui["translation-from"].value = ui["translation-to"].value;
    ui["translation-to"].value = fromLanguage;
    showTranslationError();
    updateTranslationControls();
  });
  ui["translation-cancel"].addEventListener("click", () => pendingTranslation?.abort());
  ui["translation-sign-in"].addEventListener("click", () => {
    signInTarget = ui["translation-input"];
    ui.login.hidden = false;
    ui["sign-in"].focus();
  });
  ui["translation-copy"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui["translation-output"].value);
      ui["translation-status"].textContent = "Copied";
    } catch {
      ui["translation-output"].focus();
      ui["translation-output"].select();
      showTranslationError("Clipboard access was denied. The translation is selected for copying.");
    }
  });
  for (const target of ["input", "output"]) {
    ui[`translation-clear-${target}`].addEventListener("click", () => {
      if (!window.confirm(target === "input" ? "Clear the source text?" : "Clear the translations?")) return;
      ui[`translation-${target}`].value = "";
      showTranslationError();
      updateTranslationControls();
    });
  }

  createMediaSection("image-analysis", analyzeImageDirect);
  createMediaSection("image-extract", extractImageTextDirect);
  createMediaSection("file-analysis", analyzeFileDirect, true);
  createSpeechSection();

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
    updateAnalysisControls();
    updateTranslationControls();
    requestSections.forEach((section) => section.update());
    try {
      sdkConfig.portalUrl = portalUrl;
      credential = await identityManager.getCredential(`${portalUrl}/sharing`);
      if (!credential?.token) throw new Error();
      const owner = `${portalUrl}|${credential.userId}`;
      if (transcriptOwner && transcriptOwner !== owner) {
        ui.transcript.value = "";
        ui["analysis-input"].value = "";
        ui["analysis-output"].value = "";
        ui["analysis-prompt"].value = ui["analysis-prompt"].defaultValue;
        ui["translation-input"].value = "";
        ui["translation-output"].value = "";
        requestSections.forEach((section) => section.reset());
      }
      transcriptOwner = owner;
      ui.username.textContent = credential.userId || "Signed in";
      ui.login.hidden = true;
      ui.workspace.hidden = false;
      ui.account.hidden = false;
      setPhase(phase);
      if (signInTarget) {
        signInTarget.focus();
        signInTarget = null;
      } else if (!usingBrowserSpeech() && !mediaSupported) {
        showError("Audio recording requires HTTPS (or localhost) and a browser with microphone recording support.");
      } else {
        ui.talk.focus();
      }
    } catch (error) {
      credential = null;
      showError(error.name === "identity-manager:user-aborted" ? "Sign-in canceled." : "Sign-in failed. Check your portal URL, connection, and account's sign-in policy.");
    } finally {
      ui["sign-in"].disabled = false;
      ui["portal-url"].disabled = false;
      ui["login-status"].textContent = "";
      updateAnalysisControls();
      updateTranslationControls();
      requestSections.forEach((section) => section.update());
    }
  });

  ui["sign-out"].addEventListener("click", () => {
    cancelWork();
    pendingAnalysis?.abort();
    pendingTranslation?.abort();
    requestSections.forEach((section) => section.reset());
    credential = null;
    identityManager.destroyCredentials();
    ui.transcript.value = "";
    window.location.reload();
  });

  ui.talk.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || phase !== "idle") return;
    event.preventDefault();
    ui.talk.focus();
    ui.talk.setPointerCapture(event.pointerId);
    void startRecording(`pointer-${event.pointerId}`);
  });
  ui.talk.addEventListener("pointerup", (event) => {
    if (heldBy === `pointer-${event.pointerId}`) stopRecording();
  });
  ui.talk.addEventListener("pointercancel", () => stopRecording(true));
  ui.talk.addEventListener("lostpointercapture", () => {
    if (heldBy?.startsWith("pointer-")) stopRecording();
  });
  ui.talk.addEventListener("contextmenu", (event) => event.preventDefault());

  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      const section = requestSections.find((candidate) => candidate.root.contains(event.target));
      if (section) section.abort();
      else if (ui["text-analysis"].contains(event.target)) pendingAnalysis?.abort();
      else if (ui["text-translation"].contains(event.target)) pendingTranslation?.abort();
      else cancelWork();
      return;
    }
    if (!transcriptionIsActive() || !transcriptionHasFocus() || ui.talk.disabled) return;
    const hotkey = event.ctrlKey && event.code === "Space" && !event.altKey && !event.metaKey && !event.shiftKey;
    const buttonKey = event.target === ui.talk && ["Space", "Enter"].includes(event.code);
    if (!hotkey && !buttonKey) return;
    event.preventDefault();
    if (!event.repeat && !heldBy) void startRecording("keyboard");
  });
  document.addEventListener("keyup", (event) => {
    if (heldBy === "keyboard" && ["Space", "ControlLeft", "ControlRight", "Enter"].includes(event.code)) {
      event.preventDefault();
      stopRecording();
    }
  });
  window.addEventListener("blur", () => stopRecording(true));
  window.addEventListener("scroll", updatePttScope, { passive: true, capture: true });
  window.addEventListener("resize", updatePttScope);
  document.addEventListener("focusin", updatePttScope);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopRecording(true);
    updateTalkAvailability();
  });
  window.addEventListener("pagehide", () => {
    cancelWork();
    pendingAnalysis?.abort();
    pendingTranslation?.abort();
    requestSections.forEach((section) => section.reset());
  });
  ui.cancel.addEventListener("click", cancelWork);
  ui.transcript.addEventListener("input", updateTranscript);
  ui.copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui.transcript.value);
      ui.status.textContent = "Copied";
    } catch {
      ui.transcript.focus();
      ui.transcript.select();
      showError("Clipboard access was denied. The transcript is selected for copying.");
    }
  });
  ui.clear.addEventListener("click", () => {
    if (!window.confirm("Clear the transcript?")) return;
    ui.transcript.value = "";
    updateTranscript();
  });

  drawWaveform();
  ui["browser-option"].title = browserSpeechSupported
    ? "Uses your browser's speech recognition service, which may process audio online."
    : "Speech recognition is unavailable in this browser.";
  setPhase("idle");
  updateAnalysisControls();
  updateTranslationControls();
  requestSections.forEach((section) => section.update());
  const sdkUnavailableMessage = "The ArcGIS SDK could not load. Check your connection and reload the page.";
  const sdkError = () => {
    ui["login-status"].textContent = "ArcGIS is unavailable.";
    if (!usingBrowserSpeech()) showError(sdkUnavailableMessage);
  };
  if (typeof window.require !== "function") {
    sdkError();
    return;
  }
  const sdkTimeout = setTimeout(sdkError, 20_000);
  window.require(["esri/identity/IdentityManager", "esri/config"], (manager, config) => {
    clearTimeout(sdkTimeout);
    identityManager = manager;
    sdkConfig = config;
    ui["sign-in"].disabled = false;
    ui["login-status"].textContent = "";
    updateAnalysisControls();
    updateTranslationControls();
    requestSections.forEach((section) => section.update());
    if (ui.error.textContent === sdkUnavailableMessage) showError();
  }, () => {
    clearTimeout(sdkTimeout);
    sdkError();
  });
})();