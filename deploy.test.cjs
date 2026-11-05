"use strict";

const assert = require("node:assert/strict");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const npmCommands = [
  ["install", "--include=dev"],
  ["--prefix", "apps/helper-services-assistant", "install", "--include=dev"],
  ["--prefix", "apps/helper-services-assistant", "run", "build"],
];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createDeployment(t) {
  const root = mkdtempSync(join(tmpdir(), "arcgis-deploy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "source project");
  const remote = join(root, "remote site's files; $(touch injected)");
  const bin = join(root, "bin");
  const npmLog = join(root, "npm.jsonl");
  mkdirSync(project);
  mkdirSync(bin);
  copyFileSync(join(__dirname, "deploy.sh"), join(project, "deploy.sh"));

  function put(path, contents = "fixture\n") {
    const destination = join(project, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }

  function mock(command, source) {
    writeFileSync(join(bin, command), source, { mode: 0o755 });
  }

  function configure(host = "deployment-test", directory = remote) {
    put(
      "deploy.conf",
      `REMOTE_HOST=${shellQuote(host)}\nREMOTE_DIR=${shellQuote(directory)}\n`,
    );
  }

  mock(
    "ssh",
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1-}" == "-T" ]]; then shift; fi
if [[ "\${1-}" == "--" ]]; then shift; fi
if [[ "\${1-}" != "deployment-test" ]]; then
  printf 'Refusing non-test SSH host\\n' >&2
  exit 1
fi
if [[ "\${DEPLOY_TEST_FAIL_SSH:-}" == "1" ]]; then
  printf 'Simulated SSH failure\\n' >&2
  exit 25
fi
shift
exec sh -c "$*"
`,
  );
  mock(
    "npm",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.DEPLOY_TEST_NPM_LOG,
  JSON.stringify({ cwd: process.cwd(), args }) + "\\n",
);
if (args.join(" ") === process.env.DEPLOY_TEST_FAIL_NPM) {
  console.error("Simulated npm failure");
  process.exit(17);
}
`,
  );
  configure();

  return {
    root,
    project,
    remote,
    put,
    mock,
    configure,
    run(env = {}) {
      return spawnSync("bash", [join(project, "deploy.sh")], {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          DEPLOY_TEST_NPM_LOG: npmLog,
          ...env,
        },
      });
    },
    npmCalls() {
      return existsSync(npmLog)
        ? readFileSync(npmLog, "utf8").trim().split("\n").map(JSON.parse)
        : [];
    },
  };
}

test("deploys the whole site and builds remotely, preserving layout and exclusions", (t) => {
  const deployment = createDeployment(t);
  const sourceFiles = [
    "index.html",
    "package.json",
    "package-lock.json",
    ".gitignore",
    "apps/apis/index.html",
    "apps/apis/app.js",
    "apps/helper-services-assistant/index.html",
    "apps/helper-services-assistant/package.json",
    "apps/helper-services-assistant/package-lock.json",
    "apps/helper-services-assistant/vite.config.js",
  ];
  const excludedFiles = [
    ".git/config",
    ".env",
    ".env.production",
    ".npmrc",
    "node_modules/local-only/index.js",
    "dist/local-only.html",
    "apps/helper-services-assistant/node_modules/local-only/index.js",
    "apps/helper-services-assistant/dist/index.html",
    "apps/helper-services-assistant/.vite/cache",
    "apps/helper-services-assistant/.env.local",
  ];
  for (const path of [...sourceFiles, ...excludedFiles]) {
    deployment.put(path, path);
  }
  symlinkSync(deployment.root, join(deployment.project, "outside-link"));
  mkdirSync(deployment.remote);
  writeFileSync(join(deployment.remote, "remote-only.txt"), "preserved");
  writeFileSync(
    join(deployment.remote, ".env.production"),
    "remote environment",
  );

  const result = deployment.run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Deployment complete/);
  for (const path of sourceFiles) {
    assert.equal(readFileSync(join(deployment.remote, path), "utf8"), path);
  }
  for (const path of [
    ...excludedFiles.filter((path) => path !== ".env.production"),
    "deploy.conf",
    "outside-link",
  ]) {
    assert.equal(existsSync(join(deployment.remote, path)), false, path);
  }
  assert.equal(
    readFileSync(join(deployment.remote, "remote-only.txt"), "utf8"),
    "preserved",
  );
  assert.equal(
    readFileSync(join(deployment.remote, ".env.production"), "utf8"),
    "remote environment",
  );
  assert.equal(existsSync(join(deployment.root, "injected")), false);
  assert.deepEqual(
    deployment.npmCalls(),
    npmCommands.map((args) => ({ cwd: deployment.remote, args })),
  );
});

