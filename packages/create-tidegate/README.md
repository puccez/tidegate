# create-tidegate

Scaffold a Tidegate customer backend integration and verify its wiring.

> **Distribution status**: not yet on the public npm registry. Design partners
> receive a packed tarball (`bun run build:pack` → `dist-pkg/` → `npm pack`)
> and run it as `npx ./create-tidegate-<version>.tgz`. Once published,
> `bunx create-tidegate` works as written below.

## What you are building

Tidegate lets an AI agent operate your product safely. The division of labor is
strict, and it shapes everything this tool does:

- **You** expose a small catalog of typed backend actions (your domain
  operations) and approve what gets published.
- **The Tidegate agent** generates the *interactions* that orchestrate those
  actions. You never write interactions by hand.
- **The Tidegate Execution Kernel** governs every execution: it authenticates
  to your backend with a shared bridge secret and supplies the auth context and
  the per-interaction action allowlist in request headers. The secret is a
  privileged bearer credential — anyone holding it can supply those headers —
  so treat it like a database password: keep it out of version control and
  rotate it in both places together.

Your integration surface is exactly two HTTP endpoints plus one env var:

| Surface | Route | Purpose |
| --- | --- | --- |
| Catalog manifest | `GET /api/action-catalog` | Public, non-executable metadata: action schemas and policies. Tidegate reads it to generate the typed capabilities client. |
| Action bridge | `POST /api/actions` | Protected, executable. The Tidegate Execution Kernel calls it, authenticating with the shared `TIDEGATE_ACTION_BRIDGE_SECRET`. |

`create-tidegate init` scaffolds all of this; `create-tidegate doctor` proves
it works, layer by layer.

## Quick start

Until the package is on the registry, replace `bunx create-tidegate` below
with the tarball invocation (`npx ./create-tidegate-<version>.tgz`).

```bash
cd your-nextjs-backend            # existing Next.js App Router project
bunx create-tidegate              # scaffold (or: npx create-tidegate)
bun add @tidegate/sdk zod         # runtime deps, if the init summary asks
bun dev                           # start the backend

# in another terminal — verify the wiring:
bunx create-tidegate doctor \
  --catalog-url http://localhost:3000/api/action-catalog \
  --actions-url http://localhost:3000/api/actions \
  --secret "<TIDEGATE_ACTION_BRIDGE_SECRET from .env.local>"
```

## Implementation guide

### 1. Scaffold with `init`

Run `create-tidegate` (the `init` subcommand is optional) at the root of an
existing Next.js **App Router** project. It creates:

- `tidegate/actions.ts` — your typed action catalog, with two starter actions:
  - `diagnostics.ping` — read-only, side-effect-free; used by `doctor` to prove
    your bridge executes actions and that the auth context reaches them through
    the bridge headers (`ctx.auth`). **Keep it.** It is the wiring smoke test,
    not an authoring example.
  - `example.saveNote` — a fully annotated write action (input/output schemas,
    `effects`, `requiredPermissions`, `tenantScope`, `audit` redaction).
    Duplicate it, rename it into your first real domain operation, then delete
    it.
- `app/api/actions/route.ts` — the protected bridge route
  (`createTidegateActionHandler`).
- `app/api/action-catalog/route.ts` — the manifest route
  (`createTidegateActionCatalogManifest`).
- `.env.local` — a cryptographically generated `TIDEGATE_ACTION_BRIDGE_SECRET`
  (file mode 600 when created).

In projects using the `src/` layout the files land under `src/tidegate/` and
`src/app/` instead. Init is non-interactive and never overwrites: on conflict
it lists the files and writes nothing. `--dir <path>` targets another
directory; `--catalog-id <id>` overrides the manifest identifier (default: the
unscoped package name, falling back to the directory name).

### 2. Verify locally with `doctor`

Start your dev server, then run `doctor` against it (see Quick start). All
pre-`--e2e` stages run entirely against **your** backend, with doctor playing
the kernel's role — no Tidegate account needed yet. Fix the first failing
stage and re-run; stages are ordered so the first red line is the actual
broken layer, and later layers are skipped rather than reported as noise.

### 3. Write your real actions

Edit `tidegate/actions.ts`. Each action declares:

- `input` / `returns` — zod schemas; the handler validates both directions.
- `effects` — `"read" | "write" | "external" | "destructive"`; the kernel uses
  this to classify risk and constrain what interactions may declare.
