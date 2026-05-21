# Design

This repository should optimize for agent legibility, not just human familiarity.

Design priorities:

- Prefer explicit domain boundaries over convenience imports.
- Prefer small, named modules over large multi-purpose route files.
- Keep framework glue at the edge and business rules in domain code.
- Make state transitions and invariants visible in repository-local docs.

Current visual design is secondary to structural clarity. The dashboard and marketplace already have a recognizable style, but the larger design problem in this repo is architectural readability.
