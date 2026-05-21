# Frontend

The frontend is split between:

- provider dashboard pages under `src/app/apps`, `src/app/admin`, `src/app/dashboard`, `src/app/signer`, and related areas
- marketplace and public pages under `src/app/marketplace`, `src/app/solutions`, and `src/app/page.tsx`
- shared UI under `src/components/**`

Current issues:

- some page components still fetch directly from REST endpoints and reshape large payloads in place
- app-management UI is now materially improved, with editor state, testing models, redirect/domain editing, and auth-mode behavior extracted into `src/domains/developer-apps/ui/**`, but broader non-app surfaces have not had the same level of cleanup yet
- domain concepts are increasingly explicit in the UI, but not every surface has a clean view-model layer yet

Target frontend rules:

- keep pages thin and domain-focused
- move domain-specific state shaping into domain `ui` or `runtime` modules
- keep shared components presentation-oriented when possible
- avoid growing generic `components/` as a dumping ground for domain logic
