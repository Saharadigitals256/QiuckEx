# Contributing Guide

Welcome to the Stella Wave project! This guide will help you set up your development environment, understand our workflow, and contribute effectively.

## Quick Start: One-Click Dev Environment

We use VS Code Dev Containers for a seamless onboarding experience. After cloning the repo, open it in VS Code and select "Reopen in Container" when prompted. The container will set up all dependencies for Soroban and Backend development.

## Environment Setup

1. **Clone the repository:**
   ```sh
   git clone <repo-url>
   cd QiuckEx
   ```
2. **Open in VS Code.**
3. **Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) if prompted.**
4. **Reopen in Container.**

The container will install:
- Node.js (LTS)
- pnpm
- Rust toolchain (for Soroban)
- Soroban CLI
- Docker (for local services)
- All backend/frontend dependencies

## Manual Environment Setup (Without Dev Containers)

If you prefer to set up the environment manually on your host machine:

### 1. TypeScript/Node
1. Install Node.js (LTS).
2. Install `pnpm` globally (`npm i -g pnpm`).
3. Run `pnpm install` in the repository root.
4. Start the frontend/backend servers via TurboRepo:
   ```bash
   pnpm turbo run dev
   ```

### 2. Rust/Soroban
1. Install Rust via `rustup`:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup default stable
   rustup target add wasm32-unknown-unknown
   ```
2. Build the contracts:
   ```bash
   cd app/contract
   cargo build --target wasm32-unknown-unknown --release
   ```

## Branch Naming

- Feature branches: `feat/<short-description>`
- Bugfix branches: `fix/<short-description>`
- Docs branches: `docs/<short-description>`
- Chores: `chore/<short-description>`

## Filing Issues

Use one of the templates in `.github/ISSUE_TEMPLATE`:

| Template | Use it when |
|---|---|
| **Bug report** | Something behaves differently from what the docs say. |
| **Feature request** | Proposing a new capability or a change to an existing one. |
| **Architecture decision record** | The decision is expensive to reverse — see [docs/adr/](docs/adr/). |

Before filing, check [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md). Several flows
that look broken are labeled **Mocked** or **Partial** there, and the fix is often
wiring an existing backend endpoint to its client rather than building something new.

## Labels

Labels are declared in [`.github/labels.yml`](.github/labels.yml) and applied to the
repository by an idempotent script. Apply or inspect them with:

```bash
pnpm labels:sync            # create/update labels (safe to repeat)
pnpm labels:check           # report drift, change nothing
pnpm labels:sync -- --prune # also delete labels not in the file
```

`.github/workflows/sync-labels.yml` runs the same script daily and on any change to
the file, so the repository and the file cannot drift apart silently.

The vocabulary is deliberately small:

| Prefix | Answers | Examples |
|---|---|---|
| *(none)* / `type:` | What kind of change? | `bug`, `type:security`, `type:tech-debt`, `type:mocked-to-live` |
| `area:` | Which surface? | `area:frontend`, `area:backend`, `area:mobile`, `area:contract`, `area:docs`, `area:ci` |
| `network:` | Which Stellar network? | `network:testnet`, `network:mainnet` |
| `custody:` | Does it touch money or keys? | `custody:sensitive` |
| `needs:` | What must happen before merge? | `needs:breaking-change`, `needs:migration`, `needs:design` |
| `status:` | Where is the issue? | `status:needs-triage`, `status:accepted`, `status:blocked`, `status:done` |
| `P0`–`P3` | How urgent? | `P0` is the highest |

Two rules carry the most weight:

- **`custody:sensitive` on anything touching settlement, key handling, or the
  invariants in [docs/INVARIANTS.md](docs/INVARIANTS.md).** These get maintainer
  review regardless of size. See [ADR 0001](docs/adr/0001-self-custody-no-intermediary-custody.md).
- **`network:mainnet` on anything touching mainnet.** All `mainnet.*` feature flags
  default to disabled, and enabling one is a reviewed, reversible act. See
  [ADR 0002](docs/adr/0002-testnet-first-mainnet-feature-gated.md).

## Architecture Decision Records

Write an ADR when the change introduces or removes a service or datastore, changes
who holds keys or funds, changes the settlement or refund flow, breaks a public
endpoint family, or replaces a **Mocked**/**Partial** row with something users can
rely on. Pure UI work, bug fixes that restore documented behavior, and CI changes
do not need one.

- Format and index: [docs/adr/README.md](docs/adr/README.md)
- Start from the ADR issue template
- File it **in the same PR** as the implementation, labeled `needs:design`
- Never edit an Accepted ADR to change its meaning — supersede it and link the successor

Existing decisions worth reading before you propose an architecture change:

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-self-custody-no-intermediary-custody.md) | Self-custodial; no intermediary holds funds |
| [0002](docs/adr/0002-testnet-first-mainnet-feature-gated.md) | Testnet-first, mainnet behind disabled-by-default flags |
| [0003](docs/adr/0003-supabase-as-system-of-record.md) | Supabase is the only system of record |
| [0004](docs/adr/0004-canonical-status-vocabulary.md) | Live/Partial/Mocked/Experimental is the only status vocabulary |

## Pull Request Guidelines

- Reference the issue number in your PR description (`closes #123`).
- Add clear, descriptive titles.
- Ensure all tests pass before requesting review. The fastest way to know is `./scripts/rc-validate.sh` — the same gate CI runs. See [docs/RELEASE-CANDIDATE-VALIDATION.md](docs/RELEASE-CANDIDATE-VALIDATION.md).
- Follow the [Conventional Commits](https://www.conventionalcommits.org/) style.
- Add/Update documentation as needed.
- If your change alters what is actually shipped, update the matching row in [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) in the same PR ([ADR 0004](docs/adr/0004-canonical-status-vocabulary.md)).
- If your change touches settlement, key handling, or fees, label it `custody:sensitive` ([ADR 0001](docs/adr/0001-self-custody-no-intermediary-custody.md)).

## 8-Week MVP Roadmap & Feature Prioritization

See [docs/MVP-ROADMAP.md](docs/MVP-ROADMAP.md) for the full roadmap and priorities.

## Architecture Overview

- Backend and Contract architecture diagrams are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Check [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) to see which flows are Live, Partial, Mocked, or Experimental before building on them.
- See [docs/](docs/) for API, events, and payment flow documentation.

## Getting Help

- Check the [README.md](README.md) for project overview.
- Ask in Discussions or open an Issue if you’re stuck.

Happy contributing!
