import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// package.json の dependencies を external として扱う。
// （electron-vite 5 の外部化プラグインは Vite 8 / Rolldown のビルド経路で
//   反映されないケースがあるため、rollupOptions.external に直接指定する）
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
const dependencies: string[] = Object.keys(pkg.dependencies ?? {});

// electron は devDependencies だが、常に外部化が必要なモジュール
const electronExternals = ["electron"];

// main / preload は CJS 出力を強制する。
// - 現行コードが require("@ffmpeg-installer/ffmpeg") 等の動的 require に依存している
// - サンドボックス有効時、preload は CJS のみ対応（.mjs は読み込めない）
const cjsOutput = {
  format: "cjs" as const,
  entryFileNames: "[name].js",
  chunkFileNames: "[name]-[hash].js",
};

export default defineConfig({
  main: {
    build: {
      // 外部化は rollupOptions.external で明示的に行うため無効化
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        external: [
          ...dependencies,
          ...electronExternals,
          /^node:/,
          // 生成済み Prisma Client はバンドルせず実行時に解決する。
          // （バンドルするとクエリエンジン .node の相対パス解決が壊れるため。
          //   実行時は out/main から見て ../../generated/prisma を require する。
          //   パッケージ版では electron-builder の files に generated/**/* を含めること。）
          /generated[/\\]prisma/,
        ],
        output: cjsOutput,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        external: [...dependencies, ...electronExternals, /^node:/],
        output: cjsOutput,
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
