"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "app.js"), "utf8");

function createContext(overrides = {}) {
  const context = vm.createContext({
    document: { querySelector: () => ({}), getElementById: () => ({}) },
    window: {},
    customElements: { whenDefined: () => new Promise(() => {}) },
    setTimeout() {}, clearTimeout() {},
    Blob, AbortController, AbortSignal, btoa, URL,
    ...overrides,
  });
  vm.runInContext(source, context);
  return context;
}

test("transcription sends recorded audio and the ArcGIS token using the existing API contract", async () => {
  const requests = [];
  const context = createContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ success: true, results: [{ value: "First sentence." }, { success: true, value: "Second sentence." }] }) };
    },
  });
  const controller = new AbortController();
  const result = await context.transcribeAudioDirect(new Blob(["audio"], { type: "audio/webm;codecs=opus" }), "test-token", "en", controller.signal);
  assert.equal(result, "First sentence.\nSecond sentence.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://aiutilsdev.arcgis.com/api/audio/transcribe");
  const { options } = requests[0];
  assert.equal(options.method, "POST");
  assert.equal(options.headers["X-Esri-Authorization"], "Bearer test-token");
  assert.deepEqual(JSON.parse(options.body), { input: "data:audio/webm;base64,YXVkaW8=", inputCulture: "en" });
  assert.equal(options.signal, controller.signal);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
});

test("transcription rejects missing audio types and unsuccessful service results", async () => {
  let response;
  const context = createContext({ fetch: async () => response });
  await assert.rejects(context.transcribeAudioDirect(new Blob(["audio"]), "test-token"), /MIME type/);
  const blob = new Blob(["audio"], { type: "audio/webm" });
  response = { ok: false, status: 401 };
  await assert.rejects(context.transcribeAudioDirect(blob, "test-token"), { status: 401 });
  for (const result of [
    { error: { code: 498 } }, null, {}, { success: true, results: [] },
    { success: true, results: [{ value: 123 }] },
    { success: true, results: [{ value: "text", success: false }] },
  ]) {
    response = { ok: true, json: async () => result };
    await assert.rejects(context.transcribeAudioDirect(blob, "test-token"), /ArcGIS/);
  }
});

const flush = () => new Promise(setImmediate);

