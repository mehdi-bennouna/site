---
title: Postgres Transaction Isolation Levels in Practice
description: What Read Committed, Repeatable Read, and Serializable do in PostgreSQL, which anomalies each one allows, and where the surprises are.
date: 2026-10-25
tags:
  - postgres
  - databases
  - transactions
---

Most Postgres code runs at the default isolation level because nobody ever picked one. That's fine until two requests touch the same rows. Then the level decides whether a withdrawal silently disappears, whether one transaction gets aborted, or whether both succeed and break a rule the database knows nothing about.

## Three levels, not four

The SQL standard lists four isolation levels, and Postgres accepts all four names. In practice there are only three behaviors.

| Level | Postgres behavior |
| --- | --- |
| Read Uncommitted | Treated exactly like Read Committed |
| Read Committed | The default |
| Repeatable Read | Snapshot isolation |
| Serializable | Serializable Snapshot Isolation (SSI) |

Read Uncommitted is an alias for Read Committed. Postgres never shows you uncommitted data: MVCC gives readers a snapshot of committed rows, and readers and writers don't block each other, so a dirty-read mode would have no point.

## Which anomalies each level allows

Isolation levels are defined by the anomalies they allow, so the names are worth pinning down first:

- Dirty read: you read data another transaction has written but not yet committed.
- Non-repeatable read: you read a row twice in one transaction and get different values because someone committed a change in between.
- Phantom read: you run the same query twice and get a different *set* of rows because someone inserted or deleted matching rows in between.
- Serialization anomaly: the combined result of several committed transactions doesn't match *any* one-at-a-time ordering of them.

The last one is the slippery one, and most of this post is about it. Here is what Postgres allows at each level:

| Level | Dirty read | Non-repeatable read | Phantom read | Serialization anomaly |
| --- | --- | --- | --- | --- |
| Read Uncommitted | No | Possible | Possible | Possible |
| Read Committed | No | Possible | Possible | Possible |
| Repeatable Read | No | No | No | Possible |
| Serializable | No | No | No | No |

The Repeatable Read row is a little unusual. The standard allows phantom reads at that level, but Postgres doesn't, because every statement in the transaction reads from one snapshot.

## Setting the level

A level can be picked per transaction:

```sql title="set-level.sql"
BEGIN ISOLATION LEVEL REPEATABLE READ;
-- ... your statements ...
COMMIT;

-- or, as the first statement inside the transaction
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

The `SET TRANSACTION` form has to come before any query in the transaction, or Postgres raises an error. The default can be changed for a whole database:

```sql title="defaults.sql"
ALTER DATABASE shop SET default_transaction_isolation = 'repeatable read';
```

## Read Committed: each statement gets its own snapshot

It's easy to assume a transaction sees a frozen view of the database. At the default level it doesn't. Each *statement* sees what was committed when that statement started, so two statements in the same transaction can see different data.

```sql title="read-committed.sql"
-- Session A
BEGIN;
SELECT count(*) FROM orders WHERE status = 'pending';   -- 10

-- Session B
INSERT INTO orders (status) VALUES ('pending');
COMMIT;

-- Session A
SELECT count(*) FROM orders WHERE status = 'pending';   -- 11
COMMIT;
```

Session A gets two different answers inside one transaction. That's a phantom read, and it's allowed here.

### Concurrent updates re-check the row

If an `UPDATE` or `DELETE` hits a row that another transaction has already changed, Postgres waits for that transaction to finish. If it committed, Postgres re-checks the `WHERE` clause against the *new* version of the row and applies the change if it still matches.

That makes an update like this safe:

```sql title="safe-update.sql"
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
```

Two concurrent runs both take effect, one after the other. Doing the same thing from application code is not safe at this level:

```python title="unsafe.py"
balance = db.query("SELECT balance FROM accounts WHERE id = 1")
db.execute("UPDATE accounts SET balance = %s WHERE id = 1", (balance - 100,))
```

If two requests interleave, both read the same starting balance and one withdrawal silently disappears. That's a lost update, and moving the arithmetic into the `UPDATE` statement is the simplest way to avoid it.

## Repeatable Read: one snapshot for the whole transaction

The snapshot is taken when the transaction runs its first query, and every later statement uses it. Commits from other sessions stay invisible until the transaction ends.

```sql title="repeatable-read.sql"
-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM orders WHERE status = 'pending';   -- 10

-- Session B
INSERT INTO orders (status) VALUES ('pending');
COMMIT;

-- Session A
SELECT count(*) FROM orders WHERE status = 'pending';   -- still 10
COMMIT;
```

That suits a report or export that runs several queries and needs them to agree with each other.

### First-updater-wins

Write conflicts behave differently here too. This is the lost-update pattern again, this time at Repeatable Read:

```sql title="lost-update.sql"
-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM accounts WHERE id = 1;              -- 1000

