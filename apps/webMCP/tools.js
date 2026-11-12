import { FunctionTool } from "@arcgis/ai-components/agent-utils/tools/FunctionTool.js";
import { z } from "zod";

export function createFunctionTools(definitions, { signal } = {}) {
  const names = new Set();
  return definitions.map((definition) => {
    if (
      typeof definition.name !== "string" ||
      !definition.name.trim() ||
      typeof definition.execute !== "function"
    ) {
      throw new Error("A WebMCP tool needs a name and an execute callback.");
    }
    let inputSchema;
    try {
      if (definition.inputSchema?.type !== "object") {
        throw new Error("The tool needs an object input schema.");
      }
      inputSchema = z.fromJSONSchema(definition.inputSchema);
    } catch (failure) {
      throw new Error(
        `Cannot convert the input schema for "${definition.name}": ${failure.message}`,
        { cause: failure },
      );
    }
    const base = definition.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    let name = base;
    let counter = 2;
    while (names.has(name)) {
      const suffix = `_${counter++}`;
      name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    names.add(name);

    return new FunctionTool({
      name,
      description: definition.description || definition.name,
      inputSchema,
      resultMode: "continue",
      execute: async (input, config) => {
        const signals = [signal, config?.signal].filter(Boolean);
        const executionSignal = signals.length
          ? AbortSignal.any(signals)
          : undefined;
        executionSignal?.throwIfAborted();
        const result = await definition.execute(input, {
          signal: executionSignal,
        });
        executionSignal?.throwIfAborted();
        if (result?.isError) {
          const message = result.content
            ?.filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
          throw new Error(
            message || `WebMCP tool "${definition.name}" failed.`,
          );
        }
        return result;
      },
    });
  });
}