async function createDictation({ getUserMedia, fetch, audio = "audio", signedIn = true, getCredential, credential = { token: "test-token", userId: "transcriber", expires: Date.now() + 60_000 } } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  const assistant = new EventTarget();
  const entry = { localName: "arcgis-assistant-chat-entry", inputValue: "Existing draft", disabled: false, isConnected: true };
  const input = { localName: "textarea", disabled: false, readOnly: false };
  const status = { textContent: "" };
  const error = { hidden: true, textContent: "" };
  const cancel = Object.assign(new EventTarget(), { hidden: true });
  const login = { hidden: false };
  const form = new EventTarget();
  const portalInput = { value: "https://excalibur.mapsdevext.arcgis.com", disabled: false };
  const signIn = { disabled: true };
  const loginStatus = { textContent: "" };
  const account = { hidden: true };
  const username = { textContent: "" };
  const signOut = new EventTarget();
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const recorders = [];
  const requests = [];
  const authRequests = [];
  const timers = new Map();
  let microphoneCalls = 0;
  assistant.shadowRoot = { activeElement: entry };
  document.activeElement = assistant;
  document.querySelector = () => ({});
  document.getElementById = (id) => ({
    "dictation-status": status, "dictation-cancel": cancel, error,
    "dictation-login": login, "dictation-sign-in-form": form, "dictation-portal-url": portalInput,
    "dictation-sign-in": signIn, "dictation-login-status": loginStatus, "dictation-account": account,
    "dictation-username": username, "dictation-sign-out": signOut,
  })[id] || {};
  const identityManager = {
    credential,
    async getCredential(url) {
      authRequests.push(url);
      return getCredential ? getCredential(url) : this.credential;
    },
    findCredential() { throw new Error("Transcription must not use the assistant's cached credential."); },
    destroyCredentials() { throw new Error("Transcription must not clear the assistant's credentials."); },
  };
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(stream, options) {
      super();
      this.mimeType = options.mimeType;
      this.state = "inactive";
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([audio], { type: this.mimeType }) }));
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  window.MediaRecorder = Recorder;
  const context = createContext({
    document, window, queueMicrotask,
    navigator: { mediaDevices: { getUserMedia: async () => {
      microphoneCalls++;
      return getUserMedia ? getUserMedia(stream) : stream;
    } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetch ? fetch(url, options) : { ok: true, json: async () => ({ success: true, results: [{ value: "Spoken words." }] }) };
    },
    setTimeout(callback, delay) { const handle = Symbol(); timers.set(handle, { callback, delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
  });
  context.installAssistantTranscription(assistant, identityManager);
  function submitLogin() { form.dispatchEvent(new Event("submit", { cancelable: true })); }
  if (signedIn) {
    submitLogin();
    await flush();
  }
  const path = [input, entry, assistant, document, window];
  function keyboard(type, key, options = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key, code: key === " " ? "Space" : key, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false,
      composedPath: () => path, ...options,
    });
    document.dispatchEvent(event);
    return event;
  }
  return {
    context, document, window, assistant, entry, input, status, error, cancel, track, recorders, requests, identityManager,
    login, form, portalInput, signIn, loginStatus, account, username, signOut, authRequests, submitLogin,
    keyboard,
    microphoneCalls: () => microphoneCalls,
    start: () => keyboard("keydown", " "),
    release: () => keyboard("keyup", " "),
    blurInput() {
      document.activeElement = null;
      document.dispatchEvent(Object.assign(new Event("focusout"), { composedPath: () => path }));
    },
    fireTimeout(delay) {
      const timer = [...timers.values()].find((timer) => timer.delay === delay);
      assert.ok(timer, `Expected a ${delay}ms timeout`);
      timer.callback();
    },
  };
}

test("Ctrl+Space records only once, suppresses repeated spaces, and appends without submitting", async () => {
  const app = await createDictation();
  let submissions = 0;
  app.assistant.addEventListener("arcgisSubmit", () => submissions++);
  app.keyboard("keydown", "Control");
  assert.equal(app.microphoneCalls(), 0);
  assert.equal(app.start().defaultPrevented, true);
  assert.equal(app.keyboard("keydown", " ", { repeat: true }).defaultPrevented, true);
  await flush();
  assert.equal(app.microphoneCalls(), 1);
  assert.equal(app.status.textContent, "Recording");
  app.release();
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.entry.inputValue, "Existing draft Spoken words.");
  assert.equal(app.status.textContent, "Text added");
  assert.equal(app.track.stopped, true);
  assert.equal(app.cancel.hidden, true);
  assert.equal(submissions, 0);
});

test("releasing Control also ends Ctrl+Space recording", async () => {
  const app = await createDictation();
  app.entry.inputValue = "";
  app.start();
  await flush();
  app.keyboard("keyup", "Control", { ctrlKey: false });
  await flush();
  assert.equal(app.entry.inputValue, "Spoken words.");
  assert.equal(app.requests.length, 1);
});

test("the shortcut ignores other focus targets, modifiers, repeated keys, and disabled inputs", async () => {
  const app = await createDictation();
  for (const options of [
    { composedPath: () => [app.input] }, { ctrlKey: false }, { shiftKey: true },
    { altKey: true }, { metaKey: true }, { isComposing: true },
  ]) assert.equal(app.keyboard("keydown", " ", options).defaultPrevented, false);
  assert.equal(app.keyboard("keydown", " ", { repeat: true }).defaultPrevented, true);
  app.keyboard("keydown", "Shift", { shiftKey: true });
  app.keyboard("keydown", "v");
  app.entry.disabled = true;
  app.start();
  app.entry.disabled = false;
  app.input.readOnly = true;
  app.start();
  assert.equal(app.microphoneCalls(), 0);
});

test("releasing the keys before microphone permission resolves stops the late stream", async () => {
  let allowMicrophone;
  const app = await createDictation({ getUserMedia: (stream) => new Promise((resolve) => { allowMicrophone = () => resolve(stream); }) });
  app.start();
  app.release();
  allowMicrophone();
  await flush();
  assert.equal(app.track.stopped, true);
  assert.equal(app.recorders.length, 0);
  assert.equal(app.requests.length, 0);
  assert.equal(app.entry.inputValue, "Existing draft");
});

