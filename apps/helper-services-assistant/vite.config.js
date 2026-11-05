import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ command }) => ({
  root: command === "build" ? appRoot : repositoryRoot,
  base: "./",
  cacheDir: `${appRoot}node_modules/.vite`,
  optimizeDeps: {
    entries: ["apps/helper-services-assistant/index.html"],
  },
  define: {
    "import.meta.env.APP_HOME_URL": JSON.stringify(
      command === "build" ? "../../../index.html" : "../../index.html",
    ),
  },
  build: {
    outDir: `${appRoot}dist`,
    emptyOutDir: true,
  },
}));
