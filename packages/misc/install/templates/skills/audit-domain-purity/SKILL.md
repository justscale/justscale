---
name: audit-domain-purity
description: Static audit for JustScale domain-purity violations — `id`/`createdAt`/`updatedAt` fields in `defineModel`, infra package imports from `domain/`, `findById('...')` patterns, repository mutators called without `Locked<T>`, and hand-painted span-coloured code in docs. Run before commits or during code review. Reports violations with file:line; does NOT auto-fix.
allowed-tools: Bash, Read, Grep
---

# Skill: audit-domain-purity

Run a static audit against `$ARGUMENTS` (default: `.`) for JustScale's
domain-purity rules. This is the rule book made executable.

The script-style checks below are intentionally crude — `grep` and `git
log` over a real AST. Crude is fine: this is a triage tool. False
positives are easier than missed violations. Run before a commit, in CI,
or during review.

## What to check

### 1. Infrastructure fields in domain models

Domain `defineModel` blocks must NOT define `id`, `createdAt`, or
`updatedAt`. The adapter owns those concerns and stores them via
non-enumerable symbols. Putting them in domain fields breaks the
ID-free principle and leaks adapter details upward.

```bash
!grep -rEn "(^|[[:space:]])(id|createdAt|updatedAt):[[:space:]]*field\." "$ARGUMENTS" --include="*.ts" 2>/dev/null \
  | grep -v "/dist/" \
  | grep -v "/migration"
```

### 2. Infra imports from domain

Files under any `domain/` folder must NOT import from
`@justscale/postgres`, `@justscale/redis`, or sibling `infra/` paths.
Domain is storage-agnostic; if it knows about Postgres, the abstraction
is broken.

```bash
!for d in $(find "$ARGUMENTS" -type d -name "domain*" 2>/dev/null); do
  grep -rEn "from ['\"]@justscale/(postgres|redis)['\"]|from ['\"](\.\./)*infra/" "$d" --include="*.ts" 2>/dev/null
done
```

### 3. String IDs leaking into domain code

`findById('...')` reveals that callers are passing loose strings instead
of typed refs. Domain methods take `Ref<T>` / `Persistent<T>` /
`Locked<T>`. If a service does `findById`, the boundary above it should
have already converted the string via `Model.ref\`${id}\``.

```bash
!grep -rEn "\.findById\(['\"]" "$ARGUMENTS" --include="*.ts" 2>/dev/null \
  | grep -v "/test/" \
  | grep -v "/dist/"
```

### 4. Repository mutators without `Locked<T>`

`repo.update` / `repo.save` / `repo.delete` requires `Locked<T>` at
compile time, but it's easy to miss in review. Best-effort grep —
inspect each match by hand:

```bash
!grep -rEn "\.(update|save|delete)\([a-zA-Z_][a-zA-Z0-9_]*," "$ARGUMENTS" --include="*.ts" 2>/dev/null \
  | grep -v "/test/" \
  | grep -v "/dist/"
```

For each match: was the variable declared with `using x = await
repo.lock(...)`? If not, flag it. The compiler catches this, but a grep
sweep before commit catches drift faster than a build.

### 5. Hand-painted span-coloured code in docs

Doc-page code samples should use `FileTreeServer` / `FileTreeClient` /
`Code`. Hand-rolled `<span className="text-purple-400">` colouring drifts
from real syntax over time — and it doesn't get type-hinting. If you
find any, replace with a real Monaco panel.

```bash
!grep -rEn '<span className="text-(purple|blue|green|orange|zinc)-[0-9]+">' "$ARGUMENTS" --include="*.tsx" 2>/dev/null \
  | grep -v "/dist/" \
  | head -30
```

### 6. (Optional) Hand-edited migrations

Migrations are generated artifacts. A migration file with multiple
commits in its history was probably edited by hand — fix the generator
instead. This check has false positives (legitimate fixes also produce
multiple commits), so present it as a flag, not a violation.

```bash
!for f in $(find "$ARGUMENTS" -path "*/migrations/*.ts" -type f 2>/dev/null); do
  count=$(git log --oneline -- "$f" 2>/dev/null | wc -l | tr -d ' ')
  [ "$count" -gt "1" ] && echo "$f: $count commits (hand-edit suspected)"
done
```

## Report format

Group findings by check number. For each finding:

```
[1 infra-fields] file:line — id/createdAt/updatedAt in defineModel
  > offending excerpt
```

End with a count summary:

```
N findings: A infra-fields, B infra-imports, C string-ids, D missing-Locked, ...
```

If a check has zero hits, omit it entirely from the report — silence is
the success state.

## Don't auto-fix

This is a triage tool. Print findings; let the user decide what to fix
and how. Auto-fixing rule violations across a codebase causes more churn
than it saves and obscures the real problem (often a misplaced
abstraction, not the surface symptom).
