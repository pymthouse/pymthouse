FROM node:20-bookworm-slim

WORKDIR /workspace

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    git \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Dependencies installed via postCreateCommand to pick up workspace package.json
