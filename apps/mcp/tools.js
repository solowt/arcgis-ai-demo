import { FunctionTool } from "@arcgis/ai-components/agent-utils/tools/FunctionTool.js";
import { z } from "zod";

function convertInputSchema(schema) {
  const { dependentRequired, ...compatibleSchema } = schema;
  const inputSchema = z.fromJSONSchema(compatibleSchema);
  if (dependentRequired === undefined) return { inputSchema, requirements: "" };
  if (
    !dependentRequired ||
    typeof dependentRequired !== "object" ||
    Array.isArray(dependentRequired) ||
    Object.values(dependentRequired).some(
      (fields) =>
        !Array.isArray(fields) ||
        fields.some((field) => typeof field !== "string") ||
        new Set(fields).size !== fields.length,
    )
  ) {
    throw new Error(
      "dependentRequired must map property names to arrays of unique property names.",
    );
  }
  const dependencies = Object.entries(dependentRequired);
  return {
    inputSchema: inputSchema.superRefine((input, context) => {
      for (const [property, fields] of dependencies) {
        if (!Object.hasOwn(input, property) || input[property] === undefined)
          continue;
        for (const field of fields) {
          if (!Object.hasOwn(input, field) || input[field] === undefined) {
            context.addIssue({
              code: "custom",
              path: [field],
              message: `${field} is required when ${property} is provided.`,
            });
          }
        }
      }
    }),
    requirements: dependencies
      .filter(([, fields]) => fields.length)
      .map(
        ([property, fields]) =>
          `When ${JSON.stringify(property)} is provided, also provide ${fields.map((field) => JSON.stringify(field)).join(", ")}.`,
      )
      .join("\n"),
  };
}

export function createMcpTools(
  definitions,
  client,
  { signal, onActivity = () => {}, onUnsupported } = {},
) {
  const names = new Set();
  return definitions.flatMap((definition) => {
    let inputSchema;
    let requirements;
    try {
      if (!definition.name?.trim()) {
        throw new Error("The MCP server returned a tool without a name.");
      }
      if (definition.inputSchema?.type !== "object") {
        throw new Error("The tool needs an object input schema.");
      }
      ({ inputSchema, requirements } = convertInputSchema(
        definition.inputSchema,
      ));
    } catch (failure) {
      const error = new Error(
        `Cannot convert the input schema for "${definition.name || "(unnamed)"}": ${failure.message}`,
        { cause: failure },
      );
      if (!onUnsupported) throw error;
      onUnsupported({ definition, error });
      return [];
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
      description: [
        definition.description || definition.title || definition.name,
        requirements,
      ]
        .filter(Boolean)
        .join("\n\n"),
      inputSchema,
      resultMode: "continue",
      execute: async (input, config) => {
        const signals = [signal, config?.signal].filter(Boolean);
        const requestSignal = signals.length
          ? AbortSignal.any(signals)
          : undefined;
        requestSignal?.throwIfAborted();
        onActivity({ name: definition.name, status: "running" });
        try {
          const result = await client.callTool(
            { name: definition.name, arguments: input },
            undefined,
            { signal: requestSignal, timeout: 60_000 },
          );
          requestSignal?.throwIfAborted();
          if (result.isError) {
            const message = result.content
              ?.filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
            throw new Error(message || `MCP tool "${definition.name}" failed.`);
          }
          onActivity({ name: definition.name, status: "complete" });
          return result;
        } catch (failure) {
          onActivity({ name: definition.name, status: "error" });
          throw failure;
        }
      },
    });
  });
}
