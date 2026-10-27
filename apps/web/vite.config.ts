import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local demo wiring: the Vite dev server proxies REST calls to the
// Brandklipparen REST API. Override with VITE_REST_ORIGIN when the REST
// API listens somewhere other than 127.0.0.1:8080.
const restOrigin = process.env["VITE_REST_ORIGIN"] ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: restOrigin, changeOrigin: false },
      "/health": { target: restOrigin, changeOrigin: false },
    },
  },
  preview: {
    port: 5173,
    // Design review P0-7: a locked-down content policy on the preview
    // server. Dev keeps none so HMR stays working.
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
    proxy: {
      "/v1": { target: restOrigin, changeOrigin: false },
      "/health": { target: restOrigin, changeOrigin: false },
    },
  },
});
