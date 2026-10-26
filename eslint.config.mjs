import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Flat ESLint config for the TanStack Start app-builder template. */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-desktop/**",
      "dist-web/**",
      "zhiyu-data/**",
      "release/**",
      ".output/**",
      ".vercel/**",
      ".nitro/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // 页面代码也跑在网页版里；经 http:// 局域网地址打开时没有 crypto.randomUUID，统一用 randomId()。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message: "网页版经 http:// 打开时不可用，请改用 @/lib/random-id 的 randomId()。",
        },
      ],
    },
  },
  // Electron preload scripts must be CommonJS: `contextBridge` runs before the
  // renderer's module graph exists, and an ESM preload needs the sandbox off.
  {
    files: ["electron/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Disable rules that conflict with Prettier formatting.
  prettier,
);
