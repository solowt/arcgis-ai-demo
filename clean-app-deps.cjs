const { lstatSync, realpathSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const root = realpathSync(__dirname);
for (const app of ["helper-services-assistant", "mcp", "webMCP"]) {
  const appRoot = join(root, "apps", app);
  if (!lstatSync(appRoot, { throwIfNoEntry: false })) continue;
  if (realpathSync(appRoot) !== appRoot) {
    throw new Error(
      `Refusing to clean dependencies through a symlinked app directory: ${appRoot}`,
    );
  }
  console.log(`Cleaning legacy dependencies in apps/${app}`);
  rmSync(join(appRoot, "node_modules"), { recursive: true, force: true });
  rmSync(join(appRoot, "package-lock.json"), { force: true });
}
