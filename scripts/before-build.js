const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch } = context;

  console.log(`Building for platform: ${electronPlatformName}, arch: ${arch}`);

  // Windows用のビルドの場合
  if (electronPlatformName === "win32") {
    console.log("Preparing better-sqlite3 for Windows...");

    try {
      // better-sqlite3のバイナリ確認
      const betterSqlite3Path = path.join(
        __dirname,
        "..",
        "node_modules",
        "better-sqlite3"
      );

      if (fs.existsSync(betterSqlite3Path)) {
        console.log("better-sqlite3 module found");

        // package.jsonの確認
        const packageJsonPath = path.join(betterSqlite3Path, "package.json");
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
          console.log(`better-sqlite3 version: ${pkg.version}`);
        }

        // buildディレクトリの確認
        const buildPath = path.join(betterSqlite3Path, "build");
        if (fs.existsSync(buildPath)) {
          const buildContents = fs.readdirSync(buildPath);
          console.log("better-sqlite3 build contents:", buildContents);
        } else {
          console.log("better-sqlite3 build directory not found");
        }
      }

      console.log("better-sqlite3 preparation completed");
    } catch (error) {
      console.error("Error in before-build:", error.message);
    }
  }

  return true;
};
