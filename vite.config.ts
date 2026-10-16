import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// npm sets npm_package_version for scripts, so `npm run build` and
// `npm run tauri build` both stamp the real version into the bundle.
const appVersion = process.env.npm_package_version ?? "0.0.0";

/**
 * KaTeX ships every face as woff2 + woff + ttf. Every webview this app targets
 * (WebView2, WKWebView, WebKitGTK) has supported woff2 for years, so the other
 * two formats are ~800 KB of dead weight inside the executable. Stripping them
 * before Vite resolves the URLs also stops it emitting the files at all.
 */
function katexWoff2Only() {
  return {
    name: "katex-woff2-only",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("katex") || !id.includes(".css")) return null;
      const trimmed = code.replace(
        /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\((["']?)(?:woff|truetype)\1\)/g,
        "",
      );
      return trimmed === code ? null : { code: trimmed, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    APP_VERSION: JSON.stringify(appVersion),
  },

  plugins: [katexWoff2Only()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
