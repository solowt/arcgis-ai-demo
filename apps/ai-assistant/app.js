"use strict";

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
  if (result?.success !== true || !Array.isArray(result.results) || !result.results.length) {
    throw new Error("ArcGIS did not return a successful transcription.");
  }
  const segments = result.results.map((segment) => {
    if (typeof segment?.value !== "string" || (segment.success !== undefined && segment.success !== true)) {
      throw new Error("ArcGIS returned an unsuccessful audio result.");
    }
    return segment.value;
  });
  return segments.join("\n");
}

function installAssistantTranscription(assistant, identityManager) {
  const status = document.getElementById("dictation-status");
  const cancel = document.getElementById("dictation-cancel");
  const error = document.getElementById("error");
  const login = document.getElementById("dictation-login");
  const form = document.getElementById("dictation-sign-in-form");
  const portalInput = document.getElementById("dictation-portal-url");
  const signIn = document.getElementById("dictation-sign-in");
  const loginStatus = document.getElementById("dictation-login-status");
  const account = document.getElementById("dictation-account");
  const username = document.getElementById("dictation-username");
  const signOut = document.getElementById("dictation-sign-out");
  let activeSession = null;
  let credential = null;
  let signingIn = false;
  let loginAttempt = 0;

  function update(message = "") {
    status.textContent = message;
    cancel.hidden = !activeSession;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function currentCredential() {
    return credential?.token && (!credential.expires || credential.expires > Date.now()) ? credential : null;
  }

  function updateLogin(message = "") {
    const signedIn = Boolean(currentCredential());
    login.hidden = signedIn;
    account.hidden = !signedIn;
    username.textContent = signedIn ? `Transcription: ${credential.userId || "Signed in"}` : "";
    signIn.disabled = signingIn;
    portalInput.disabled = signingIn;
    loginStatus.textContent = message;
  }

  function disconnect() {
    loginAttempt++;
    credential = null;
    signingIn = false;
    cancelWork();
    updateLogin();
    update("Sign in required");
  }

  function requireSignIn(message) {
    disconnect();
    showError(message);
  }

  function stopMedia(session) {
    clearTimeout(session.recordingTimeout);
    session.stream?.getTracks().forEach((track) => track.stop());
  }

  function finish(session, message = "") {
    stopMedia(session);
    clearTimeout(session.requestTimeout);
    if (activeSession !== session) return;
    activeSession = null;
    update(message);
  }

  function cancelWork() {
    const session = activeSession;
    if (!session) return;
    activeSession = null;
    session.controller?.abort();
    if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
    finish(session);
    update("Canceled");
  }

  async function transcribe(session) {
    let message = "";
    try {
      if (currentCredential()?.token !== session.token) {
        requireSignIn("Your transcription session expired. Sign in again before recording.");
        return;
      }
      const blob = new Blob(session.chunks, { type: session.recorder.mimeType });
      session.chunks = [];
      if (!blob.size) throw new Error("No audio was captured. Hold the keys a little longer.");
      session.phase = "transcribing";
      session.controller = new AbortController();
      session.requestTimeout = setTimeout(() => {
        if (activeSession !== session) return;
        cancelWork();
        showError("The transcription request timed out. Try a shorter recording.");
      }, 60_000);
      update("Transcribing...");
      const text = (await transcribeAudioDirect(blob, session.token, "en", session.controller.signal)).trim();
      if (activeSession !== session || session.controller.signal.aborted) return;
      if (currentCredential()?.token !== session.token) {
        requireSignIn("Your transcription session expired. Sign in again before recording.");
        return;
      }
      if (!session.entry.isConnected || session.entry.disabled) {
        message = "Canceled";
        return;
      }
      if (text) {
        const existing = session.entry.inputValue.trimEnd();
        session.entry.inputValue = existing ? `${existing} ${text}` : text;
      }
      message = text ? "Text added" : "No speech detected";
    } catch (failure) {
      if (activeSession !== session || session.controller?.signal.aborted) return;
      if ([401, 498, 499].includes(failure.status)) {
        requireSignIn("ArcGIS rejected the transcription token. Sign in again before recording.");
        return;
      }
      showError(failure.message || "The transcription request failed.");
      message = "Transcription failed";
    } finally {
      finish(session, message);
    }
  }

  function stopRecording() {
    const session = activeSession;
    if (!session || !["permission", "recording"].includes(session.phase)) return;
    if (!session.recorder) {
      cancelWork();
      return;
    }
    session.phase = "stopping";
    update("Finishing recording...");
    if (session.recorder.state !== "inactive") session.recorder.stop();
    stopMedia(session);
  }

  async function startRecording(entry) {
    if (activeSession) return;
    const credential = currentCredential();
    if (!credential) {
      requireSignIn("Sign in for transcription before recording.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showError("Audio recording is unavailable. Use a supported browser with microphone access.");
      return;
    }
    const session = { entry, token: credential.token, phase: "permission", chunks: [], bytes: 0 };
    activeSession = session;
    error.hidden = true;
    update("Requesting microphone...");
    try {
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find(
        (type) => window.MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) throw new Error("This browser does not support a suitable audio recording format.");
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (activeSession !== session || !entry.isConnected || entry.disabled || currentCredential()?.token !== session.token) {
        finish(session);
        return;
      }
      session.recorder = new window.MediaRecorder(session.stream, { mimeType, audioBitsPerSecond: 64000 });
      session.recorder.addEventListener("dataavailable", (event) => {
        if (activeSession !== session || !event.data.size) return;
        session.bytes += event.data.size;
        if (session.bytes > 10 * 1024 * 1024) {
          cancelWork();
          showError("The recording exceeded 10 MiB and was discarded. Try a shorter recording.");
        } else {
          session.chunks.push(event.data);
        }
      });
      session.recorder.addEventListener("error", () => {
        if (activeSession !== session) return;
        cancelWork();
        showError("The microphone recording failed. Check your audio device and try again.");
      });
      session.recorder.addEventListener("stop", () => {
        stopMedia(session);
        if (activeSession === session) void transcribe(session);
      }, { once: true });
      session.recorder.start(1000);
      session.phase = "recording";
      session.recordingTimeout = setTimeout(stopRecording, 120_000);
      update("Recording");
    } catch (failure) {
      stopMedia(session);
      if (activeSession !== session) return;
      const messages = {
        NotAllowedError: "Microphone permission was denied. Allow microphone access in your browser's site settings.",
        NotFoundError: "No microphone was found. Connect an audio input device and try again.",
        NotReadableError: "The microphone is unavailable. Check whether another application is using it.",
      };
      showError(messages[failure.name] || failure.message || "Audio recording could not start.");
      finish(session, "Recording failed");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (signingIn) return;
    let portal;
    try {
      portal = new URL(portalInput.value.trim());
      if (portal.protocol !== "https:" || portal.username || portal.password || portal.search || portal.hash) throw new Error();
      portal.pathname = portal.pathname.replace(/\/sharing(?:\/rest)?\/?$/i, "").replace(/\/+$/, "");
    } catch {
      showError("Enter an HTTPS portal URL without credentials, a query, or a fragment.");
      return;
    }
    const portalUrl = portal.href.replace(/\/$/, "");
    portalInput.value = portalUrl;
    cancelWork();
    credential = null;
    signingIn = true;
    const attempt = ++loginAttempt;
    error.hidden = true;
    updateLogin("Signing in...");
    try {
      const result = await identityManager.getCredential(`${portalUrl}/sharing`);
      if (attempt !== loginAttempt) return;
      if (!result?.token || (result.expires && result.expires <= Date.now())) throw new Error();
      credential = result;
      updateLogin();
      update("Ready");
    } catch (failure) {
      if (attempt !== loginAttempt) return;
      credential = null;
      const message = failure.name === "identity-manager:user-aborted"
        ? "Sign-in canceled."
        : "Sign-in failed. Check your portal URL, connection, and account's sign-in policy.";
      updateLogin(message);
      showError(message);
    } finally {
      if (attempt === loginAttempt) {
        signingIn = false;
        updateLogin(loginStatus.textContent);
      }
    }
  });
  signOut.addEventListener("click", disconnect);

  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && activeSession) {
      event.preventDefault();
      cancelWork();
      return;
    }
    const shortcut = event.ctrlKey && event.code === "Space" && !event.shiftKey && !event.altKey && !event.metaKey;
    if (activeSession) {
      if (shortcut) event.preventDefault();
      else if (["permission", "recording"].includes(activeSession.phase) && event.key !== "Control") cancelWork();
      return;
    }
    if (!shortcut) return;
    const path = event.composedPath();
    const entry = path.find((element) => element.localName === "arcgis-assistant-chat-entry");
    const input = path.find((element) => element.localName === "textarea");
    if (!path.includes(assistant) || !entry || entry.disabled || !input || input.disabled || input.readOnly) return;
    event.preventDefault();
    if (!event.repeat) void startRecording(entry);
  }, true);

  document.addEventListener("keyup", (event) => {
    if (activeSession && (event.code === "Space" || event.key === "Control")) {
      if (event.code === "Space") event.preventDefault();
      stopRecording();
    }
  }, true);
  document.addEventListener("focusout", (event) => {
    const session = activeSession;
    if (!session || !event.composedPath().includes(session.entry)) return;
    queueMicrotask(() => {
      let focused = document.activeElement;
      while (focused && focused !== session.entry) focused = focused.shadowRoot?.activeElement;
      if (activeSession === session && !focused) cancelWork();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelWork();
  });
  window.addEventListener("blur", cancelWork);
  window.addEventListener("pagehide", disconnect);
  assistant.addEventListener("arcgisSubmit", cancelWork);
  cancel.addEventListener("click", cancelWork);
  updateLogin();
}

(async () => {
  const map = document.querySelector("arcgis-map");
  const assistant = document.querySelector("arcgis-assistant");
  const panel = document.getElementById("assistant-panel");
  const status = document.getElementById("load-status");
  const error = document.getElementById("error");

  function showError() {
    status.hidden = true;
    error.textContent = "Could not load the map and assistant. Check your connection and WebGL support, then reload the page.";
    error.hidden = false;
  }

  window.lucide?.createIcons();
  const loadTimeout = setTimeout(showError, 30_000);
  try {
    await Promise.all(["arcgis-map", "arcgis-assistant", "arcgis-expand"].map((tag) => customElements.whenDefined(tag)));
    const identityManager = await window.$arcgis.import("@arcgis/core/identity/IdentityManager.js");
    installAssistantTranscription(assistant, identityManager);
    await Promise.all([map.viewOnReady(), assistant.componentOnReady(), panel.componentOnReady()]);
    panel.expanded = window.matchMedia("(min-width: 720px)").matches;
    status.hidden = true;
    error.hidden = true;
  } catch {
    showError();
  } finally {
    clearTimeout(loadTimeout);
  }
})();