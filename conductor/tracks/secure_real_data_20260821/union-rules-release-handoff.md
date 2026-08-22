# Cook With Freebuff shared Firestore release handoff

Prepared: 2026-08-22

Audience: the separately authorized owner of the shared Firebase rules release.

## Scope and authority

This handoff comes only from `LCHEROURI/cook-with-freebuff`. It does not grant
this track authority over any sibling repository or application.

Do not access or modify the sibling application from the Cook track. The
external release owner performs the cross repository work in a separately
authorized workspace and records the evidence requested below.

No command in this document authorizes a production change. Obtain explicit
approval for the exact project, artifacts, and rollback target before running a
Firebase deploy command.

## Cook source identity

The reviewed Cook source at the time this handoff was prepared was:

| Field | Value |
| --- | --- |
| Repository | `https://github.com/LCHEROURI/cook-with-freebuff.git` |
| Branch | `freebuff/cook-secure-real-data-c4ce5103` |
| Source commit | `4cb068997aae12ce08cf3bc43c49e66d9fe0a904` |
| Firebase project named by the tracked release configuration | `portfolio-app-freebuff2` |

The feature branch still needs to incorporate the newer `origin/main` commit
before publication. The external owner must use the final reviewed PR head, not
blindly trust the source commit above. If conflict resolution changes either
artifact checksum, STOP and request an updated handoff.

## Artifact manifest

| Artifact | Lines | SHA 256 | Release meaning |
| --- | ---: | --- | --- |
| `firestore.rules` | 174 | `a008bfcf320171ddf022f92c4d57e57e62539045e8b20ed42fc736eccb1b24f4` | Complete shared union ruleset. This is the byte identity target. |
| `firestore.indexes.json` | 53 | `b07673b5cfe6389e2ccee37993767deed3f0512586b6faf66fc9dd1007937745` | Cook index inventory only. It is not a certified shared union index artifact. |

The ruleset contains the unchanged non Cook prefix, the tightened Cook clauses,
and the final default deny catch all. Only the Cook section changed in Phase 3A.

The tracked index file contains indexes for Cook collections. It does not prove
that every index needed by the other application in the shared Firebase project
is present. Do not deploy Cook's index file as if it were the complete shared
index set.

## Step 1: verify the Cook release candidate

Use a clean checkout of the final reviewed Cook PR head. Run:

```bash
git remote get-url origin
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
shasum -a 256 firestore.rules firestore.indexes.json
```

Accept this step only when:

1. The remote is `https://github.com/LCHEROURI/cook-with-freebuff.git`.
2. The commit is the final reviewed PR head supplied by the Cook release owner.
3. `git status --short` prints nothing.
4. The rules checksum is
   `a008bfcf320171ddf022f92c4d57e57e62539045e8b20ed42fc736eccb1b24f4`.
5. The Cook index inventory checksum is
   `b07673b5cfe6389e2ccee37993767deed3f0512586b6faf66fc9dd1007937745`.

STOP if any identity or checksum differs. Do not normalize whitespace, copy only
the Cook section, or regenerate the rules file. Ask the Cook release owner for
a reviewed replacement manifest.

## Step 2: prove the Cook rules contract before synchronization

From the clean Cook checkout, run:

```bash
npm run test:rules
npx vitest run scripts/firestore-rules-scope.test.ts
```

Required evidence:

1. The Firestore authorization suite passes all 29 tests.
2. The five scope lock tests pass.
3. Owner, second user, anonymous, ownership transfer, append only, and server
   managed denial cases remain green.
4. The non Cook prefix and final catch all remain byte pinned.

STOP on any failure. A checksum match does not override a failed contract test.

## Step 3: synchronize the complete ruleset externally

The authorized external owner must copy the complete `firestore.rules` file
from the final Cook PR head into the authorized sibling rules workspace. Do not
copy only the Cook matches.

Before replacing anything, preserve the sibling's current rules and index
artifacts plus their checksums as the rollback candidate. Reconcile any newer
shared changes through review. Never overwrite a newer non Cook clause merely
to force the checksum in this handoff.

After synchronization, compare the two complete rules files:

```bash
git diff --no-index --exit-code -- <COOK_RULES_PATH> <SIBLING_RULES_PATH>
shasum -a 256 <COOK_RULES_PATH> <SIBLING_RULES_PATH>
```

The diff command must print no differences and exit zero. Both files must have
this SHA 256 value:

```text
a008bfcf320171ddf022f92c4d57e57e62539045e8b20ed42fc736eccb1b24f4
```

Record the final Cook commit and the authorized sibling commit. STOP if the
files are not byte identical.

## Step 4: build and verify the complete shared index artifact

The external owner must reconcile the current deployed project indexes, the
authorized sibling index source, and Cook's `firestore.indexes.json` into one
reviewed shared index artifact.

Use `shared-index-release-manifest.md` for the Cook signatures, canonical JSON
comparison method, reconciliation checklist, deployment stops, and evidence
record.

The Cook inventory checksum is useful for proving that Cook's six composite
indexes were considered. It is not permission to remove or replace non Cook
indexes.

Before deployment, record:

1. The complete shared index artifact path and SHA 256 checksum.
2. Evidence that all Cook indexes in `firestore.indexes.json` are present.
3. Evidence that every preexisting non Cook index is preserved unless its
   removal has separate review and approval.
4. The previous complete shared rules and index checksums for rollback.

STOP if a complete shared index artifact cannot be produced. Do not deploy
`firestore:indexes` from the Cook inventory alone.

## Step 5: obtain the production release approval

The approval record must name:

1. The Firebase project.
2. The final Cook commit.
3. The synchronized sibling commit.
4. The shared rules checksum.
5. The complete shared index checksum.
6. The previous synchronized rules and index checksums used for rollback.
7. The authorized operator and release window.

Without that approval, STOP. Do not deploy.

## Step 6: deploy through the authorized shared release workflow

Only after Steps 1 through 5 pass, the authorized owner may run the approved
workflow equivalent of:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project portfolio-app-freebuff2
```

Run this command only from a release workspace whose `firebase.json` points to
the byte identical complete union ruleset and the reviewed complete shared index
artifact. Do not run it from the Cook repository while its index file remains a
Cook only inventory.

Capture the command exit status, Firebase release identifiers, timestamp,
operator, rules checksum, and complete index checksum.

## Step 7: verify after deployment

First, confirm that the deployed release identifiers and sources match the
approved artifacts. Then rerun the Cook local rules contract against the exact
deployed source files:

```bash
npm run test:rules
npx vitest run scripts/firestore-rules-scope.test.ts
```

After the approved Cook application revision is live and `/api/build-info`
reports that revision, run the guarded production isolation proof:

```bash
npm run verify:real-data
```

Required production evidence:

1. Owner create, read, update, and delete succeed.
2. A second authenticated user cannot read, update, or delete the owner record.
3. Owner deletion is read back as absent.
4. Temporary data and both temporary Auth users are removed.

`npm run verify:real-data` proves the production pantry path. It does not prove
every Cook collection in production. Keep the full post deployment owner matrix
check open until the authorized release owner records equivalent owner, second
user, anonymous, ownership transfer, append only, and server managed evidence
for every Cook rule family.

STOP production acceptance if any proof fails, cleanup is incomplete, or the
deployed artifacts cannot be tied to the approved checksums.

## Rollback rule

Rollback only to the previous complete synchronized shared ruleset and complete
shared index artifact. Never deploy a Cook only rules fragment or the Cook only
index inventory as a rollback.

After rollback, repeat the deployed source identity check and all applicable
local and production verification. Record the incident before attempting a new
release.

## Evidence block for the external owner

```text
Cook final commit:
Sibling synchronization commit:
Cook rules SHA 256:
Sibling rules SHA 256:
Complete shared index SHA 256:
Previous rules rollback SHA 256:
Previous index rollback SHA 256:
Predeployment rules tests:
Byte comparison result:
Production approval reference:
Firebase rules release identifier:
Firebase indexes release identifier:
Deployment timestamp and operator:
Post deployment source identity:
Production isolation proof:
Full owner matrix evidence:
Cleanup evidence:
Final decision: PASS or STOP
```
