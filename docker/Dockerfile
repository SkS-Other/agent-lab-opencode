# Agent Lab sandbox image: runs `opencode serve` headless so the SDK driver can connect.
# Build:  docker build -t agent-lab-opencode:latest docker/
# The provider/auth config is mounted read-only at runtime (see createDefaultExecutor),
# so no secrets are baked into the image.
FROM node:22-slim

# git is required for opencode's working-tree diff (RunTrace.finalOutput.gitDiff).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install the OpenCode CLI globally.
RUN npm install -g opencode-ai@latest

# Each run drives an isolated working tree; initialize it as a git repo so diffs work.
WORKDIR /workspace
RUN git init -q \
  && git config user.email "agent@agent-lab.local" \
  && git config user.name "agent-lab" \
  && git commit -q --allow-empty -m "init"

EXPOSE 4096

# Headless server bound to all interfaces inside the container; the host publishes a
# random loopback port (see M-SANDBOX buildRunArgs `-p 127.0.0.1::4096`).
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
