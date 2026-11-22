const { execFileSync } = require("child_process");

const packageJson = require("../package.json");

const SEMVER_TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const DESCRIBED_TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(\d+)-g[0-9a-f]+$/;

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: __dirname + "/..",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseTag(tag) {
  const match = SEMVER_TAG_PATTERN.exec(tag.trim());
  return match?.[1] ?? null;
}

function resolveLatestReleaseVersion() {
  const latestTag = parseTag(
    runGit(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]),
  );
  return latestTag ?? packageJson.version;
}

function resolveVersion() {
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    const releaseVersion = parseTag(process.env.GITHUB_REF_NAME);
    if (releaseVersion) return releaseVersion;
  }

  const describedTag = runGit([
    "describe",
    "--tags",
    "--long",
    "--match",
    "v[0-9]*",
  ]);
  const describedMatch = DESCRIBED_TAG_PATTERN.exec(describedTag);

  if (describedMatch) {
    const [, baseVersion, distance] = describedMatch;
    return distance === "0" ? baseVersion : `${baseVersion}-dev.${distance}`;
  }

  return resolveLatestReleaseVersion();
}

if (require.main === module) {
  console.log(resolveVersion());
}

module.exports = { resolveLatestReleaseVersion, resolveVersion };
