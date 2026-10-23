# codegraph: the structural layer

A parser module: it turns a repository into files, symbols and import edges. It reads the disk and runs git. The
parser stores nothing; `stage.ts` (the worker's "map" stage) builds each selected project's map and writes it through
`CodeGraphStore.replaceCodeMap`, reading the stored map back for the next incremental build.

```ts
import { buildCodeMap, churn, dependents, testsFor } from './codegraph/index.ts';

const map = await buildCodeMap(repoPath, { maxFiles: 5000, maxBytes: 200_000 });
const next = await buildCodeMap(repoPath, opts, map); // unchanged files are not reparsed
dependents(map, 'src/db.ts', 2); // [{ path, depth }], nearest first
testsFor(map, 'src/db.ts'); // test files importing it directly or through one file
await churn(repoPath, 90); // Map<path, { commits, lastTs }>, renames followed to today's path
```

## What it reads

The file list comes from `listCodeFiles` (scan/scan.ts): `.gitignore` respected, vendor and build dirs, lockfiles and
secret files skipped, symlinks never followed. Each file is lstat'd again before it is read.

Parsing uses tree-sitter through `web-tree-sitter` (WASM, no native build) with grammars from
`@repomix/tree-sitter-wasms`, both pinned exactly in the worker's package.json.

| Language | Symbols | Imports resolved to repo files |
|---|---|---|
| TypeScript, TSX, JavaScript (ESM + CommonJS) | yes | relative (`.js` -> `.ts`, `index.*`), tsconfig `paths`/`baseUrl` (with `extends`), workspace package names |
| Python | yes | relative, package-absolute from the repo root, each `pyproject.toml`/`setup.py` dir and their `src/` |
| Go | yes | packages inside a `go.mod` module (an edge to each non-test file of the package) |
| Rust | yes | `mod x;`, `crate::`/`self::`/`super::` paths, workspace crates by name |
| C# | yes | `using` of a namespace declared in the repo (an edge to each declaring file) |
| Swift | yes | none: modules are `pkg:` |
| GDScript and everything else | no | file-level node only (no maintained prebuilt GDScript grammar) |

Anything that does not resolve inside the repo becomes `pkg:<name>` (the npm package, Python top-level module, Rust
crate, Go import path or C# namespace). A relative import that points at nothing is dropped.

## Incremental builds

Each import keeps its raw `spec`. With `prev`, a file whose sha256 is unchanged keeps its previous symbols and raw
imports, and every import is re-resolved against today's file set, so deleted and renamed targets are handled. A dropped
import is not in `prev`, so an unchanged file that mentions the name of a newly added file is reparsed. A `prev` without
`spec` (an older format) is reparsed.

Symbol names, specifiers and `pkg:` names pass through `redactSecrets` before they leave the module.

## The map stage (`stage.ts`)

`MapStage.kick()` starts a background pass over the selected projects (one at a time; ingest never waits for it).
Per project: at most every `MAP_INTERVAL_MS` (5 minutes), `repoFingerprint` (HEAD, `git status`, size and mtime of
dirty files) is compared with the stored map's; when it differs (or the folder is not a git repo), the map is rebuilt
from the stored one, test links (`testsFor`) and 90-day churn are added, and `replaceCodeMap` writes it in one
transaction. Each build logs a `code_mapped` Activity entry (files, symbols, edges, tests, duration). A scan calls
`mapProject` first, regardless of the interval.
