import esriConfig from "@arcgis/core/config.js";
import IdentityManager from "@arcgis/core/identity/IdentityManager.js";
import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import * as locator from "@arcgis/core/rest/locator.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import { LLMAgent } from "@arcgis/ai-components/agent-utils/LLMAgent.js";
import { FunctionTool } from "@arcgis/ai-components/agent-utils/tools/FunctionTool.js";
import { createAgentMiddleware } from "@arcgis/ai-components/agent-utils/middlewares/middleware.js";
import { z } from "zod";
import {
  createIcons,
  Camera,
  Copy,
  Download,
  Layers,
  LogIn,
  LogOut,
  Map,
  MapPinOff,
  Paperclip,
  PanelBottom,
  RotateCcw,
  Trash2,
  X,
} from "lucide";
import "@esri/calcite-components/main.css";
import "@arcgis/core/assets/esri/themes/light/main.css";
import "./app.css";
import {
  requestHelperService,
  resultText,
  decodeSpeechAudio,
} from "./services.js";
import {
  HELPER_AGENT_PROMPT,
  HELPER_TOOL_DEFINITIONS,
  createServicePayload,
  useChatCompletions,
} from "./tools.js";

const ui = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [
    element.id,
    element,
  ]),
);
const icons = {
  Camera,
  Copy,
  Download,
  Layers,
  LogIn,
  LogOut,
  Map,
  MapPinOff,
  Paperclip,
  PanelBottom,
  RotateCcw,
  Trash2,
  X,
};
const parameters = new URLSearchParams(location.search);
const defaultPortal = "https://excalibur.mapsdevext.arcgis.com";
const requests = new Set();
const results = [];
const audioUrls = new Set();
const markers = new GraphicsLayer({
  title: "Assistant results",
});
let credential = null;
let assistant = null;
let attachment = null;
let previewUrl = null;
let resultNumber = 0;
let sessionNumber = 0;
let loginAttempt = 0;
let sessionOwner = null;
let signingIn = false;
let capturing = false;
let mapReady = false;
let activeTab = "output";

