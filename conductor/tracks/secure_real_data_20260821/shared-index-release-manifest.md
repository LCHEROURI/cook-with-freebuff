# Cook With Freebuff shared index release manifest

Prepared: 2026-08-22

Audience: the separately authorized owner who reconciles the complete Firestore
index set for the shared Firebase project.

## Scope and authority

This manifest inventories only `LCHEROURI/cook-with-freebuff`. It was produced
without reading any sibling repository or changing Firebase.

Do not access or modify any sibling repository from the Cook track. The
authorized external owner must collect sibling and deployed project evidence in
a separately approved workspace.

This document does not authorize a production configuration change or deploy.
Every deploy still requires explicit approval for the final artifacts, project,
operator, release window, and rollback target.

## Cook source snapshot

| Field | Value |
| --- | --- |
| Repository | `https://github.com/LCHEROURI/cook-with-freebuff.git` |
| Branch | `freebuff/cook-secure-real-data-c4ce5103` |
| Source commit when inventoried | `cecfa4953b88214faefbb1b050f7a21c86fd358d` |
| Source artifact | `firestore.indexes.json` |
| Source lines | 53 |
| Composite indexes | 6 |
| Field overrides | 0 |
| Byte SHA 256 | `b07673b5cfe6389e2ccee37993767deed3f0512586b6faf66fc9dd1007937745` |
| Canonical semantic SHA 256 | `b1b6d5a8042c4cfdaec2a2b74f0d04b28c75c2545ea317b064bf04a076a816d4` |

The source commit is an inventory anchor, not automatic release authority. The
external owner must use the final reviewed Cook PR head. If that head produces a
different checksum or index signature, STOP and request an updated manifest.

## Cook composite index inventory

| ID | Collection | Scope | Ordered fields | Local query trace | Classification |
| --- | --- | --- | --- | --- | --- |
| C1 | `recipes` | `COLLECTION` | `userId ASC`, `updatedAt DESC` | `listRecipes` filters by `userId`; `/api/cook` sorts `updatedAt` in memory | Declared Cook index. Preserve. The current query does not use its ordered shape directly. |
| C2 | `cooking_sessions` | `COLLECTION` | `userId ASC`, `lastActivityAt DESC` | `getActiveSession` and `listSessions` filter by `userId`; active session selection sorts `lastActivityAt` in memory | Declared Cook index. Preserve. The current query does not use its ordered shape directly. |
| C3 | `cooking_session_events` | `COLLECTION` | `sessionId ASC`, `at ASC` | `listSessionEvents` filters by `sessionId` and sorts `at` in memory | Declared Cook index. Preserve. The current query does not use its ordered shape directly. |
| C4 | `timers` | `COLLECTION` | `sessionId ASC`, `status ASC` | `listActiveTimers` and `rebaseActiveTimers` filter by both `sessionId` and `status` | Exact current server query contract: `timers(sessionId ASC, status ASC)`. Required until code and production evidence prove otherwise. |
| C5 | `pantry_items` | `COLLECTION` | `userId ASC`, `lastConfirmedAt DESC` | `listPantryItems` filters by `userId`; pantry service sorts `lastConfirmedAt` in memory | Declared Cook index. Preserve. The current query does not use its ordered shape directly. |
| C6 | `agent_tool_logs` | `COLLECTION` | `userId ASC`, `sessionId ASC`, `at DESC` | Current Cook code writes audit logs but exposes no Firestore read query for this shape | Declared Cook audit index. Preserve unless a separate reviewed removal proves it is unused by every authorized consumer. |

Single field indexes managed automatically by Firestore are outside this tracked
composite index manifest. The empty `fieldOverrides` array means Cook requests
no single field exemptions or custom single field settings.

The classifications above describe current Cook code only. They do not prove
that a declared index is unused by an operational script, older deployment,
external report, or sibling application. Absence of a local query is never
deletion authority.

## Cook artifact verification

From a clean checkout of the final reviewed Cook PR head, run:

```bash
git remote get-url origin
git rev-parse HEAD
git status --short
wc -l firestore.indexes.json
shasum -a 256 firestore.indexes.json
```

Accept only when:

1. The remote is `https://github.com/LCHEROURI/cook-with-freebuff.git`.
2. The commit is the final reviewed Cook PR head supplied by the Cook owner.
3. `git status --short` prints nothing.
4. The file has 53 lines and six index entries.
5. The checksum is
   `b07673b5cfe6389e2ccee37993767deed3f0512586b6faf66fc9dd1007937745`.
6. All signatures C1 through C6 are present exactly once.

STOP on any mismatch. Do not reformat the file, infer that a changed checksum
is harmless, or silently amend this manifest.

## External evidence the authorized owner must collect

In the separately authorized release workspace, collect these three inputs:

1. The final Cook index source verified above.
2. The authorized sibling index source at its reviewed release commit.
3. The current deployed project index inventory, captured read only with:

```bash
firebase firestore:indexes --project portfolio-app-freebuff2
```

Record the source commit and SHA 256 of every input file. Do not paste service
account credentials, access tokens, or other secrets into the evidence record.

The Cook track does not know the full set of sibling or currently deployed
indexes. Treat them as unknown shared-project indexes until the authorized owner
captures and reviews them.