- `requiredPermissions` — checked against the caller's server-derived
  permissions before `execute` runs.
- `tenantScope: { fromAuth: "tenantId" }` — pins the action to the caller's
  tenant. Declare it on every non-read action (`doctor` warns otherwise).
- `audit.redactPaths` — JSON-pointer paths redacted from audit logs.
- `execute(input, ctx)` — calls your existing business function. Identity and
  tenant always come from `ctx.auth` (derived server-side by Tidegate), never
  from `input`.

Keep actions small and domain-shaped (one operation each). Do not build
workflows out of them — orchestration is what generated interactions are for.

### 4. Deploy and register with Tidegate

1. Deploy your backend; set `TIDEGATE_ACTION_BRIDGE_SECRET` in the deployed
   environment (same value as `.env.local`, or rotate to a new one).
2. In the Tidegate console, register the backend: catalog URL
   (`https://your-backend/api/action-catalog`), actions URL
   (`https://your-backend/api/actions`), and the bridge secret.
3. Create a Tidegate API key if you want to run the end-to-end check.

### 5. Full verification with `doctor --e2e`

```bash
bunx create-tidegate doctor \
  --catalog-url https://your-backend/api/action-catalog \
  --actions-url https://your-backend/api/actions \
  --secret "$TIDEGATE_ACTION_BRIDGE_SECRET" \
  --e2e --api-base-url https://tidegate.vercel.app/api/v1 \
  --token "$TIDEGATE_API_KEY"
```

`--e2e` publishes an **ephemeral diagnostic interaction**
(`ix.diagnostics.echo`), invokes it through the public API, and archives it.
Archival is always attempted once publish succeeded — even after an invoke
failure — and a failed archive is reported so you can remove the leftover
`ix.diagnostics.*` interaction manually. This is a smoke test that the whole
system works — not an authoring example. Real interactions are generated by the Tidegate agent; your
responsibility ends at exposing actions and approving publications. The
`--interaction-id` override must stay inside the `ix.diagnostics.*` namespace.

From here on, adoption is: expose more actions → the Tidegate agent generates
interactions against them → you approve publications in the console.

## CLI reference

The CLI is non-interactive (no prompts), performs no writes on your backend
beyond scaffolding files locally (the only action `doctor` executes is the
read-only `diagnostics.ping`), and is designed to be driven by scripts and AI
agents. `--help`, `init --help`, and `doctor --help` print the same contract
described here.

### `create-tidegate [init]`

| Option | Meaning |
| --- | --- |
| `--dir <path>` | Target project directory (default: current directory). |
| `--catalog-id <id>` | Manifest identifier advertised to Tidegate (default: unscoped package name, falling back to the directory name). |

Requires a `package.json` with a `next` dependency. Pages-only projects (a
`pages/` or `src/pages/` directory with no App Router) are rejected; when
neither router directory exists yet, the App Router directories are created.
Never overwrites; `.env.local` is appended and existing keys are preserved.
Exit codes: `0` scaffolded, `1` failed (reason on stderr), `2` usage error.

### `create-tidegate doctor`

Connection options fall back to the environment variables listed below. Doctor
reads its own process environment — it does **not** load the project's
`.env.local`.

| Option | Env fallback | Meaning |
| --- | --- | --- |
| `--catalog-url <url>` | `TIDEGATE_ACTION_CATALOG_URL` | Manifest GET endpoint (required). |
| `--actions-url <url>` | `TIDEGATE_ACTION_ENDPOINT_URL` | Bridge POST endpoint; omitted → bridge stages skip. |
| `--secret <value>` | `TIDEGATE_ACTION_BRIDGE_SECRET` | Bridge secret; omitted → authenticated stages skip. |
| `--e2e` | — | Also publish + invoke + archive the smoke interaction. |
| `--api-base-url <url>` | `TIDEGATE_INTERACTIONS_API_BASE_URL` or `TIDEGATE_API_BASE_URL` | Tidegate API base URL (required with `--e2e`). |
| `--token <token>` / `--api-key <key>` | `TIDEGATE_API_TOKEN` or `TIDEGATE_API_KEY` | Tidegate API credential (required with `--e2e`). |
| `--interaction-id <id>` | — | `--e2e` only (ignored otherwise). Smoke interaction id, must start with `ix.diagnostics.` (default `ix.diagnostics.echo`). |
| `--visibility <v>` | — | `--e2e` only (ignored otherwise). `user`, `tenant` (default), `organization`, or `app`. |
| `--json` | — | Machine-readable report on stdout. |