function showError(message = "") {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

function normalizePortal(value) {
  const portal = new URL(value.trim());
  if (
    portal.protocol !== "https:" ||
    portal.username ||
    portal.password ||
    portal.search ||
    portal.hash
  ) {
    throw new Error(
      "Enter an HTTPS portal URL without credentials, a query, or a fragment.",
    );
  }
  portal.pathname = portal.pathname
    .replace(/\/sharing(?:\/rest)?\/?$/i, "")
    .replace(/\/+$/, "");
  return portal.href.replace(/\/$/, "");
}

let portalUrl = defaultPortal;
try {
  portalUrl = normalizePortal(parameters.get("portal") || defaultPortal);
} catch (failure) {
  showError(failure.message);
}
esriConfig.portalUrl = portalUrl;
esriConfig.applicationName = "Helper Services Assistant";
esriConfig.assetsPath = "https://js.arcgis.com/5.1/@arcgis/core/assets/";
ui["portal-url"].value = portalUrl;
createIcons({
  icons,
  attrs: { "aria-hidden": "true" },
});

function currentCredential() {
  return credential?.token &&
    (!credential.expires || credential.expires > Date.now())
    ? credential
    : null;
}

function updateLogin(message = "") {
  const signedIn = Boolean(currentCredential());
  ui.login.hidden = signedIn;
  ui.account.hidden = !signedIn;
  ui.username.textContent = signedIn ? credential.userId || "Signed in" : "";
  ui["sign-in"].disabled = signingIn;
  ui["portal-url"].disabled = signingIn;
  ui["login-status"].textContent = message;
}

function showSignedOut() {
  assistant?.remove();
  assistant = null;
  const status = document.createElement("p");
  status.className = "loading";
  status.setAttribute("role", "status");
  status.textContent = "Sign in required";
  ui["assistant-container"].replaceChildren(status);
}

function cancelRequests() {
  sessionNumber++;
  for (const controller of requests) controller.abort();
  requests.clear();
  ui["helper-map"].view?.animation?.stop();
  ui["task-status"].textContent = "Canceled";
}

function clearAttachment() {
  attachment = null;
  ui["attachment-input"].value = "";
  ui["attachment-name"].textContent = "No attachment";
  ui["remove-attachment"].disabled = true;
  ui["attachment-preview"].hidden = true;
  ui["attachment-preview"].removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function setAttachment(file) {
  const types = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    pdf: "application/pdf",
    json: "application/json",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  const type =
    file.type.split(";", 1)[0].toLowerCase() ||
    types[file.name.split(".").at(-1).toLowerCase()];
  if (
    !type ||
    (!Object.values(types).includes(type) && !type.startsWith("audio/"))
  )
    throw new Error("Select an image, PDF, audio recording, or JSON file.");
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error("Select a nonempty file no larger than 10 MiB.");
  clearAttachment();
  attachment = new File([file], file.name, {
    type,
  });
  ui["attachment-name"].textContent =
    `${file.name} (${(file.size / 1024).toFixed(1)} KiB)`;
  ui["remove-attachment"].disabled = false;
  if (type.startsWith("image/")) {
    previewUrl = URL.createObjectURL(attachment);
    ui["attachment-preview"].src = previewUrl;
    ui["attachment-preview"].alt = file.name;
    ui["attachment-preview"].hidden = false;
  }
}

async function mapScreenshot() {
  const view = ui["helper-map"].view;
  if (!mapReady || view.updating || !view.stationary || view.fatalError)
    throw new Error("Wait for the map to finish drawing before capturing it.");
  const scale = Math.min(1, 1600 / view.width, 1600 / view.height);
  const screenshot = await view.takeScreenshot({
    format: "png",
    width: Math.max(1, Math.round(view.width * scale)),
    height: Math.max(1, Math.round(view.height * scale)),
  });
  const encoded = screenshot.dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  return new File([bytes], "map-screenshot.png", {
    type: "image/png",
  });
}

async function resolveMedia(source, kind) {
  if (source === "map") {
    if (kind !== "image")
      throw new Error("Map screenshots are only available to image tools.");
    return mapScreenshot();
  }
  if (source !== "attachment") return source;
  if (!attachment) throw new Error("No attachment selected.");
  const matches =
    kind === "json"
      ? attachment.type === "application/json"
      : kind === "pdf"
        ? attachment.type === "application/pdf"
        : attachment.type.startsWith(`${kind}/`);
  if (!matches)
    throw new Error(`Select a ${kind} attachment for this service.`);
  return attachment;
}

function releaseAudio() {
  for (const player of ui["output-panel"].querySelectorAll("audio")) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  for (const url of audioUrls) URL.revokeObjectURL(url);
  audioUrls.clear();
}

function selectedResult() {
  return results.find((result) => result.id === ui["result-selection"].value);
}

function renderResult() {
  releaseAudio();
  ui["output-panel"].replaceChildren();
  const result = selectedResult();
  const exists = Boolean(result);
  for (const key of ["copy-result", "download-result", "clear-results"])
    ui[key].disabled = !exists;
  ui["result-selection"].disabled = !exists;
  ui["result-endpoint"].textContent = result?.endpoint || "";
  ui["json-panel"].textContent = result
    ? JSON.stringify(result.response, null, 2)
    : "";
  if (!result) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No results yet";
    ui["output-panel"].append(empty);
  } else if (result.audio?.length) {
    const extensions = {
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/webm": "webm",
      "audio/mp4": "m4a",
      "audio/flac": "flac",
    };
    for (const [index, blob] of result.audio.entries()) {
      const url = URL.createObjectURL(blob);
      audioUrls.add(url);
      const row = document.createElement("div");
      row.className = "audio-result";
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = url;
      player.setAttribute("aria-label", `Generated speech ${index + 1}`);
      player.addEventListener("error", () =>
        showError(
          "This browser could not play the audio. Download it to use another player.",
        ),
      );
      const download = document.createElement("a");
      download.href = url;
      download.download = `${result.id}-${index + 1}.${extensions[blob.type] || "bin"}`;
      download.textContent = `Download audio ${index + 1}`;
      row.append(player, download);
      ui["output-panel"].append(row);
    }
  } else {
    const content = document.createElement("pre");
    content.textContent =
      result.text || JSON.stringify(result.response, null, 2);
    ui["output-panel"].append(content);
  }
}

function publishResult(service, response) {
  let audio;
  if (service.name === "generate_speech") {
    if (!response.results?.length)
      throw new Error("ArcGIS returned no audio results.");
    audio = response.results.map((entry) =>
      decodeSpeechAudio(entry.value, response.meta?.contentType),
    );
  }
  const result = {
    id: `result-${++resultNumber}`,
    title: service.title,
    endpoint: service.endpoint,
    response,
    audio,
    text: audio
      ? "Generated audio"
      : resultText(response) || JSON.stringify(response, null, 2),
  };
  results.push(result);
  if (results.length > 30) results.shift();
  ui["result-selection"].replaceChildren(
    ...results
      .slice()
      .reverse()
      .map(
        (item) =>
          new Option(
            `${item.id.replace("result-", "")} / ${item.title}`,
            item.id,
          ),
      ),
  );
  ui["result-selection"].value = result.id;
  ui["result-count"].textContent = String(results.length);
  renderResult();
  return {
    resultId: result.id,
    service: service.title,
    success: true,
    text:
      service.name === "generate_embeddings"
        ? "Embeddings are available in Results as JSON."
        : result.text.slice(0, 12_000),
    outputWindow: "Results",
  };
}

async function runHelper(name, input, config) {
  const service = HELPER_TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === name,
  );
  const authorized = currentCredential();
  if (!authorized) {
    updateLogin();
    throw new Error("Sign in with ArcGIS before using helper services.");
  }
  const controller = new AbortController();
  const signal = config?.signal
    ? AbortSignal.any([controller.signal, config.signal])
    : controller.signal;
  const session = sessionNumber;
  requests.add(controller);
  ui["task-status"].textContent = `${service.title}...`;
  showError();
  try {
    signal.throwIfAborted();
    const payload = await createServicePayload(name, input, resolveMedia);
    signal.throwIfAborted();
    if (
      session !== sessionNumber ||
      currentCredential()?.token !== authorized.token
    )
      throw new DOMException("Session changed.", "AbortError");
    const response = await requestHelperService(
      name,
      payload,
      authorized.token,
      { signal },
    );
    signal.throwIfAborted();
    if (
      session !== sessionNumber ||
      currentCredential()?.token !== authorized.token
    )
      throw new DOMException("Session changed.", "AbortError");
    const summary = publishResult(service, response);
    ui["task-status"].textContent = `${service.title} complete`;
    return summary;
  } catch (failure) {
    if (signal.aborted || failure.name === "AbortError")
      throw new Error("The helper request was canceled; no result was added.");
    if ([401, 498, 499].includes(failure.status)) {
      IdentityManager.destroyCredentials();
      credential = null;
      cancelRequests();
      showSignedOut();
      updateLogin("Your session expired. Sign in again.");
    }
    const message =
      failure.name === "TimeoutError"
        ? "The helper request timed out. Try a smaller input."
        : failure.message;
    showError(message);
    ui["task-status"].textContent = `${service.title} failed`;
    throw new Error(message);
  } finally {
    requests.delete(controller);
  }
}

