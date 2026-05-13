# Spec Kit Mode

Spec Kit mode is Chorus' native bridge for Spec Kit artifacts. It supports both directions:

- Import an existing `specs/<feature>/` directory into Chorus.
- Generate `spec.md`, `plan.md`, and `tasks.md` from a Chorus Proposal and write them to the configured repo.

This mode does not require the Codex plugin. Any client can use Chorus REST or MCP directly.

## Implementation

- Parser: `src/lib/spec-kit.ts`
- Import service: `src/services/spec-kit.service.ts`
- Generate service: `src/services/spec-kit-generate.service.ts`
- Repo adapter: `src/services/spec-kit-repo.service.ts`
- Checkbox sync adapter: `src/services/spec-kit-sync.service.ts`
- REST endpoint: `POST /api/projects/:uuid/spec-kit/import`
- REST endpoint: `POST /api/proposals/:uuid/spec-kit/generate`
- MCP tools: `chorus_pm_import_speckit_feature`, `chorus_pm_generate_speckit_feature`

No new database tables are required for the first native version. Imported proposals use `inputType: "speckit"`. Chorus-generated Spec Kit proposals keep their original input type (`idea` or `document`). Both paths keep the source line in the proposal description:

```text
Spec Kit feature dir: specs/<feature>
```

## Source Mapping

| Spec Kit file | Chorus target |
|---|---|
| `specs/<feature>/spec.md` | Proposal `prd` document draft |
| `specs/<feature>/plan.md` | Proposal `tech_design` document draft |
| `specs/<feature>/research.md` | Proposal `adr` document draft |
| `specs/<feature>/data-model.md` | Proposal `spec` document draft |
| `specs/<feature>/contracts/*` | Proposal `spec` document drafts |
| `specs/<feature>/quickstart.md` | Proposal `guide` document draft |
| `specs/<feature>/tasks.md` | Chorus task drafts and dependency DAG |

`tasks.md` is parsed into task drafts rather than mirrored as a document, because Chorus already has a native task model.

## Generate From Chorus

Once a Proposal has document drafts and task drafts, Chorus can generate a Spec Kit feature directory:

```http
POST /api/proposals/:uuid/spec-kit/generate
```

```json
{
  "featureDir": "specs/001-auth"
}
```

`featureDir` is optional. If omitted, Chorus uses a deterministic path:

```text
specs/chorus-<proposal-prefix>-<proposal-title-slug>
```

The generator renders the file contents first, then writes them through the configured repo adapter. By default the adapter is local and uses the Chorus process working directory as the repo root.

- `spec.md` from `prd` document drafts, or a minimal fallback from the Proposal
- `plan.md` from `tech_design` document drafts, or a minimal fallback
- `tasks.md` from task drafts and `dependsOnDraftUuids`
- optional `research.md`, `data-model.md`, and `quickstart.md` from `adr`, `spec`, and `guide` drafts

It also updates the Proposal description with:

```text
Spec Kit feature dir: specs/<feature>
```

and stamps each task draft description with:

```text
Spec Kit task: T001
```

If the Proposal is already approved, Chorus also stamps the materialized Tasks so completion sync can still find the matching `Txxx`.

## REST Import

```http
POST /api/projects/:uuid/spec-kit/import
```

```json
{
  "title": "Authentication",
  "description": "Import Spec Kit auth feature",
  "featureDir": "specs/001-auth",
  "documents": {
    "specMd": "...",
    "planMd": "...",
    "researchMd": "...",
    "dataModelMd": "...",
    "quickstartMd": "...",
    "contracts": [
      { "path": "contracts/openapi.yaml", "content": "..." }
    ]
  },
  "tasksMarkdown": "..."
}
```

The response includes the created draft proposal, document/task draft counts, task ID to draft UUID mapping, and parser warnings.

## MCP Import

Use `chorus_pm_import_speckit_feature` with the same artifact shape:

- `projectUuid`
- `title`
- `description`
- `featureDir`
- `documents`
- `tasksMarkdown`

The tool requires `proposal:write` and returns the proposal UUID plus import counts.

## MCP Generate

Use `chorus_pm_generate_speckit_feature` after building a Proposal:

- `proposalUuid`
- `featureDir` optional

The tool requires `proposal:write` and returns the generated feature directory, written files, and draft UUID to Spec Kit task ID mapping.

## Flow

### Import-first flow

