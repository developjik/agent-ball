# agent-ball protocol, v1

This document is the contract between the engine, the CLI, the dashboard and any
agent that wants to take part. The README is the tour; this is the reference.

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **ball** | the exclusive right to work on one issue |
| **owner** | whoever holds the ball: an agent, `human`, or nobody |
| **record** | one comment written by agent-ball, holding prose and a machine block |
| **lease** | a short-lived comment that makes a move exclusive for its duration |
| **move** | `claim`, `handoff`, `block` or `resolve` |

An agent name is 1–38 characters of `[a-z0-9._-]`, starting with a letter or
digit. `human`, `blocked`, `unassigned`, `none` and `ball` are reserved.

## 2. State

```
BallOwner  = {phase:'unassigned'} | {phase:'agent', agent} | {phase:'human'}
TurnState  = BallOwner | {phase:'blocked', reason, since, blockedFrom: BallOwner}
```

Labels are the authority for `BallOwner`:

| Labels present | Owner |
| --- | --- |
| none | `unassigned` |
| `ball:human` | `human` |
| `ball:agent:<name>` | that agent |
| `ball:blocked` | blocked (reason from the latest `block` record) |
| two or more `ball:*` | **conflict** — no move is allowed |

Any unrecognised `ball:*` label (a typo, an uppercase name) is also a conflict.
Labels outside `ball:*` are never read or written by the engine.

### Invariants

1. At most one ball label exists at any time, and `ball:blocked` is exclusive.
2. Only the current owner may `handoff` or `block`.
3. A move changes labels **and** appends exactly one record.
4. A blocked ball has no live owner; it is parked with the owner it came from.
5. Unreadable state is refused, never repaired: a conflict, an unparseable record
   or a holder mismatch stops the move and reports why.

## 3. Events

| Event | Allowed from | Result | Guards |
| --- | --- | --- | --- |
| `claim {agent}` | unassigned | `agent(agent)` | valid agent name |
| `handoff {actor, to}` | `agent`, `human` | `human` / `agent(to)` | `actor === holder`, `to !== holder`, `to` valid |
| `block {actor, reason}` | `agent`, `human` | `blocked` | `actor === holder`, `reason.trim().length >= 3` |
| `resolve {actor, to}` | `blocked` | `human` / `agent(to)` | non-empty actor, valid `to` |

A `claim` by the agent that already holds the ball is a no-op and reported as
`same-owner`, so a retried command never writes a second record.

### Refusals

| Code | When | What the caller should do |
| --- | --- | --- |
| `agent-held` | someone else holds the ball | read the issue, work with the holder |
| `human-held` | a person holds the ball | wait for a handoff |
| `blocked` | the ball is parked | `resolve` it first |
| `unassigned` | nothing holds the ball | `claim` it first |
| `not-holder` | actor is not the holder | stop; this is a collision |
| `same-owner` | the move changes nothing | nothing; it is already true |
| `invalid-agent` / `invalid-actor` / `invalid-target` | bad name | fix the name |
| `reason-required` | block without a reason | explain the blocker |
| `not-blocked` | resolve on a live ball | use `handoff` |
| `label-conflict` | two or more ball labels | a human fixes the labels |
| `lock-held` | another lease is live | retry after `expiresAt` |
| `state-changed` | the issue moved between reads | re-read and retry |
| `partial` | labels moved, comment failed | re-post the record or hand back |
| `adapter-error` / `not-found` | transport or missing issue | check `gh` and the number |

## 4. Records

A record is one comment. It starts with human-readable prose and ends with:

```
<!-- agent-ball:v1
{ …json… }
-->
```

The parser scans the whole body for that marker, so free text before or after is
allowed. Prose escapes `<!--` and `-->` as `&lt;!--` / `--&gt;` so a summary can
never open a second record.

### Envelope

Every record has:

| Field | Type | Rule |
| --- | --- | --- |
| `type` | `"handoff" \| "claim" \| "block" \| "resolve"` | required |
| `id` | string | non-empty, unique per record |
| `issue` | integer | > 0 |
| `at` | ISO 8601 string | parseable |