function clearResults() {
  releaseAudio();
  results.length = 0;
  ui["result-selection"].replaceChildren(new Option("No results", ""));
  ui["result-count"].textContent = "0";
  renderResult();
}

export function createAgent() {
  const tools = HELPER_TOOL_DEFINITIONS.map(
    (definition) =>
      new FunctionTool({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: (input, config) => runHelper(definition.name, input, config),
      }),
  );
  tools.push(
    new FunctionTool({
      name: "inspect_workspace",
      description:
        "Inspect the current attachment metadata, map center, and a recent service result. Call before using an attachment or prior output. Does not expose file bytes or credentials.",
      inputSchema: z.object({
        resultId: z
          .string()
          .optional()
          .describe(
            "A previously returned result ID; omit for the latest result.",
          ),
      }),
      execute: ({ resultId }) => {
        const result = resultId
          ? results.find((item) => item.id === resultId)
          : results.at(-1);
        const center = ui["helper-map"].view?.center;
        return {
          attachment: attachment
            ? {
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
                source: "attachment",
              }
            : null,
          map: mapReady
            ? {
                longitude: center?.longitude,
                latitude: center?.latitude,
                zoom: ui["helper-map"].view.zoom,
                screenshotSource: "map",
              }
            : null,
          result: result
            ? {
                id: result.id,
                title: result.title,
                text:
                  result.title === "Embeddings"
                    ? "Available in Results"
                    : result.text.slice(0, 12_000),
              }
            : null,
        };
      },
    }),
  );
  tools.push(
    new FunctionTool({
      name: "navigate_to_place",
      description:
        "Find a named location using the ArcGIS World Geocoding Service and navigate the map to the best matching result.",
      inputSchema: z.object({
        place: z.string().min(1).max(300),
      }),
      execute: async ({ place }, config) => {
        if (!mapReady) throw new Error("The map is not ready.");
        const session = sessionNumber;
        const candidates = await locator.addressToLocations(
          "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer",
          {
            address: { SingleLine: place },
            maxLocations: 1,
            outSpatialReference: { wkid: 4326 },
          },
          { signal: config?.signal },
        );
        config?.signal?.throwIfAborted();
        if (session !== sessionNumber)
          throw new Error("Map navigation was canceled.");
        const candidate = candidates[0];
        if (!candidate?.location)
          throw new Error("No matching location was found.");
        await ui["helper-map"].view.goTo(
          candidate.extent || {
            target: candidate.location,
            zoom: 12,
          },
        );
        config?.signal?.throwIfAborted();
        if (session !== sessionNumber)
          throw new Error("Map navigation was canceled.");
        return publishResult(
          {
            title: "Map navigation",
            endpoint: "World/GeocodeServer",
          },
          {
            success: true,
            results: [
              {
                value: candidate.address,
                longitude: candidate.location.longitude,
                latitude: candidate.location.latitude,
              },
            ],
          },
        );
      },
    }),
  );
  tools.push(
    new FunctionTool({
      name: "show_locations",
      description:
        "Display explicit WGS84 coordinates from the user or a helper-service result as map markers. Do not invent coordinates from place names; geocode those instead.",
      inputSchema: z.object({
        locations: z
          .array(
            z.object({
              label: z.string().min(1).max(160),
              longitude: z.number().min(-180).max(180),
              latitude: z.number().min(-90).max(90),
            }),
          )
          .min(1)
          .max(100),
      }),
      execute: async ({ locations }, config) => {
        if (!mapReady) throw new Error("The map is not ready.");
        config?.signal?.throwIfAborted();
        const session = sessionNumber;
        const graphics = locations.map(
          (location) =>
            new Graphic({
              geometry: {
                type: "point",
                longitude: location.longitude,
                latitude: location.latitude,
              },
              attributes: {
                label: location.label,
              },
              symbol: {
                type: "simple-marker",
                color: "#00776b",
                size: 12,
                outline: {
                  color: "white",
                  width: 2,
                },
              },
              popupTemplate: {
                title: "Assistant result",
                content: [
                  {
                    type: "fields",
                    fieldInfos: [
                      {
                        fieldName: "label",
                        label: "Location",
                      },
                    ],
                  },
                ],
              },
            }),
        );
        markers.addMany(graphics);
        ui["clear-map"].disabled = false;
        try {
          await ui["helper-map"].view.goTo(
            graphics.length === 1 ? { target: graphics, zoom: 13 } : graphics,
          );
          config?.signal?.throwIfAborted();
          if (session !== sessionNumber)
            throw new Error("Map display was canceled.");
        } catch (failure) {
          markers.removeMany(graphics);
          throw failure;
        }
        return publishResult(
          {
            title: "Map locations",
            endpoint: "MapView.graphics",
          },
          {
            success: true,
            results: locations.map((location) => ({
              value: location.label,
              ...location,
            })),
          },
        );
      },
    }),
  );
  return new LLMAgent({
    name: "Helper Services",
    description:
      "Calls all eight ArcGIS AI helper services: text analysis, translation, image analysis, image text extraction, PDF analysis, embeddings, speech generation, and audio transcription. Also handles attachments, map screenshots, named-place navigation, and displaying explicit coordinates. Examples: translate this to Spanish; summarize the attached PDF; analyze the current map; transcribe my audio; generate speech; submit this embeddings JSON.",
    prompt: HELPER_AGENT_PROMPT,
    modelTier: "default",
    middlewares: [
      createAgentMiddleware("helper-chat-completions", {
        wrapModelCall: useChatCompletions,
      }),
    ],
    tools,
  });
}