test("focus loss, Escape, window blur, navigation, and other shortcuts discard recording", async () => {
  for (const cancel of [
    (app) => app.blurInput(),
    (app) => app.keyboard("keydown", "Escape"),
    (app) => app.window.dispatchEvent(new Event("blur")),
    (app) => app.window.dispatchEvent(new Event("pagehide")),
    (app) => app.keyboard("keydown", "v"),
    (app) => { app.document.hidden = true; app.document.dispatchEvent(new Event("visibilitychange")); },
    (app) => app.cancel.dispatchEvent(new Event("click")),
  ]) {
    const app = await createDictation();
    app.start();
    await flush();
    cancel(app);
    await flush();
    assert.equal(app.track.stopped, true);
    assert.equal(app.requests.length, 0);
    assert.equal(app.entry.inputValue, "Existing draft");
    assert.equal(app.cancel.hidden, true);
  }
});

test("canceling a request prevents late text insertion and aborts its signal", async () => {
  for (const cancel of [
    (app) => app.blurInput(),
    (app) => app.keyboard("keydown", "Escape"),
    (app) => app.assistant.dispatchEvent(new Event("arcgisSubmit")),
    (app) => app.fireTimeout(60_000),
  ]) {
    let complete;
    const app = await createDictation({ fetch: () => new Promise((resolve) => { complete = resolve; }) });
    app.start();
    await flush();
    app.release();
    await flush();
    cancel(app);
    await flush();
    complete({ ok: true, json: async () => ({ success: true, results: [{ value: "Late text" }] }) });
    await flush();
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.entry.inputValue, "Existing draft");
    assert.equal(app.cancel.hidden, true);
  }
});

test("text is appended to the latest draft without overwriting edits made during transcription", async () => {
  let complete;
  const app = await createDictation({ fetch: () => new Promise((resolve) => { complete = resolve; }) });
  app.start();
  await flush();
  app.release();
  await flush();
  app.entry.inputValue = "Edited draft  ";
  complete({ ok: true, json: async () => ({ success: true, results: [{ value: "  dictated text  " }] }) });
  await flush();
  assert.equal(app.entry.inputValue, "Edited draft dictated text");
});

test("signed-out and expired sessions never start the microphone", async () => {
  for (const credential of [null, { token: "expired", expires: Date.now() - 1 }]) {
    const app = await createDictation({ credential });
    app.start();
    assert.equal(app.microphoneCalls(), 0);
    assert.equal(app.error.hidden, false);
    assert.match(app.error.textContent, /Sign in/);
  }
});

test("microphone permission denial and empty recordings keep the draft intact", async () => {
  const denied = await createDictation({ getUserMedia: async () => { throw Object.assign(new Error("Denied"), { name: "NotAllowedError" }); } });
  denied.start();
  await flush();
  assert.match(denied.error.textContent, /permission was denied/);
  assert.equal(denied.cancel.hidden, true);
  const empty = await createDictation({ audio: "" });
  empty.start();
  await flush();
  empty.release();
  await flush();
  assert.equal(empty.requests.length, 0);
  assert.match(empty.error.textContent, /No audio/);
  assert.equal(empty.entry.inputValue, "Existing draft");
});

test("recording duration is bounded and oversized recordings are discarded", async () => {
  const timed = await createDictation();
  timed.start();
  await flush();
  timed.fireTimeout(120_000);
  await flush();
  assert.equal(timed.track.stopped, true);
  assert.equal(timed.requests.length, 1);
  const oversized = await createDictation();
  oversized.start();
  await flush();
  oversized.recorders[0].dispatchEvent(Object.assign(new Event("dataavailable"), { data: { size: 10 * 1024 * 1024 + 1 } }));
  await flush();
  assert.equal(oversized.requests.length, 0);
  assert.equal(oversized.track.stopped, true);
  assert.match(oversized.error.textContent, /10 MiB/);
});