1. Run Spec Kit in the target repository until `specs/<feature>/` contains `spec.md`, `plan.md`, and `tasks.md`.
2. Upload the artifact contents through the REST endpoint or MCP tool.
3. Chorus creates a draft proposal with mirrored documents and task drafts.
4. Review and approve the proposal in Chorus.
5. Approved drafts materialize into Chorus Documents, Tasks, dependencies, and acceptance criteria.
6. When a Spec Kit-backed task is verified as `done`, Chorus can patch the matching checkbox in `tasks.md`.

### Chorus-first flow

1. Create an Idea or Proposal in Chorus.
2. Add Proposal document drafts and task drafts in Chorus.
3. Call `chorus_pm_generate_speckit_feature` or `POST /api/proposals/:uuid/spec-kit/generate`.
4. Chorus writes `specs/<feature>/spec.md`, `plan.md`, and `tasks.md` through the repo adapter.
5. Review and approve the Proposal in Chorus.
6. When a generated task is verified as `done`, Chorus patches the matching checkbox in `tasks.md`.

## Completion Sync

The completion sync trigger runs after any Task status update to `done`, including:

- MCP: `chorus_admin_verify_task`
- Web UI: human Verify action
- Other server paths that call `updateTask(..., { status: "done" })`

The sync only runs when all conditions hold:

1. The Task has a `proposalUuid`.
2. The Proposal description contains `Spec Kit feature dir: specs/<feature>`.
3. The Task title or description contains a Spec Kit task id such as `T012`.
4. The repo adapter is enabled.

## Repo Adapters

Generation and completion sync use the same two-layer design:

1. Chorus renders or patches the file contents.
2. A repo adapter writes the result somewhere.

### Local adapter

Local is the default. If no adapter environment variables are set, Chorus writes relative paths under its current working directory. In source development this is normally the directory where you ran `pnpm dev:local`; in a packaged/server deployment it may be the Chorus install directory.

```text
<process.cwd()>/specs/<feature>/spec.md
<process.cwd()>/specs/<feature>/plan.md
<process.cwd()>/specs/<feature>/tasks.md
```

If Chorus is started from a different directory than the target repo, override the root:

```bash
CHORUS_SPECKIT_LOCAL_REPO=/path/to/target/repo
```

Force local mode explicitly when both local and GitHub config exist:

```bash
CHORUS_SPECKIT_ADAPTER=local
```

### GitHub adapter

Use GitHub when Chorus should write to a remote repository through the GitHub Contents API:

```bash
CHORUS_SPECKIT_ADAPTER=github
CHORUS_SPECKIT_GITHUB_REPO=owner/repo
CHORUS_SPECKIT_GITHUB_BRANCH=main
CHORUS_SPECKIT_GITHUB_TOKEN=github_pat_or_app_token
```

`GITHUB_TOKEN` is also accepted when `CHORUS_SPECKIT_GITHUB_TOKEN` is not set. For GitHub Enterprise, set:

```bash
CHORUS_SPECKIT_GITHUB_API_URL=https://github.example.com/api/v3
```

Per-project overrides are supported by appending a sanitized project UUID to the variable name. For project `project-0000-0000-0000-000000000001`, use:

```bash
CHORUS_SPECKIT_ADAPTER_PROJECT_0000_0000_0000_000000000001=local
CHORUS_SPECKIT_LOCAL_REPO_PROJECT_0000_0000_0000_000000000001=/path/to/repo
CHORUS_SPECKIT_GITHUB_REPO_PROJECT_0000_0000_0000_000000000001=owner/repo
CHORUS_SPECKIT_GITHUB_BRANCH_PROJECT_0000_0000_0000_000000000001=feature-branch
CHORUS_SPECKIT_GITHUB_TOKEN_PROJECT_0000_0000_0000_000000000001=github_pat_or_app_token
```

The old `CHORUS_SPECKIT_SYNC=github` and `CHORUS_SPECKIT_WRITE_MODE=local|github` names are still accepted as aliases for `CHORUS_SPECKIT_ADAPTER`.

The adapter updates `specs/<feature>/tasks.md` in the selected target. Sync results are recorded as Task activities:

- `speckit_sync_completed`
- `speckit_sync_skipped`
- `speckit_sync_failed`

Generation results are recorded as Proposal activities:

- `speckit_generate_completed`
- `speckit_generate_failed`

## Current Limits

- Local mode writes under the Chorus process working directory unless `CHORUS_SPECKIT_LOCAL_REPO` points somewhere else.
- Task parsing is conservative. It preserves phase order, `[P]`, `[USx]`, explicit `depends on Txxx`, and simple phase dependencies, but it does not infer every semantic dependency from prose.
- GitHub mode commits directly to a configured branch. Pull-request mode can be added later if teams prefer review before repository writes.
