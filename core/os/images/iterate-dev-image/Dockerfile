# iterate-dev-image: the image a sandbox starts from (core/os/src/sandbox): Cloudflare's own `cloudflare/debian-trixie`
# (this base, pinned by version) plus the tools a dev machine needs, so a sandbox runs `git`, `gh`,
# Chromium, the agent CLIs and the project's own CLI on the first command.
#
# Everything a sandbox reaches goes out through its project's egress, which signs with a CA that is
# known only when the container starts: the sandbox's entrypoint trusts it (system store and the
# Chromium NSS database) then, never this build.
FROM node:24.20.0-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive CI=1

# A dev machine's system packages. `libnss3-tools` is Chromium's `certutil`; `ffmpeg` and Chromium
# are what agents use for media and screenshots.
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    build-essential ca-certificates chromium curl ffmpeg fonts-liberation fonts-noto-color-emoji \
    git gnupg jq less libnss3-tools openssh-client procps python3 ripgrep unzip vim-tiny xz-utils \
  && rm -rf /var/lib/apt/lists/*

# The GitHub CLI and the Doppler CLI, from their own apt repositories.
RUN install -d -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  # allow-high-entropy-next-line: the id of Doppler's public apt signing key, in the URL of that key
  && curl -fsSL https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key | gpg --dearmor -o /etc/apt/keyrings/doppler.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/doppler.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" > /etc/apt/sources.list.d/doppler-cli.list \
  && apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends gh doppler \
  && rm -rf /var/lib/apt/lists/*

# Pinned, so an image is the same every time it is built; a version moves in a commit.
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
RUN npm install -g --no-fund --no-audit \
    @anthropic-ai/claude-code@2.1.292 \
    @openai/codex@0.160.1 \
    @xai-official/grok@1.0.46 \
    iterate@0.4.1-main.20261007T065323Z-9e9cca2 \
    cf@1.0.0-beta.12 \
  && npm cache clean --force

# The public repository, for a sandbox that wants the platform's source at hand.
RUN git clone --depth 1 https://github.com/iterate/core /work/core

WORKDIR /work
