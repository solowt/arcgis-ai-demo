import { z } from "zod";

export const BASEMAPS = [
  { id: "satellite", label: "Imagery" },
  { id: "hybrid", label: "Imagery with labels" },
  { id: "streets-vector", label: "Streets" },
  { id: "topo-vector", label: "Topographic" },
  { id: "gray-vector", label: "Light gray" },
  { id: "dark-gray-vector", label: "Dark gray" },
  { id: "osm", label: "OpenStreetMap" },
];

function normalizeFeatureLayerUrl(value) {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/FeatureServer\/\d+\/?$/i.test(url.pathname)
  ) {
    throw new Error(
      "Enter an HTTPS FeatureServer layer URL ending in /FeatureServer/<layerId>, without credentials, a query, or a fragment. HTTP is allowed only on localhost.",
    );
  }
  url.pathname = url.pathname
    .replace(/\/rest\/admin\/services\//i, "/rest/services/")
    .replace(/\/$/, "");
  return url.href;
}

export function createWebMcpDefinitions({
  setPanelOpen,
  setBasemap,
  addFeatureLayer,
  signal,
  onActivity = () => {},
}) {
  const definitions = [
    {
      name: "set_panel_visibility",
      description:
        "Open or close the demo flyout panel. This does not hide the assistant or the map. Set open to true to open the panel, or false to close it.",
      inputSchema: {
        type: "object",
        properties: {
          open: {
            type: "boolean",
            description: "Whether the demo flyout panel should be open.",
          },
        },
        required: ["open"],
        additionalProperties: false,
      },
      execute: async ({ open }) => {
        await setPanelOpen(open);
        return {
          content: [
            {
              type: "text",
              text: `The demo panel is ${open ? "open" : "closed"}.`,
            },
          ],
          structuredContent: { open },
        };
      },
    },
    {
      name: "set_basemap",
      description:
        "Change the Esri MapView basemap without changing its extent. Choose one of the supported basemap IDs; satellite means imagery.",
      inputSchema: {
        type: "object",
        properties: {
          basemap: {
            type: "string",
            enum: BASEMAPS.map(({ id }) => id),
            description: BASEMAPS.map(
              ({ id, label }) => `${id}: ${label}`,
            ).join("; "),
          },
        },
        required: ["basemap"],
        additionalProperties: false,
      },
      execute: async ({ basemap }, options) => {
        await setBasemap(basemap, options);
        return {
          content: [{ type: "text", text: `The basemap is now ${basemap}.` }],
          structuredContent: { basemap },
        };
      },
    },
    {
      name: "add_feature_layer",
      description:
        "Add a feature layer from a supplied ArcGIS FeatureServer layer URL and zoom to the extent of all features in that layer. The URL must end in /FeatureServer/<layerId>, not the service root. Administrative REST URLs are converted to their data endpoints. This does not edit the service's data.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            format: "uri",
            minLength: 1,
            description:
              "HTTPS feature layer URL, for example https://example.com/arcgis/rest/services/Hosted/places/FeatureServer/0. Do not include tokens or other query parameters.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async ({ url }, options) => {
        const result = await addFeatureLayer(
          normalizeFeatureLayerUrl(url),
          options,
        );
        return {
          content: [
            {
              type: "text",
              text: `Added "${result.title}" and zoomed to the extent of all its features.`,
            },
          ],
          structuredContent: result,
        };
      },
    },
  ];

  return definitions.map((definition) => {
    const schema = z.fromJSONSchema(definition.inputSchema);
    return {
      ...definition,
      async execute(input, options = {}) {
        const signals = [signal, options.signal].filter(Boolean);
        const executionSignal = signals.length
          ? AbortSignal.any(signals)
          : undefined;
        try {
          executionSignal?.throwIfAborted();
          // Browser callers also need validation; registration is not validation.
          const arguments_ = schema.parse(input);
          onActivity({ name: definition.name, status: "running" });
          const result = await definition.execute(arguments_, {
            ...options,
            signal: executionSignal,
          });
          executionSignal?.throwIfAborted();
          onActivity({ name: definition.name, status: "complete", result });
          return result;
        } catch (error) {
          onActivity({
            name: definition.name,
            status:
              executionSignal?.aborted || error.name === "AbortError"
                ? "canceled"
                : "error",
            error,
          });
          throw error;
        }
      },
    };
  });
}

export async function registerWebMcpTools(definitions, modelContext) {
  if (typeof modelContext?.registerTool !== "function") {
    throw new Error(
      "This browser does not expose the WebMCP registration API.",
    );
  }
  const controller = new AbortController();
  const registered = [];
  async function unregister() {
    controller.abort();
    const failures = [];
    for (const name of registered.splice(0).reverse()) {
      if (typeof modelContext.unregisterTool !== "function") continue;
      try {
        // Preview implementations use unregisterTool instead of a signal.
        await modelContext.unregisterTool(name);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Could not unregister WebMCP tools.");
    }
  }
  try {
    for (const definition of definitions) {
      await modelContext.registerTool(definition, {
        signal: controller.signal,
      });
      registered.push(definition.name);
    }
  } catch (failure) {
    try {
      await unregister();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "WebMCP registration and cleanup failed.",
      );
    }
    throw failure;
  }
  return unregister;
}
