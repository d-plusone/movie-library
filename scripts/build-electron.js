const { spawnSync } = require("child_process");

const { resolveVersion } = require("./resolve-version");

const version = resolveVersion();
const electronBuilderCli = require.resolve("electron-builder/cli.js");
const args = [
  electronBuilderCli,
  ...process.argv.slice(2),
  `--config.extraMetadata.version=${version}`,
];

console.log(`Building Electron app version: ${version}`);

const result = spawnSync(process.execPath, args, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
