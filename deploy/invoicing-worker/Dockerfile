# Include tsx so the worker entrypoint can run TypeScript without a build step.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4.21.0

COPY tsconfig.json ./
COPY src ./src
COPY scripts/invoicing-worker.ts ./scripts/invoicing-worker.ts

ENV NODE_ENV=production
USER node

CMD ["npx", "tsx", "scripts/invoicing-worker.ts"]
