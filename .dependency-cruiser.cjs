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
        "driving adapters, the web UI and driven adapters read plugin data through the application service, never by importing the registry (ADR P-08).",
      from: { path: "src/(interfaces|apps|adapters)" },
      to: { path: "src/plugins" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