## Canonical comparison method

JSON key order and index array order do not change Firestore semantics. Create a
canonical comparison copy of each input by sorting keys, index entries, and
field override entries. One suitable `jq` transformation is:

```bash
jq -S '
  .indexes |= sort_by(.collectionGroup, .queryScope, (.fields | tostring)) |
  .fieldOverrides = ((.fieldOverrides // []) |
    sort_by(.collectionGroup, .fieldPath))
' <INPUT_JSON> > <CANONICAL_JSON>
```

Compare canonical inputs with:

```bash
git diff --no-index --exit-code -- <FIRST_CANONICAL_JSON> <SECOND_CANONICAL_JSON>
```

A canonical copy of the inventoried Cook file must have this SHA 256 value:

```text
b1b6d5a8042c4cfdaec2a2b74f0d04b28c75c2545ea317b064bf04a076a816d4
```

A nonzero diff is reconciliation work, not permission to overwrite either
source.

## Reconciliation checklist

Build one reviewed complete shared index artifact. Check every item:

- [ ] Capture the final Cook commit, source checksum, and signatures C1 through C6.
- [ ] Capture the authorized sibling commit and source checksum.
- [ ] Capture the current deployed index inventory and timestamp.
- [ ] Canonicalize all three inputs before comparing them.
- [ ] Preserve every currently deployed index unless its deletion has separate review, impact evidence, and approval.
- [ ] Preserve every sibling owned index unless its deletion has separate review, impact evidence, and approval.
- [ ] Include Cook signatures C1 through C6 exactly once.
- [ ] Preserve all field overrides from every authorized source unless a change has separate review and approval.
- [ ] Resolve duplicate signatures without changing field direction or query scope.
- [ ] Treat same collection but different field sequences as distinct indexes, not duplicates.
- [ ] Record every addition, deletion, field direction change, scope change, and field override change.
- [ ] Run semantic review for every proposed deletion before deployment.
- [ ] Save the complete shared artifact, its canonical form, and both SHA 256 checksums.
- [ ] Have an authorized reviewer confirm that the artifact is a superset of all approved retained inputs.
- [ ] Pair the final index artifact with the byte identical complete union ruleset from `union-rules-release-handoff.md`.
- [ ] Record the previous complete rules and index artifacts as the rollback pair.
- [ ] Obtain explicit production approval before any deploy command.

STOP if any source is unavailable, any deletion is unexplained, any Cook
signature is missing, or the complete artifact lacks an authorized reviewer.

## Predeployment validation

In the Cook repository, run the local gates that exercise its indexed query
paths and release documentation:

```bash
npm run check
npm run test:emulator
npx vitest run scripts/secure-real-data-docs.test.ts
```

The external owner must also run the validation required by the authorized
sibling source and the shared release workflow. This Cook manifest cannot name
or waive those checks.

There is no safe Firebase index dry run recorded in this repository. A green
local build does not prove that deleting a deployed index is safe.

## Deployment boundary

Only after reconciliation, review, validation, and explicit production approval
may the authorized owner use the coordinated workflow described by
`union-rules-release-handoff.md`.

The approved workflow may be equivalent to:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project portfolio-app-freebuff2
```

Do not run that command from the Cook repository while
`firestore.indexes.json` remains only the Cook inventory. The release workspace
must point `firebase.json` at the reviewed complete shared index artifact and
the byte identical complete union ruleset.

## Postdeployment verification

Capture the Firebase command exit status, deployment timestamp, operator,
release identifiers, and final artifact checksums. Then verify:

1. The deployed index listing contains every approved complete artifact
   signature and field override.
2. No approved preexisting index disappeared.
3. Cook signatures C1 through C6 are present with the same scope, field order,
   and directions.
4. The exact timers query succeeds through the approved Cook application path.
5. Cook local and emulator gates remain green against the released source.
6. The production isolation proof passes only after `/api/build-info` reports
   the approved Cook revision.

Read back the deployed listing with:

```bash
firebase firestore:indexes --project portfolio-app-freebuff2
```

Canonicalize it and compare it to the approved complete shared artifact. STOP
production acceptance if the semantic diff is nonempty or any index is still
building or reports an error.

## Rollback

Rollback uses the previous complete shared union ruleset and previous complete
shared index artifact as one reviewed pair. Never roll back to Cook's six index
inventory alone.

After rollback, read the deployed index listing again, compare it to the
approved rollback artifact, rerun the relevant application query checks, and
record the incident before another release attempt.

## Evidence block for the authorized external owner

```text
Cook final commit:
Cook source SHA 256:
Cook canonical SHA 256:
Sibling source commit:
Sibling source SHA 256:
Deployed inventory captured at:
Deployed inventory SHA 256:
Complete shared source SHA 256:
Complete shared canonical SHA 256:
Cook signatures C1 through C6 present:
Retained deployed signatures confirmed:
Retained sibling signatures confirmed:
Field overrides reconciled:
Reviewed deletions and approval references:
Union rules SHA 256:
Previous complete rules SHA 256:
Previous complete indexes SHA 256:
Production approval reference:
Firebase deployment identifiers:
Postdeployment semantic comparison:
Postdeployment Cook query verification:
Final decision: PASS or STOP
```
