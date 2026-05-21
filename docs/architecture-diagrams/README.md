# Architecture Diagram Exports

This directory contains Mermaid source files and generated SVG exports for the diagrams embedded in [ARCHITECTURE.md](../../ARCHITECTURE.md).

Purpose:

- preserve static image versions for Markdown renderers that do not support Mermaid
- keep diagram sources versioned alongside the main architecture doc
- make it easier to regenerate or reuse the diagrams in external docs

Files:

- `*.mmd` are Mermaid source files extracted from `ARCHITECTURE.md`
- `*.svg` are generated static exports

Regeneration pattern:

1. update the Mermaid blocks in `ARCHITECTURE.md`
2. regenerate the `.mmd` sources if the heading structure changed
3. render the `.svg` exports with `@mermaid-js/mermaid-cli`
