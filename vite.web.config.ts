import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import desktop from "./vite.desktop.config";

/**
 * 自托管网页版：与桌面渲染层同一份界面代码，只是没有 Electron 桥，
 * 资料、文档和密钥库密文改由 selfhost/server.mjs 的接口保存。
 */
export default mergeConfig(
  desktop,
  defineConfig({
    base: "/",
    define: { "import.meta.env.VITE_ZHIYU_WEB": JSON.stringify("1") },
    build: {
      outDir: fileURLToPath(new URL("./dist-web", import.meta.url)),
      emptyOutDir: true,
      target: "es2022",
    },
  }),
);
