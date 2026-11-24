# ArcGIS AI Demo

A static app launcher and ArcGIS AI demos. Most apps are plain HTML, CSS, and
JavaScript; [Helper Services Assistant](apps/helper-services-assistant/README.md),
[MCP Assistant](apps/mcp/README.md), and [webMCP](apps/webMCP/README.md) use npm
dependencies and Vite builds. The webMCP demo exposes panel, basemap, and
feature-layer actions to browser agents and the ArcGIS assistant through shared
tool definitions.

## Install and build

Requires Node.js 22.12+ and npm. The three npm-based apps are workspaces sharing
the root `package.json`, `package-lock.json`, and `node_modules`. Dependency
versions are maintained only at the root; app manifests retain their own scripts.

From the repository root:

```sh
npm ci --include=dev
npm run build
```

The single build command builds all three apps into their existing
`apps/<app>/dist` directories. To run one app's development server or scripts:

```sh
npm run dev --workspace apps/webMCP
npm run build --workspace apps/mcp
npm test --workspaces
```

Use the corresponding workspace path for the helper-services assistant. Install
dependencies only from the root, not separately inside apps. After changing root
dependencies, use `npm install --include=dev` to update the shared lockfile.

The root install hook runs [clean-app-deps.cjs](clean-app-deps.cjs), which removes
legacy `node_modules` directories and app-level lockfiles from exactly
`apps/helper-services-assistant`, `apps/mcp`, and `apps/webMCP`. It leaves source
files, built output, other apps, and the root dependencies alone, and refuses
symlinked app directories. Vite caches now live under root
`node_modules/.vite/<app>` so development does not recreate app-level installs.

## Deploy over SSH

Requirements:

- Local machine: Bash, an SSH client, and rsync.
- Remote Linux machine: SSH access, Bash, rsync, Node.js 22.12+ and npm. Commands
  must be available on the non-interactive SSH `PATH`.
- The SSH account must be able to create and write the destination directory.
  Use a dedicated project directory, not `/`.

Copy the configuration template:

```sh
cp deploy.conf.example deploy.conf
```

Edit `deploy.conf`, setting `REMOTE_HOST` to an SSH alias or `user@hostname` and
`REMOTE_DIR` to the absolute destination directory. Paths containing spaces are
supported. Use your normal SSH keys/agent and `~/.ssh/config` for ports, identity
files, or jump hosts. The config is sourced as Bash, so use only trusted contents;
do not put passwords in it. It is ignored by Git and excluded from uploads.

Deploy:

```sh
./deploy.sh
```

The script finds the project relative to itself, so it also works when invoked
from another directory. It:

1. Checks remote prerequisites and creates the destination if needed.
2. Uploads the current working tree over SSH using rsync, including uncommitted
   source files and the existing static apps.
3. Explicitly removes the three apps' legacy dependency directories and lockfiles,
   then runs `npm ci --include=dev` once in the remote project root.
4. Runs the root `npm run build` script to build all three apps on the remote.

Build dependencies are installed even when the remote uses `NODE_ENV=production`.
The explicit cleanup also runs if npm lifecycle hooks are disabled on the remote.
Any failed SSH, upload, cleanup, install, or build command stops deployment with
a nonzero exit status.

Uploads exclude Git metadata, `node_modules`, `dist`, `.vite`, `.env`, `.env.*`,
`.npmrc`, and the local deployment config. Provision any required environment or
npm registry configuration separately on the remote. Other remote-only files are
preserved; `npm ci` refreshes the root dependencies and each app build refreshes
its own `dist` directory. Deployment updates the destination in place and is not
atomic.

Configure your HTTP(S) server to serve `REMOTE_DIR` as the site root. The launcher
at `index.html` links to the generated
`apps/helper-services-assistant/dist/index.html`, `apps/mcp/dist/index.html`, and
`apps/webMCP/dist/index.html`; all other apps retain their existing paths. The
script does not install a web server, start a development server, or restart
services. Native WebMCP requires HTTPS (or localhost) and a supporting browser.

## Check the deployment script

```sh
bash -n deploy.sh && bash -n deploy.conf.example
node --test deploy.test.cjs
```

The tests use temporary directories, real rsync, a local SSH substitute, and
mocked npm commands. They do not contact a remote machine or install packages.
