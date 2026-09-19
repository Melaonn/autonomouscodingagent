FROM node:24-bookworm
ARG CODEX_VERSION=0.145.0
ARG GITLEAKS_VERSION=8.24.3
RUN apt-get update && apt-get install -y --no-install-recommends git curl ripgrep jq python3 python3-venv python3-pip ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@${CODEX_VERSION} \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && python3 -m venv /opt/security && /opt/security/bin/pip install --no-cache-dir semgrep pip-audit \
 && curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks \
 && useradd -m -u 10001 worker && mkdir -p /workspace /control && chown -R worker:worker /workspace /control
ENV PATH="/opt/security/bin:/home/worker/.local/bin:${PATH}" HOME=/home/worker
COPY docker/worker/sdlc-read-file /usr/local/bin/
COPY docker/worker/semgrep.yml /opt/sdlc/semgrep.yml
RUN chmod 0755 /usr/local/bin/sdlc-*
USER worker
WORKDIR /workspace
