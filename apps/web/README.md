# brandklipparen web UI (S-029)

React 19 + Vite 6 single-page app over the versioned REST API. The UI talks
to the core only through the published REST schema (A-04): it never imports
`src/domain`, `src/application` or adapters.

## Run locally

```sh
# Terminal 1: REST API on 127.0.0.1:8080 (built on
# src/interfaces/rest/server.ts, with a demo API key configured)

# Terminal 2: web UI on http://127.0.0.1:5173/
cd apps/web
npm install
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in a browser.
`/v1` and `/health` calls proxy to the REST API (default
`http://127.0.0.1:8080`, override with `VITE_REST_ORIGIN`). Paste a contract
address plus the demo REST API key; without a key the REST API answers 401
and the page shows the error in-view.

## Checks

```sh
npm test        # Vitest unit and component tests
npm run typecheck
npm run e2e     # builds, then runs the Playwright smoke (mocked REST)
```

## Security notes (K-507)

- Contract-derived strings render as React text only: no
  `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`. A static test
  (`src/lib/security.test.ts`) fails the suite if an HTML sink appears.
- Addresses validate client-side before any request leaves the browser.
- Serving CSP for a future Fastify-hosted demo bundle: serve `dist/` with

  ```text
  content-security-policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
  ```

  The Vite dev server itself needs relaxed directives for hot reload, so the
  policy above applies to the built bundle behind Fastify, not to `npm run dev`.
