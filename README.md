# ArcGIS AI Demo

A static app launcher and ArcGIS AI demos. Most apps are plain HTML, CSS, and
JavaScript; [Helper Services Assistant](apps/helper-services-assistant/README.md)
uses npm dependencies and a Vite build.

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
3. Runs `npm install --include=dev` in the remote project root, then
   `npm --prefix apps/helper-services-assistant install --include=dev`.
4. Runs `npm --prefix apps/helper-services-assistant run build` on the remote.

Build dependencies are installed even when the remote uses `NODE_ENV=production`.
Any failed SSH, upload, install, or build command stops deployment with a nonzero
exit status.

Uploads exclude Git metadata, `node_modules`, `dist`, `.vite`, `.env`, `.env.*`,
`.npmrc`, and the local deployment config. Provision any required environment or
npm registry configuration separately on the remote. Remote-only files are not
deleted; the app build refreshes its own `dist` directory. Deployment updates the
destination in place and is not atomic.

Configure your HTTP(S) server to serve `REMOTE_DIR` as the site root. The launcher
at `index.html` links to the generated
`apps/helper-services-assistant/dist/index.html`; all other apps retain their
existing paths. The script does not install a web server, start a development
server, or restart services.

## Check the deployment script

```sh
bash -n deploy.sh && bash -n deploy.conf.example
node --test deploy.test.cjs
```

The tests use temporary directories, real rsync, a local SSH substitute, and
mocked npm commands. They do not contact a remote machine or install packages.