function mountAssistant(agent) {
  assistant?.remove();
  assistant = document.createElement("arcgis-assistant");
  assistant.id = "helper-assistant";
  assistant.heading = "Assistant";
  assistant.copyEnabled = true;
  assistant.voiceInputEnabled = true;
  assistant.readAloudEnabled = true;
  assistant.suggestedPrompts = [
    'Translate "Welcome to San Francisco" into Spanish and French.',
    "Analyze the current map image.",
    "Summarize the attached PDF.",
  ];
  const registration = document.createElement("arcgis-assistant-agent");
  registration.agent = agent.registration;
  const footer = document.createElement("div");
  footer.slot = "footer-content";
  footer.className = "assistant-status";
  const status = document.createElement("span");
  status.textContent = "8 helper services";
  const clear = document.createElement("button");
  clear.className = "icon-button";
  clear.type = "button";
  clear.title = "New conversation";
  clear.setAttribute("aria-label", "New conversation");
  const icon = document.createElement("i");
  icon.dataset.lucide = "rotate-ccw";
  clear.append(icon);
  clear.addEventListener("click", async () => {
    cancelRequests();
    await assistant.clearChatHistory();
    showError();
    ui["task-status"].textContent = "Ready";
  });
  footer.append(status, clear);
  assistant.append(registration, footer);
  assistant.addEventListener("arcgisCancel", cancelRequests);
  assistant.addEventListener("arcgisSubmit", () => showError());
  assistant.addEventListener("arcgisError", (event) =>
    showError(
      event.detail?.message ||
        "The assistant could not complete the request. Check your ArcGIS AI access.",
    ),
  );
  assistant.addEventListener("arcgisVoiceInputError", () =>
    showError(
      "Voice input is unavailable. Check browser speech support and microphone permissions.",
    ),
  );
  ui["assistant-container"].replaceChildren(assistant);
  createIcons({
    icons,
    attrs: { "aria-hidden": "true" },
  });
}