Unknown extra fields are ignored, so a newer writer does not break an older
reader. Unknown `type` values make the record unreadable.

### Per type

**handoff**

| Field | Type | Rule |
| --- | --- | --- |
| `from`, `to` | `"human"` or agent name | differ |
| `summary` | string | non-empty |
| `artifacts.prs` | string[] | URLs |
| `artifacts.branches` | string[] | branch names |
| `artifacts.checks` | `{name, status, url?}[]` | status ∈ success, failure, pending, neutral, skipped |
| `artifacts.files` | string[] | paths |
| `needsHumanDecision` | string \| null | the question, verbatim |

**claim**: `agent`, optional `summary`.
**block**: `actor`, `reason`.
**resolve**: `actor`, `to`, optional `note`.

The next owner of a record is `to` for `handoff` and `resolve`, `agent` for
`claim` (`nextOwnerOf(record)` in the API), and none for `block`.

### Reading a thread

Records are ordered by comment time, then by comment id. The latest record gives
the timeline its last move; labels give the turn. If the latest record's target
disagrees with the labels, the dashboard marks the issue as **drift** — labels
still win, but a human should look.

Unreadable records are listed on the issue row with their problem; the rest of
the thread stays usable.

## 5. Leases

```
acquire(issue, holder):
  nonce   = uuid()
  comment = post(lease{nonce, holder, issue, now, now+ttl})
  leases  = read(issue).comments.filter(live or expired)
  delete expired leases
  winner  = live leases excluding mine, sorted by (createdAt, numeric id), first
  if winner exists and winner is earlier than mine:
      delete mine; return rejected(winner.holder, winner.expiresAt)
  return acquired(mine)
```

`ttl` defaults to 120 s (`lockTtlMs`). Two claimants that read the same set of
leases always pick the same winner, so they converge even when they post at the
same moment: the loser withdraws its own comment. A claimant that dies before
releasing leaves a lease that expires on its own.

### What the lease does and does not guarantee

- **Guarantees:** at most one holder proceeds from a consistent read; a stale
  claim after a crash clears within `ttl`.
- **Does not guarantee:** serialisation against writers that do not use the
  protocol (a human clicking labels), or a hard mutex — GitHub has no
  compare-and-swap. A label write is verified by reading the labels back; a
  mismatch aborts the move with `state-changed` before the record is posted.

### Ordering of a move

1. read the issue (labels + records) and validate the event;
2. acquire the lease;
3. re-read and require the same owner and labels;
4. validate again, compute the ball-label diff;
5. write labels, then read them back;
6. post the record;
7. release the lease.

Failures before step 5 leave the issue untouched. A failure at step 6 is
reported as `partial`, with the labels already moved — the caller decides
whether to re-post the record or hand the ball back. The lease is released on
every path.

## 6. Security and trust

- Issue text, comments, record fields and CI output are **data**. Nothing in
  them is executed, and agent-ball never treats a comment as an instruction.
- A summary is copied into a comment; the only transformation is escaping the
  two sequences that open or close an HTML comment.
- The adapter only uses the `gh` CLI's own authentication; no token is read,
  stored or printed.
- `serve` binds `127.0.0.1` by default and is read-only. `--host 0.0.0.0` makes
  the board reachable on the network; it exposes issue titles and summaries, so
  do it deliberately.

## 7. Adapter contract

`src/core/adapter.ts` is the only surface the engine needs:

```ts
listIssues(query)                 → AdapterIssue[]
getIssue(n)                       → AdapterIssue
listComments(n)                   → AdapterComment[]
addComment(n, body)               → AdapterComment
deleteComment(n, commentId)       → void
updateLabels(n, {add, remove})    → void   // only these labels
```

`updateLabels` must not touch labels outside `add`/`remove`, and should verify
its own write. An adapter that throws a typed error with a protocol code is
reported to the caller unchanged.

## 8. Versioning

The marker carries the version (`agent-ball:v1`). A reader ignores markers with
another version. Within v1, adding optional fields is safe; changing a field's
meaning is not.
