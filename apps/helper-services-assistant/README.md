# Helper Services Assistant

One `arcgis-assistant` with an Esri `LLMAgent` and `FunctionTool` registration for each endpoint in AI Services:

| Tool                  | Endpoint            |
| --------------------- | ------------------- |
| Text analysis         | `text/analyze`      |
| Text translation      | `text/translate`    |
| Image analysis        | `image/analyze`     |
| Image text extraction | `image/extractText` |
| File analysis         | `file/analyze`      |
| Embeddings            | `embeddings`        |
| Speech generation     | `audio/speech`      |
| Audio transcription   | `audio/transcribe`  |

## Run

From the repository root:

```sh
npm --prefix apps/helper-services-assistant ci
npm --prefix apps/helper-services-assistant run dev
```

Open `http://127.0.0.1:5173/apps/helper-services-assistant/index.html` (use the port Vite prints if 5173 is occupied). Vite serves the repository root, so the existing app launcher and other apps remain available. The launcher opens the production build; use this direct source URL for live development.

Custom agents require Esri's npm packages. This app cannot run directly from `file://` or an unbuilt static source tree. Existing apps are unchanged.

## Access And Data

- Sign in with an ArcGIS organization account authorized to use AI assistants and the helper services. The portal form follows AI Services: normalize the HTTPS URL, call `IdentityManager.getCredential`, and enable the assistant only after successful login. A portal change reloads the app before SDK initialization to keep the assistant and helper tools on the same portal.
- Helper requests use `https://aiutilsdev.arcgis.com/api/`, matching AI Services. This is a development service; access depends on your account and environment. Assistant orchestration uses Esri's SDK-managed AI service.
- The helper agent selects the SDK model's Chat Completions transport through an Esri model-call middleware. This avoids replaying encrypted Responses API reasoning after tool execution, which can be rejected by the model gateway. The model, Esri authentication, streaming, and tool chaining are preserved; the model gateway must support `/chat/completions`.
- Credentials stay in memory and are used only in request headers. They are not tool arguments or model context. Sign-out calls `IdentityManager.destroyCredentials`, clears the conversation, results, attachments, and markers, then reloads, matching AI Services. Expired or rejected credentials require sign-in again.
- Selecting a file does not upload it. A requested tool sends it to its helper service. Text returned by tools can enter the assistant's conversation and model context. Do not submit data your organization's policies prohibit sending to those services.
- Images, PDFs, audio, and JSON attachments are limited to 10 MiB. Image tools also accept the current map screenshot. HTTPS media URLs are accepted when supplied in a prompt.
- Embeddings preserve a user-provided JSON request object, either in chat or a JSON attachment. The app does not assume a model-specific embeddings schema.
- Native voice input uses browser speech recognition, where supported, with microphone permission in a secure context. Read-aloud uses browser speech synthesis. Browser speech recognition may use a browser-vendor service. The separate ArcGIS audio tools support uploaded audio transcription and downloadable speech generation.
- Map tools use ArcGIS geocoding for named places and explicit WGS84 coordinates for markers. This custom agent does not require a prepared web map or an embeddings resource.

## Verify And Build

```sh
npm --prefix apps/helper-services-assistant test
npm --prefix apps/helper-services-assistant run build
npm --prefix apps/helper-services-assistant run preview
```

Tests cover all eight request contracts, registered tool callbacks, result publication, attachment metadata, cancellation, authentication expiry, and error handling. Callback tests mock the SDK classes and browser DOM. A separate regression uses the SDK's installed LangChain dependencies to verify streamed and non-streamed model/tool/model round trips with mocked model responses. Authenticated LLM orchestration still needs an authorized account for a live end-to-end test.

The build creates `apps/helper-services-assistant/dist/index.html` and its adjacent `assets` directory. The root launcher links directly to that built entry. Source files remain outside `dist`, and the app's home link resolves to the root launcher in both development and production.

Preview serves the repository root as a static site. Open `/index.html` on the printed preview URL (normally `http://127.0.0.1:4173/index.html`), then choose Helper Services Assistant. The other static apps and return navigation remain available. Run the build again after source changes to refresh this preview.

For deployment, retain the repository's static-site layout and include the generated `apps/helper-services-assistant/dist` directory. It is ignored by Git, so deployment must build the app and publish that output; no manual merging or relocation of bundled assets is needed. Serve the site over HTTP(S), including when it is hosted under a URL subdirectory. Fonts, basemaps, SDK runtime assets, and AI services require network access.

The root [SSH deployment script](../../README.md#deploy-over-ssh) uploads the whole project, installs dependencies, and builds this app on the remote Linux machine while preserving that layout.

## References

- [AI components](https://developers.arcgis.com/javascript/latest/references/ai-components/)
- [Custom agents](https://developers.arcgis.com/javascript/latest/agentic-apps/ai-custom-agents/)
- [LLMAgent](https://developers.arcgis.com/javascript/latest/references/ai-components/agent-utils/LLMAgent/)
- [FunctionTool](https://developers.arcgis.com/javascript/latest/references/ai-components/agent-utils/tools/FunctionTool/)