-- Session B
UPDATE accounts SET balance = 900 WHERE id = 1;
COMMIT;

-- Session A
UPDATE accounts SET balance = 900 WHERE id = 1;
```

```text frame="terminal"
ERROR:  could not serialize access due to concurrent update
```

The row changed after A's snapshot was taken, so Postgres refuses to let A overwrite data it never saw and aborts the transaction. That protects the data, but the application has to be ready to retry.

## Write skew still gets through

Repeatable Read still allows serialization anomalies. Write skew is the standard example. Say a rule requires at least one doctor to be on call at all times:

```sql title="setup.sql"
CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL);
INSERT INTO doctors VALUES ('alice', true), ('bob', true);
```

Alice and Bob both try to go off call at the same time:

```sql title="write-skew.sql"
-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call;             -- 2, so it is safe to leave
UPDATE doctors SET on_call = false WHERE name = 'alice';

-- Session B
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call;             -- 2, so it is safe to leave
UPDATE doctors SET on_call = false WHERE name = 'bob';

-- Both sessions
COMMIT;
```

Both commits succeed because the transactions updated *different* rows, so Postgres sees no write conflict. Each one made a reasonable decision from its own snapshot, and together they left nobody on call. If they had run one after the other, that couldn't have happened.

## Serializable catches it

Run the same scenario at `SERIALIZABLE` and one of the transactions fails:

```text frame="terminal"
ERROR:  could not serialize access due to read/write dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.
HINT:  The transaction might succeed if retried.
```

Postgres uses Serializable Snapshot Isolation (SSI) here. It's built on the same snapshots as Repeatable Read, but it also tracks read/write dependencies between concurrent transactions, and it aborts one of them when it spots a pattern that could produce a non-serializable result.

A few things about how it behaves:

- Readers still don't block writers. SSI tracks reads without taking blocking locks, so the cost is occasional aborts instead of waiting.
- It can cancel transactions that would have been fine. The detection is conservative. Good indexes help, because they let Postgres track reads more finely than whole pages or tables.
- Every transaction involved has to run at Serializable. Mixing levels weakens the guarantee.

The appeal is the mental model: if each transaction is correct on its own, they're correct together.

## The cost is retrying

Repeatable Read and Serializable can both fail with SQLSTATE `40001` (`serialization_failure`), and deadlocks use `40P01`. In both cases the fix is to roll back and rerun the whole transaction from the start.

```python title="retry.py"
import random
import time

import psycopg
from psycopg import errors


def run_serializable(conn, work, max_attempts=5):
    conn.isolation_level = psycopg.IsolationLevel.SERIALIZABLE
    for attempt in range(1, max_attempts + 1):
        try:
            with conn.transaction():
                return work(conn)
        except (errors.SerializationFailure, errors.DeadlockDetected):
            if attempt == max_attempts:
                raise
            # exponential backoff with jitter
            time.sleep(random.uniform(0, 0.05 * 2**attempt))
```

The retried block has to be self-contained. Anything with side effects outside the database, like sending an email or charging a card, belongs after a successful commit, or a retry will repeat it.

## Sometimes locks are enough

A stricter isolation level isn't always needed. When the conflict is about specific rows, `FOR UPDATE` at Read Committed is often simpler and cheaper:

```sql title="explicit-locks.sql"
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;   -- others wait here
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

Concurrent transactions queue up on the row, so there is usually nothing to retry. `FOR UPDATE SKIP LOCKED` is handy for work queues, since many workers can grab different rows without stepping on each other.

Write skew is harder to fix with row locks, because the rule spans several rows, including rows nobody modifies. The options are locking a shared "guard" row, adding a constraint, or using Serializable.

## Choosing a level

The choice comes down to which failure you'd rather deal with: a silent anomaly at Read Committed, or an aborted transaction at the higher levels.

| If you need... | Reach for... |
| --- | --- |
| Normal OLTP queries and single-statement updates | Read Committed |
| Reports or exports that need a stable view across several queries | Repeatable Read (ideally `READ ONLY`) |
| Invariants that span multiple rows or tables | Serializable, with retries |
| Row-level coordination such as counters or queues | Read Committed with `FOR UPDATE` or `SKIP LOCKED` |

A workable default is Read Committed, with updates written as single atomic statements and explicit locks on hot rows. Individual transactions can move up to Serializable when correctness depends on a rule that spans more than one row.

There's also `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE` for long analytical reads. It waits until it can take a snapshot that is guaranteed safe, then runs without any risk of being cancelled.

Serializable can't tell you ahead of time which transactions it will cancel, so the retry loop has to exist before it's needed. One check works for every level:

> If a transaction reads something and then writes based on what it read, check what happens when two of them run at the same time.
