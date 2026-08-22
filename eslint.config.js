const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");
const unusedImports = require("eslint-plugin-unused-imports");

// 共通ルール（renderer / main process の両方に適用）
const commonRules = {
  // 未使用変数を警告として検出
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  // any 型の使用を禁止（README 規約: any 型の使用禁止）
  "@typescript-eslint/no-explicit-any": "error",
  // 未使用 import をエラーとして検出（--fix で自動削除可能）
  "unused-imports/no-unused-imports": "error",
  // import 以外の未使用変数は @typescript-eslint/no-unused-vars に委ねる
  "unused-imports/no-unused-vars": "off",
  // innerHTML の使用は XSS リスクがあるため警告
  // （escapeHtml を通すか、textContent を使用すること）
  "no-restricted-syntax": [
    "warn",
    {
      selector:
        "MemberExpression[property.name='innerHTML'][property.type='Identifier']",
      message:
        "innerHTML の使用は XSS リスクがあります。escapeHtml でエスケープ済みの値のみ渡すか、textContent を使用してください。",
    },
  ],
};

module.exports = [
  {
    // main / preload / renderer / tests を単一設定でカバー。
    // プロジェクト解決は projectService に任せることで、
    // ファイル↔tsconfig の包含関係による Parsing error を防ぐ。
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        window: "readonly",
        document: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "unused-imports": unusedImports,
    },
    rules: commonRules,
  },
  {
    // 除外するファイル
    ignores: [
      "dist/**",
      "dist-ts/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "generated/**",
      "**/*.js",
    ],
  },
];
