const { spawnSync } = require("child_process");

const { resolveLatestReleaseVersion } = require("./resolve-version");

const increment = process.argv[2];
const increments = {
  major: (version) => `${Number(version[0]) + 1}.0.0`,
  minor: (version) => `${version[0]}.${Number(version[1]) + 1}.0`,
  patch: (version) => `${version[0]}.${version[1]}.${Number(version[2]) + 1}`,
};

if (!increments[increment]) {
  console.error("Usage: node scripts/bump-version.js <major|minor|patch>");
  process.exit(1);
}

const currentVersion = resolveLatestReleaseVersion().split("-")[0].split(".");
const nextVersion = increments[increment](currentVersion);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["version", nextVersion], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
