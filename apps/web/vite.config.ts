import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApiKeyDefine, demoApiKeyForBuild } from "./src/lib/demoApiKeyGuard.ts";

// Local demo wiring: the Vite dev server proxies REST calls to the
// Brandklipparen REST API. Override with VITE_REST_ORIGIN when the REST
// API listens somewhere other than 127.0.0.1:8080.
const restOrigin = process.env["VITE_REST_ORIGIN"] ?? "http://127.0.0.1:8080";

export default defineConfig(({ mode }) => {
  // SEC-1 S-1: a production build must never contain a REST key. Fails
  // the build when VITE_DEMO_API_KEY is set, and otherwise defines it
  // empty so no value can be inlined into the bundle.
  demoApiKeyForBuild(mode, process.env["VITE_DEMO_API_KEY"]);
  return {
    plugins: [react()],
    define: demoApiKeyDefine(mode, process.env["VITE_DEMO_API_KEY"]),
    server: {
      port: 5173,
      proxy: {
        "/v1": { target: restOrigin, changeOrigin: false },
        "/health": { target: restOrigin, changeOrigin: false },
      },
    },
    preview: {
      port: 5173,
      headers: {
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      },
      proxy: {
        "/v1": { target: restOrigin, changeOrigin: false },
        "/health": { target: restOrigin, changeOrigin: false },
      },
    },
  };
});
