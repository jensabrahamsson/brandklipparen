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
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