function selectTab(name) {
  activeTab = name;
  for (const tab of ["output", "json"]) {
    const selected = name === tab;
    ui[`${tab}-tab`].setAttribute("aria-selected", String(selected));
    ui[`${tab}-tab`].tabIndex = selected ? 0 : -1;
    ui[`${tab}-panel`].hidden = !selected;
  }
}

ui.attach.addEventListener("click", () => ui["attachment-input"].click());
ui["attachment-input"].addEventListener("change", () => {
  const file = ui["attachment-input"].files?.[0];
  if (!file) return;
  try {
    setAttachment(file);
    showError();
  } catch (failure) {
    ui["attachment-input"].value = "";
    showError(failure.message);
  }
});
ui["remove-attachment"].addEventListener("click", clearAttachment);
ui["capture-map"].addEventListener("click", async () => {
  if (capturing) return;
  capturing = true;
  ui["capture-map"].disabled = true;
  const session = sessionNumber;
  try {
    const file = await mapScreenshot();
    if (session === sessionNumber) {
      setAttachment(file);
      showError();
    }
  } catch (failure) {
    showError(failure.message);
  } finally {
    capturing = false;
    ui["capture-map"].disabled = !mapReady;
  }
});
ui.basemap.addEventListener("change", () => {
  ui["helper-map"].basemap = ui.basemap.value;
});
ui["clear-map"].addEventListener("click", () => {
  markers.removeAll();
  ui["helper-map"].view?.closePopup();
  ui["clear-map"].disabled = true;
});
ui["result-selection"].addEventListener("change", renderResult);
for (const tab of ["output", "json"]) {
  ui[`${tab}-tab`].addEventListener("click", () => selectTab(tab));
  ui[`${tab}-tab`].addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "output"
        : event.key === "End"
          ? "json"
          : tab === "output"
            ? "json"
            : "output";
    selectTab(next);
    ui[`${next}-tab`].focus();
  });
}
ui["copy-result"].addEventListener("click", async () => {
  const result = selectedResult();
  if (!result) return;
  try {
    await navigator.clipboard.writeText(
      activeTab === "output" && result.text
        ? result.text
        : JSON.stringify(result.response, null, 2),
    );
    ui["task-status"].textContent = "Copied";
  } catch {
    showError(
      "Clipboard access was denied. Select the result text to copy it.",
    );
  }
});
ui["download-result"].addEventListener("click", () => {
  const result = selectedResult();
  if (!result) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result.response, null, 2)], {
      type: "application/json",
    }),
  );
  const download = document.createElement("a");
  download.href = url;
  download.download = `${result.id}.json`;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui["clear-results"].addEventListener("click", () => {
  if (confirm("Clear all service results?")) {
    cancelRequests();
    clearResults();
  }
});

