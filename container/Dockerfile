# NanoClaw-Quorbz Agent Container
# Runs Grok (xAI) via the OpenAI-compatible API — no Anthropic dependencies.
# XAI_API_KEY is injected by the host's OneCLI credential proxy at runtime.

FROM node:22-slim

# Install system dependencies for Chromium and general tooling
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally (no claude-code — xAI runs its own agent loop)
RUN npm install -g agent-browser

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies (legacy-peer-deps resolves zod v3/v4 conflict)
RUN npm install --legacy-peer-deps

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entrypoint: reads ContainerInput JSON from stdin, runs xAI agent loop, outputs to stdout.
# XAI_API_KEY is injected by the host's OneCLI credential proxy — never hardcoded here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nnode /app/dist/index.js\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable workspace directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