test("transcription login obtains its own portal token and uses it for the request", async () => {
  const app = await createDictation({ signedIn: false });
  assert.equal(app.signIn.disabled, false);
  assert.equal(app.login.hidden, false);
  app.portalInput.value = " https://excalibur.mapsdevext.arcgis.com/sharing/rest/ ";
  app.submitLogin();
  assert.equal(app.signIn.disabled, true);
  assert.equal(app.portalInput.disabled, true);
  await flush();
  assert.deepEqual(app.authRequests, ["https://excalibur.mapsdevext.arcgis.com/sharing"]);
  assert.equal(app.portalInput.value, "https://excalibur.mapsdevext.arcgis.com");
  assert.equal(app.login.hidden, true);
  assert.equal(app.account.hidden, false);
  assert.equal(app.username.textContent, "Transcription: transcriber");
  app.start();
  await flush();
  app.release();
  await flush();
  assert.equal(app.requests[0].options.headers["X-Esri-Authorization"], "Bearer test-token");
});

test("invalid portal URLs never invoke ArcGIS sign-in", async () => {
  const app = await createDictation({ signedIn: false });
  for (const url of ["not a URL", "http://example.com", "https://user:password@example.com", "https://example.com?token=test", "https://example.com#fragment"]) {
    app.portalInput.value = url;
    app.submitLogin();
    await flush();
    assert.equal(app.authRequests.length, 0);
    assert.equal(app.login.hidden, false);
    assert.match(app.error.textContent, /HTTPS portal URL/);
  }
});

test("failed and canceled sign-in remain retryable without a transcription credential", async () => {
  for (const name of ["identity-manager:user-aborted", "Error"]) {
    const app = await createDictation({ getCredential: async () => { throw Object.assign(new Error("Sign-in failed"), { name }); } });
    assert.equal(app.login.hidden, false);
    assert.equal(app.account.hidden, true);
    assert.equal(app.signIn.disabled, false);
    assert.equal(app.portalInput.disabled, false);
    assert.match(app.loginStatus.textContent, name === "Error" ? /Sign-in failed/ : /Sign-in canceled/);
    app.start();
    assert.equal(app.microphoneCalls(), 0);
  }
});

test("disconnecting stops recording and forgets only the transcription login", async () => {
  const app = await createDictation();
  app.start();
  await flush();
  app.signOut.dispatchEvent(new Event("click"));
  await flush();
  assert.equal(app.track.stopped, true);
  assert.equal(app.requests.length, 0);
  assert.equal(app.login.hidden, false);
  assert.equal(app.account.hidden, true);
  assert.equal(app.username.textContent, "");
  app.start();
  assert.equal(app.microphoneCalls(), 1);
  assert.equal(app.identityManager.credential.token, "test-token");
});

test("disconnecting aborts an in-flight request and prevents late insertion", async () => {
  let complete;
  const app = await createDictation({ fetch: () => new Promise((resolve) => { complete = resolve; }) });
  app.start();
  await flush();
  app.release();
  await flush();
  app.signOut.dispatchEvent(new Event("click"));
  complete({ ok: true, json: async () => ({ success: true, results: [{ value: "Late text" }] }) });
  await flush();
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.entry.inputValue, "Existing draft");
  assert.equal(app.login.hidden, false);
});

test("an expired or rejected transcription token returns to the login form", async () => {
  const expired = await createDictation();
  expired.identityManager.credential.expires = Date.now() - 1;
  expired.start();
  assert.equal(expired.microphoneCalls(), 0);
  assert.equal(expired.login.hidden, false);
  for (const status of [401, 498, 499]) {
    const app = await createDictation({ fetch: async () => ({ ok: false, status }) });
    app.start();
    await flush();
    app.release();
    await flush();
    assert.equal(app.login.hidden, false);
    assert.equal(app.account.hidden, true);
    assert.match(app.error.textContent, /rejected the transcription token/);
    assert.equal(app.entry.inputValue, "Existing draft");
  }
});

test("leaving the page ignores a late sign-in result", async () => {
  let complete;
  const app = await createDictation({ signedIn: false, getCredential: () => new Promise((resolve) => { complete = resolve; }) });
  app.submitLogin();
  app.submitLogin();
  assert.equal(app.authRequests.length, 1);
  app.window.dispatchEvent(new Event("pagehide"));
  complete({ token: "late-token", userId: "late-user" });
  await flush();
  assert.equal(app.login.hidden, false);
  assert.equal(app.account.hidden, true);
  assert.equal(app.signIn.disabled, false);
  app.start();
  assert.equal(app.microphoneCalls(), 0);
});