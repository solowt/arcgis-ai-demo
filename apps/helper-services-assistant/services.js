export const HELPER_SERVICES = Object.freeze([
  {
    name: "analyze_text",
    title: "Text analysis",
    endpoint: "text/analyze",
  },
  {
    name: "translate_text",
    title: "Text translation",
    endpoint: "text/translate",
  },
  {
    name: "analyze_image",
    title: "Image analysis",
    endpoint: "image/analyze",
  },
  {
    name: "extract_image_text",
    title: "Image text extraction",
    endpoint: "image/extractText",
  },
  {
    name: "analyze_file",
    title: "File analysis",
    endpoint: "file/analyze",
  },
  {
    name: "generate_embeddings",
    title: "Embeddings",
    endpoint: "embeddings",
  },
  {
    name: "generate_speech",
    title: "Speech generation",
    endpoint: "audio/speech",
  },
  {
    name: "transcribe_audio",
    title: "Audio transcription",
    endpoint: "audio/transcribe",
  },
]);

export async function encodeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function createMediaInput(media) {
  if (typeof media === "string") {
    const url = new URL(media);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(
        "Media URLs must use HTTPS and must not contain credentials.",
      );
    }
    return url.href;
  }
  if (!(media instanceof Blob) || !media.size)
    throw new Error("Select a nonempty media file.");
  const mediaType = media.type.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType) throw new Error("The media is missing its MIME type.");
  if (media.size > 10 * 1024 * 1024)
    throw new Error("The media exceeds 10 MiB.");
  return `data:${mediaType};base64,${await encodeBlob(media)}`;
}

export async function requestHelperService(
  name,
  payload,
  token,
  { signal, fetchImpl = fetch } = {},
) {
  const service = HELPER_SERVICES.find((candidate) => candidate.name === name);
  if (!service) throw new Error("Unknown helper service.");
  if (!token)
    throw new Error("Sign in with ArcGIS before using helper services.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Provide a helper service request object.");
  }
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetchImpl(
    `https://aiutilsdev.arcgis.com/api/${service.endpoint}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Esri-Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "origin",
    },
  );
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `ArcGIS ${service.title.toLowerCase()} failed (${response.status}).`,
      ),
      {
        status: response.status,
      },
    );
  }
  const contentType = response.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (
    name === "generate_speech" &&
    (mediaType.startsWith("audio/") || mediaType === "application/octet-stream")
  ) {
    const audio = await response.blob();
    if (!audio.size) throw new Error("ArcGIS returned empty audio.");
    return {
      success: true,
      meta: {
        contentType,
        contentLength: response.headers.get("content-length"),
      },
      results: [
        {
          success: true,
          key: "key:1",
          value: await encodeBlob(audio),
        },
      ],
    };
  }
  const result = await response.json().catch(() => null);
  if (result?.error != null) {
    throw Object.assign(
      new Error("The ArcGIS helper service rejected the request."),
      {
        status: Number(result.error.code),
      },
    );
  }
  if (
    result?.success !== true ||
    result.results?.some?.((entry) => entry?.success === false)
  ) {
    throw new Error(
      "ArcGIS did not return a successful helper service result.",
    );
  }
  if (
    name !== "generate_embeddings" &&
    (!Array.isArray(result.results) ||
      !result.results.length ||
      result.results.some((entry) => {
        if (!entry || (entry.success !== undefined && entry.success !== true))
          return true;
        if (name === "translate_text") {
          return (
            !Array.isArray(entry.translations) ||
            !entry.translations.length ||
            entry.translations.some(
              (translation) =>
                typeof translation?.text !== "string" ||
                typeof translation?.to !== "string" ||
                !translation.to,
            )
          );
        }
        return (
          entry.value == null ||
          (name === "transcribe_audio" && typeof entry.value !== "string")
        );
      }))
  ) {
    throw new Error(
      "ArcGIS did not return a successful helper service result.",
    );
  }
  return result;
}

export function resultText(result) {
  if (!Array.isArray(result?.results)) return "";
  return result.results
    .map((entry) => {
      if (Array.isArray(entry?.translations)) {
        return entry.translations
          .map((translation) => `${translation.to}: ${translation.text}`)
          .join("\n");
      }
      return entry?.value == null
        ? ""
        : typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value, null, 2);
    })
    .filter(Boolean)
    .join("\n");
}

export function decodeSpeechAudio(
  value,
  contentType = "application/octet-stream",
) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("ArcGIS returned empty audio.");
  let encoded = value.trim();
  let mediaType = contentType;
  if (encoded.toLowerCase().startsWith("data:")) {
    const separator = encoded.indexOf(",");
    const parts = encoded.slice(5, separator).split(";");
    if (separator < 0 || parts.at(-1).toLowerCase() !== "base64")
      throw new Error("ArcGIS returned an invalid audio data URL.");
    mediaType = parts[0];
    encoded = encoded.slice(separator + 1);
  }
  mediaType = mediaType.split(";", 1)[0].trim().toLowerCase();
  if (
    !mediaType.startsWith("audio/") &&
    mediaType !== "application/octet-stream"
  )
    throw new Error("ArcGIS returned a non-audio content type.");
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("ArcGIS returned invalid base64 audio.");
  }
  if (!binary.length) throw new Error("ArcGIS returned empty audio.");
  return new Blob(
    [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
    { type: mediaType },
  );
}
