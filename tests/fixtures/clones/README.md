# Placeholder clone templates for K-017 (S-014)

`trap-templates.json` is the small synthetic placeholder index of known trap
templates for clone matching. Every entry is hand-assembled synthetic
bytecode with no link to any real contract: a dispatcher window for one
made-up selector plus one structural opcode. The `group` names the template
group, `priorCount` counts earlier synthetic tokens in the group, and
`skeletonSimilarity` is the reported similarity for a skeleton-hash hit
(exact code-hash hits always report similarity 1). All numbers are
placeholders with no predictive meaning; production values arrive through
the versioned calibration chain per K-210 and A-20.

The adapter in `src/adapters/clones/` derives code hashes and skeleton
hashes from the `bytecode` field at load through the domain constructors,
so the fixture stays auditable as bytecode. The golden test
`k017_clone_hit_reports_similarity_group_and_count` pins the hit output.