test("creates a missing remote directory", (t) => {
  const deployment = createDeployment(t);
  const result = deployment.run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(existsSync(join(deployment.remote, "deploy.sh")));
});

test("excludes Git metadata when deploying from a linked worktree", (t) => {
  const deployment = createDeployment(t);
  deployment.put(".git", "gitdir: ../private-worktree\n");
  const result = deployment.run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(existsSync(join(deployment.remote, ".git")), false);
});

test("reports a missing configuration without deploying", (t) => {
  const deployment = createDeployment(t);
  rmSync(join(deployment.project, "deploy.conf"));
  const result = deployment.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Copy deploy\.conf\.example/);
  assert.equal(existsSync(deployment.remote), false);
  assert.deepEqual(deployment.npmCalls(), []);
});

for (const [host, directory, error] of [
  ["", "/var/www/demo", /REMOTE_HOST/],
  ["-invalid-host", "/var/www/demo", /REMOTE_HOST/],
  ["invalid host", "/var/www/demo", /REMOTE_HOST/],
  ["deployment-test", "relative/path", /REMOTE_DIR/],
  ["deployment-test", "/", /REMOTE_DIR/],
]) {
  test(`rejects invalid configuration ${host}:${directory}`, (t) => {
    const deployment = createDeployment(t);
    deployment.configure(host, directory);
    const result = deployment.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.deepEqual(deployment.npmCalls(), []);
  });
}

test("rejects a destination resolving to the remote filesystem root", (t) => {
  const deployment = createDeployment(t);
  const rootLink = join(deployment.root, "root-link");
  symlinkSync("/", rootLink);
  deployment.configure("deployment-test", rootLink);
  const result = deployment.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not \//);
  assert.deepEqual(deployment.npmCalls(), []);
});

test("stops when the SSH connection fails", (t) => {
  const deployment = createDeployment(t);
  const result = deployment.run({ DEPLOY_TEST_FAIL_SSH: "1" });
  assert.equal(result.status, 25);
  assert.match(result.stderr, /Simulated SSH failure/);
  assert.equal(existsSync(deployment.remote), false);
  assert.deepEqual(deployment.npmCalls(), []);
  assert.doesNotMatch(result.stdout, /Deployment complete/);
});

test("does not install or build after an upload failure", (t) => {
  const deployment = createDeployment(t);
  deployment.mock(
    "rsync",
    "#!/usr/bin/env bash\nprintf 'Simulated rsync failure\\n' >&2\nexit 23\n",
  );
  const result = deployment.run();
  assert.equal(result.status, 23);
  assert.match(result.stderr, /Simulated rsync failure/);
  assert.deepEqual(deployment.npmCalls(), []);
  assert.doesNotMatch(result.stdout, /Deployment complete/);
});

for (const [index, command] of npmCommands.entries()) {
  test(`stops when npm ${command.join(" ")} fails`, (t) => {
    const deployment = createDeployment(t);
    const result = deployment.run({ DEPLOY_TEST_FAIL_NPM: command.join(" ") });
    assert.equal(result.status, 17);
    assert.match(result.stderr, /Simulated npm failure/);
    assert.deepEqual(
      deployment.npmCalls().map(({ args }) => args),
      npmCommands.slice(0, index + 1),
    );
    assert.doesNotMatch(result.stdout, /Deployment complete/);
  });
}
