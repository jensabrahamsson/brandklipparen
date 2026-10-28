// Boundary rules for the hexagonal architecture (A-06).
// The core in src/domain is pure: it imports solely its own modules and
// the TypeScript standard library. No I/O, network, clock, randomness,
// environment access or node: modules are allowed there.
module.exports = {
  forbidden: [
    {
      name: "boundary-domain-isolated",
      severity: "error",
      comment: "domain imports solely domain modules (A-06).",
      from: { path: "src/domain" },
      to: {
        pathNot: "src/domain",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "boundary-domain-deterministic",
      severity: "error",
      comment: "domain holds no I/O, network, clock, randomness or node: access (A-06, A-32).",
      from: { path: "src/domain" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "boundary-driving-via-application",
      severity: "error",
      comment:
        "driving adapters reach the core through application and ports; concrete adapters and wiring stay in composition (A-04, A-06).",
      from: { path: "src/interfaces" },
      to: { path: "src/(adapters|composition|apps)" },
    },
    {
      name: "boundary-detector-plugins-pure",
      severity: "error",
      comment:
        "detector plugins import solely the plugin API and domain; adapters, interfaces, composition and apps stay out (ADR P-03).",
      from: { path: "src/plugins" },
      to: { path: "src/(adapters|interfaces|composition|apps)" },
    },
    {
      name: "boundary-plugins-via-registry",
      severity: "error",
      comment:
        "driving adapters and the web UI read plugin exposure (registry lists, docs, audit reports, canonical findings) through the application service, never by importing the registry (ADR P-08, S-104). A driven adapter still validates its own port output against the shared spec contract directly.",
      from: { path: "src/(interfaces|apps)" },
      to: { path: "src/plugins" },
    },
    {
      name: "boundary-ports-pure",
      severity: "error",
      comment:
        "ports own the boundary contracts and import the domain only (S-104): adapters, driving adapters, composition and apps stay out, and plugin modules are type-only.",
      from: { path: "src/ports" },
      to: { path: "src/(adapters|interfaces|composition|apps)" },
    },
    {
      name: "boundary-ports-plugin-values",
      severity: "error",
      comment:
        "ports reference plugin contracts as types only; values cross through the application service (S-104).",
      from: { path: "src/ports" },
      to: { path: "src/plugins", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "boundary-driven-inward",
      severity: "error",
      comment:
        "driven adapters never reach up into driving adapters, composition or apps (S-104).",
      from: { path: "src/adapters" },
      to: { path: "src/(interfaces|composition|apps)" },
    },
    {
      name: "boundary-composition-terminal",
      severity: "error",
      comment:
        "nothing inside src imports the composition root: wiring flows one way from composition outward, and the process entrypoint calls in (S-104, S-105).",
      from: { path: "src/(domain|ports|plugins|adapters|interfaces)" },
      to: { path: "src/composition" },
    },
    {
      name: "boundary-web-standalone",
      severity: "error",
      comment:
        "the web UI ships separately and never imports server code (S-104).",
      from: { path: "^apps/" },
      to: { path: "^src/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