function installAuthentication(agent) {
  showSignedOut();
  updateLogin();
  ui["sign-in-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (signingIn) return;
    try {
      const selected = normalizePortal(ui["portal-url"].value);
      ui["portal-url"].value = selected;
      if (selected !== portalUrl) {
        const target = new URL(location.href);
        target.searchParams.set("portal", selected);
        target.searchParams.set("signin", "1");
        location.assign(target.href);
        return;
      }
    } catch (failure) {
      showError(failure.message);
      return;
    }
    signingIn = true;
    cancelRequests();
    const attempt = ++loginAttempt;
    updateLogin("Signing in...");
    showError();
    try {
      esriConfig.portalUrl = portalUrl;
      const result = await IdentityManager.getCredential(
        `${portalUrl}/sharing`,
      );
      if (attempt !== loginAttempt) return;
      if (!result?.token || (result.expires && result.expires <= Date.now()))
        throw new Error("ArcGIS returned an expired credential.");
      const owner = `${portalUrl}|${result.userId}`;
      if (sessionOwner && sessionOwner !== owner) {
        clearAttachment();
        clearResults();
        markers.removeAll();
        ui["clear-map"].disabled = true;
      }
      sessionOwner = owner;
      credential = result;
      mountAssistant(agent);
      ui["task-status"].textContent = "Ready";
    } catch (failure) {
      if (attempt !== loginAttempt) return;
      credential = null;
      showError(
        failure.name === "identity-manager:user-aborted"
          ? "Sign-in canceled."
          : "Sign-in failed. Check your portal URL, connection, and account's sign-in policy.",
      );
    } finally {
      if (attempt === loginAttempt) {
        signingIn = false;
        updateLogin();
      }
    }
  });
  ui["sign-out"].addEventListener("click", () => {
    loginAttempt++;
    signingIn = false;
    cancelRequests();
    credential = null;
    IdentityManager.destroyCredentials();
    clearAttachment();
    clearResults();
    markers.removeAll();
    ui["clear-map"].disabled = true;
    showSignedOut();
    updateLogin();
    showError();
    window.location.reload();
  });
  if (parameters.get("signin") === "1") {
    const target = new URL(location.href);
    target.searchParams.delete("signin");
    history.replaceState(null, "", target.href);
    ui["sign-in-form"].requestSubmit();
  }
}

async function initialize() {
  await Promise.all([
    import("@arcgis/map-components/components/arcgis-map"),
    import("@arcgis/map-components/components/arcgis-zoom"),
    import("@arcgis/map-components/components/arcgis-home"),
    import("@arcgis/map-components/components/arcgis-search"),
    import("@arcgis/ai-components/components/arcgis-assistant"),
    import("@arcgis/ai-components/components/arcgis-assistant-agent"),
  ]);
  installAuthentication(createAgent());
  const mapTimer = setTimeout(() => {
    ui["map-status"].textContent = "Unavailable";
    showError(
      "The map is taking too long to load. Check your connection and WebGL support.",
    );
  }, 30_000);
  try {
    await ui["helper-map"].viewOnReady();
    mapReady = true;
    const view = ui["helper-map"].view;
    view.map.add(markers);
    view.addHandles(
      reactiveUtils.watch(
        () => [view.updating, view.stationary, view.fatalError],
        () => {
          const ready = !view.updating && view.stationary && !view.fatalError;
          ui["map-status"].textContent = view.fatalError
            ? "Unavailable"
            : ready
              ? "Ready"
              : "Drawing";
          ui["capture-map"].disabled = !ready || capturing;
        },
        { initial: true },
      ),
    );
  } catch {
    showError("Could not initialize the map. Check WebGL support and reload.");
  } finally {
    clearTimeout(mapTimer);
  }
}

window.addEventListener("pagehide", () => {
  cancelRequests();
  clearAttachment();
  releaseAudio();
});
initialize().catch((failure) => {
  showError(`Could not initialize the assistant: ${failure.message}`);
  ui["login-status"].textContent = "Unavailable";
});
