FROM mcr.microsoft.com/devcontainers/base:ubuntu-22.04

# Avoid prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
        pkg-config \
        libssl-dev \
        tar \
        xz-utils \
        jq \
        docker.io && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js (v20 LTS) & pnpm reproducibly
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g pnpm@10.33.0 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# System-wide Rust toolchain & wasm32-unknown-unknown target for Soroban smart contracts
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
        --default-toolchain stable \
        --profile default \
        --target wasm32-unknown-unknown && \
    chmod -R a+w /usr/local/cargo /usr/local/rustup

# Install Stellar CLI (Soroban CLI) prebuilt release binary
ARG STELLAR_CLI_VERSION=22.3.0
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      STELLAR_ARCH="x86_64-unknown-linux-gnu"; \
    elif [ "$ARCH" = "aarch64" ]; then \
      STELLAR_ARCH="aarch64-unknown-linux-gnu"; \
    else \
      STELLAR_ARCH="x86_64-unknown-linux-gnu"; \
    fi && \
    curl -fsSL -o /tmp/stellar-cli.tar.gz "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${STELLAR_ARCH}.tar.gz" && \
    tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin && \
    rm -f /tmp/stellar-cli.tar.gz && \
    chmod +x /usr/local/bin/stellar* && \
    ln -sf /usr/local/bin/stellar /usr/local/bin/soroban