Stages run in three layers: catalog (`catalog-fetch` → `catalog-schema` →
`catalog-governance`), bridge (`bridge-auth-reject` → `bridge-allowlist` →
`bridge-execute`), and with `--e2e` the end-to-end layer (`e2e-publish` →
`e2e-invoke` → `e2e-archive`). Fail-stop applies **between layers**: a failure
in one layer skips the later layers, which then appear as aggregate `bridge` /
`e2e` stages with status `skip`. Within a layer the remaining probes still
run, so a single run surfaces every broken probe of the current layer.
`e2e-archive` is always attempted once publish succeeded, even after an invoke
failure. A bare 401 from a proxy does not pass `bridge-auth-reject`: the
rejection must be contract-shaped, proving your handler (not an intermediary)
enforced it.

`--json` output shape:

```json
{
  "ok": true,
  "stages": [
    { "id": "catalog-fetch", "title": "...", "status": "pass", "detail": "..." }
  ]
}
```

`status` is `"pass" | "fail" | "warn" | "skip"`. Exit code `0` means no stage
failed — but `warn`/`skip` still mean "not fully verified", and the human
summary says so; treat `ok: true` with skips as partial coverage, not health.

## Setup prompt for an AI agent

Working with an AI coding agent (Claude Code, Codex, Cursor…)? Paste this
prompt, filling in the placeholders. The CLI's `--json` output and help text
are designed to be consumed by the agent directly.

```text
Integrate this backend with Tidegate. Context: Tidegate is a platform where my
backend exposes a catalog of typed actions and an AI agent generates the
interactions that orchestrate them; a governance kernel controls every
execution. My only job is to expose actions — interactions are NEVER written
by hand.

Repo: <path to the Next.js App Router project>.
CLI: <how to run create-tidegate — `npx create-tidegate` once published, or
the tarball I gave you, e.g. `npx ./create-tidegate-0.1.0.tgz`>.

1. Run the CLI's `init` at the project root (use `--dir` if needed). Read its
   `--help` first if anything is unclear; it documents the full behavior
   contract. If init reports conflicts or a missing prerequisite, fix that
   and re-run — it never overwrites files.
2. Install the runtime dependencies the init summary asks for
   (@tidegate/sdk and zod), with the package manager this repo already uses.
3. Start the dev server, then run the CLI's doctor:
     <CLI> doctor --json \
       --catalog-url http://localhost:3000/api/action-catalog \
       --actions-url http://localhost:3000/api/actions \
       --secret <value of TIDEGATE_ACTION_BRIDGE_SECRET from .env.local>
   Parse the JSON report. Fix the FIRST stage with status "fail" (its "detail"
   says what broke), then re-run until no stage fails. Stages with status
   "skip" or "warn" mean partial verification — resolve them too if you can.
4. Open the scaffolded action catalog — tidegate/actions.ts, or
   src/tidegate/actions.ts in src/ layouts; the init summary lists the exact
   files it created. Keep diagnostics.ping exactly as scaffolded (it is the
   wiring smoke test). Replace example.saveNote with real actions for
   these domain operations: <list your operations, e.g. "create an order,
   cancel a booking">. For each action: zod input/returns schemas; effects
   ("read"/"write"/"external"/"destructive"); requiredPermissions;
   tenantScope: { fromAuth: "tenantId" } on every non-read action; audit
   redaction for sensitive input fields; execute() must call the existing
   business logic in this repo and take identity/tenant ONLY from ctx.auth,
   never from input.
5. Re-run the doctor command from step 3 and make sure no stage fails and the
   catalog-governance stage passes (no warning about missing tenantScope).
6. Report: the files you created or changed, the actions now in the catalog,
   the final doctor JSON, and anything you could not verify.

Rules: never commit .env.local or the bridge secret; never author interaction
source code (no `ctx.capabilities` orchestration files — that is the Tidegate
agent's job); do not remove or rename diagnostics.ping; the catalog manifest
route is intentionally public metadata — if you believe this repo's action
surface is sensitive enough to protect it, flag that to me instead of putting
the route behind auth on your own.
```

The end-to-end check (`doctor --e2e`) needs a Tidegate API key — run it
yourself, or hand the agent `--api-base-url` and a `--token` and add step:
"re-run doctor with `--e2e --api-base-url <url> --token <key>` and confirm
e2e-publish, e2e-invoke, and e2e-archive all pass."
