---
title: Choosing an ID format
description: How to pick between UUID versions, custom ID formats and short readable codes, and why many systems keep an internal key next to a separate public ID.
date: 2026-09-05
tags:
  - databases
  - uuid
  - identifiers
  - postgres
---

The standard advice on ID formats is a ranking: bigint is compact, random UUIDs are bad for indexes, UUIDv7 fixes that, and ULID looks nicer in a URL. The ranking treats an ID as one thing with one job. In practice an ID is a key in an index, a string in a URL, sometimes a code that a person reads out over the phone, and a value that other systems store and never let you change, and the format that suits one of those jobs is often wrong for another.

## The right key depends on how your store places rows

Start with the failing case. In an old [Percona benchmark](https://www.percona.com/blog/store-uuid-optimized-way/) that inserted 25 million rows into MySQL, the table keyed by a random UUID got slower as it grew, with insert time rising almost linearly. Tables keyed by a BIGINT and by a time-ordered UUID stayed nearly flat. The benchmark is old enough that you should rerun it on your own hardware, but the mechanism is general.

A B-tree keeps entries in key order. A key that always increases appends at the right edge of the index, so the page being written is one that is already in memory. A random key lands on a random leaf page, which has to be read in if it isn't cached and split when it's full. [RFC 9562](https://rfc-editor.org/rfc/rfc9562.html) says the same about version 4 UUIDs: poor locality in an index, with time-ordered values clustering better.

Width matters too, and it multiplies. In InnoDB every secondary index entry carries a copy of the primary key, so a wide key makes every secondary index bigger, and the [MySQL manual](https://dev.mysql.com/doc/refman/en/innodb-index-types.html) lists that as a reason to keep the key short. A UUID is 16 bytes in a native `uuid` column or in `BINARY(16)`, against 8 for a bigint. Stored as `CHAR(36)` it takes at least 36 bytes, and RFC 9562 recommends binary storage where you can manage it.

Sequential keys aren't always the good option. Range-partitioned distributed databases split data by key range, so a key that always increases sends every new write to the same range and the same server. Google's [Spanner documentation](https://docs.cloud.google.com/spanner/docs/schema-design) recommends version 4 UUIDs for this reason, because random values spread inserts across the key space, and it names sequential integers and timestamp-leading keys as sources of hotspots. A UUIDv7 puts a timestamp in its high bits, so I'd expect it to behave like a timestamp-leading key there. The first question is where your rows physically go: a single-node B-tree wants keys that arrive in order, and a range-sharded store wants keys that don't.

## UUIDv7 gives you locality and leaves the clock readable

A UUIDv7 holds a 48-bit Unix millisecond timestamp in the high bits, then the version and variant fields, then 74 bits that the generator can fill with random data, a counter, a sub-millisecond fraction, or a mix. RFC 9562 allows all of those and makes the counter and the fraction optional. That is why two compliant libraries can disagree about what happens when you generate ten IDs in the same millisecond.

What you can rely on is coarse ordering: an ID generated later sorts after one generated milliseconds earlier, as long as the clocks agree. Strict order inside a millisecond depends on whether your library implements a counter. Order across processes depends on their clocks agreeing. The embedded time can differ from the real generation time, because the RFC lets implementations adjust it. PostgreSQL's [documentation](https://www.postgresql.org/docs/18/functions-uuid.html) makes the same point about `uuid_extract_timestamp()`: the value is not necessarily the exact moment the UUID was generated. Keep a `created_at` column and don't build business logic on the ID.

PostgreSQL 18 has `uuidv7()`, which builds the timestamp from milliseconds plus a sub-millisecond component and fills the rest with random bits. Both `gen_random_uuid()` and `uuidv4()` return version 4. Earlier versions need the v7 generated in the application or by an extension.

```sql title="uuid-versions.sql"
SELECT uuidv7();                          -- time-ordered
SELECT gen_random_uuid();                 -- version 4, fully random
SELECT uuid_extract_timestamp(uuidv7());  -- creation time, recoverable from the ID alone
```

That last query is the privacy cost. RFC 9562 considers the attack surface of an embedded timestamp very small, and for an order number that is probably right. It's wrong for an ID where the creation time is itself sensitive, such as the moment an account was created. The larger warning in the same section is about guessability: UUIDs must not be used as security capabilities, implementations shouldn't assume they are hard to guess, and where a UUID takes part in a security operation the RFC says to use version 4. An unguessable ID doesn't replace an authorization check. A service that returns any row whose ID you present is vulnerable however random the ID looks.

## Keep an internal key and a public ID when the jobs disagree

The conflict in the last two sections is one ID doing two jobs. The database wants a narrow key that arrives in order. The outside world wants an ID that is unguessable, doesn't reveal when a row was created or how many rows exist, and can change format without breaking anything. One column can't satisfy both, which is why many systems have two: an internal `bigint` primary key and a separate unique `public_id` that appears in URLs and APIs.

```sql title="orders.sql"
CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id  uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  sku      text   NOT NULL
);

-- the API resolves the public ID once, then everything joins on the bigint
SELECT id FROM orders WHERE public_id = $1;
```

The primary key carries the ordering and keeps every foreign key and secondary index at eight bytes. The public ID carries the randomness, so it can be a version 4 UUID with no timestamp in it and no ordering requirement. You pay for one extra unique index, on every insert and on every lookup from the outside, which goes through the public index and then to the row.

Stripe is the usual example. An [article on its object IDs](https://dev.to/stripe/designing-apis-for-humans-object-ids-3o5a) and the discussion under it describe the exposed ID as different from the internal primary key, say ID length varies by resource, and note that IDs have been lengthened before: API keys can now run to 255 characters. The lesson for your own system is to treat every public ID as an opaque string. Size the columns generously, never parse the value, and never let a client infer anything from its format. A separate public column makes that promise cheap to keep, since you can change its format without rewriting a single foreign key.

Exposing the bigint directly leaks how many rows you have and makes enumeration trivial. Encoding it with a library like [Sqids](https://sqids.org/) looks like a middle path, but its own site says it is not an encryption library and warns against using it for user IDs, since anyone who learns the alphabet can work out the user count. It suits short URLs where nobody is attacking anything. It doesn't replace a random public ID.

## Short IDs need a collision plan

People size short IDs by the keyspace. Eight characters of a 32-symbol alphabet is 2^40 values, over a trillion, and a million rows looks nowhere near that. The belief is wrong because collisions arrive long before the keyspace fills. Among n random IDs, the chance that some pair collides is about n(n-1) / (2 * 2^bits), the birthday bound, and it grows with the square of n. This table shows the probability of at least one collision for random IDs in a Crockford base32 alphabet, five bits per character:

| Length | Bits | 10,000 IDs | 1,000,000 IDs | 100,000,000 IDs |
|---|---|---|---|---|
| 6 | 30 | 4.5e-2 | 1.0 | 1.0 |
| 8 | 40 | 4.5e-5 | 0.37 | 1.0 |
| 10 | 50 | 4.4e-8 | 4.4e-4 | 0.99 |
| 12 | 60 | 4.3e-11 | 4.3e-7 | 4.3e-3 |

At eight characters and a million rows there is about a 37% chance that some pair collides. Ten characters brings that to about 4 in 10,000, and twelve to about 4 in 10 million. A UUIDv4 sits at the far end: with 122 random bits it takes roughly 103 trillion IDs to reach a one in a billion chance of any duplicate, a figure the [NanoID documentation](https://github.com/ai/nanoid/) also cites.

The fix is to stop treating the generator as the source of uniqueness and treat the database as the authority. Put a unique constraint on the column and retry on conflict. While the table is far below the collision range the retry almost never runs, and once it runs often it is telling you the code is too short.

```js title="short-id.js"
import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function shortId(length = 10) {
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export async function createInvite(db, data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await db.query(
      `INSERT INTO invites (code, data) VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING
       RETURNING *`,
      [shortId(10), data],
    );
    if (rows.length > 0) return rows[0];
  }
  throw new Error('could not allocate a unique invite code');
}
```

`ON CONFLICT DO NOTHING` matters here. In PostgreSQL a caught unique violation inside a transaction aborts the whole transaction unless you wrap the insert in a savepoint, and this form avoids that. One more constraint applies to short codes that grant access. An attacker doesn't have to guess a specific code, only any valid one, so with a million live codes in a 50-bit space each guess has about a 1 in a billion chance. That is small per guess and not small at request rates a login endpoint can see, so these codes need rate limiting and an expiry.

## The alphabet matters as much as the length

The failing case this time is a case-sensitive alphabet meeting a case-insensitive column:

```sql title="collation.sql"
CREATE TABLE links (
  id     varchar(8) PRIMARY KEY,
  target text NOT NULL
);

INSERT INTO links VALUES ('aB3xK9Qm', 'https://example.com/a');
INSERT INTO links VALUES ('Ab3xK9Qm', 'https://example.com/b');  -- rejected as a duplicate under a case-insensitive collation
```

MySQL 8's default collation, `utf8mb4_0900_ai_ci`, ignores case and accents; the `ai_ci` suffix means exactly that, as MySQL's [announcement of the new collations](https://dev.mysql.com/blog-archive/new-collations-in-mysql-8-0-0/) explains. Those two IDs compare equal, so the second insert fails, and a lookup for one of them can match the other row. Base62, base64 and NanoID's default alphabet of `A-Za-z0-9_-` are all case sensitive, and a case-insensitive collation breaks them without any warning. Check the collation of every column that stores one.

Crockford's base32 is built to avoid this and a few other human problems. Its alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`: the digits plus every letter except I, L, O and U. I and L look like 1, and O looks like 0, so a decoder reads I, i, L and l as 1 and O and o as 0, which means a mistyped code still resolves. U is dropped to avoid accidental obscenities. Per the [draft specification](https://www.ietf.org/archive/id/draft-crockford-davis-base32-for-humans-01.html), decoding is case-insensitive and ignores hyphens, so `k7qm-4t9x` and `K7QM4T9X` are the same code, while encoding produces uppercase only. A and E remain in the alphabet, so words like FACE can still appear. If your product can't tolerate that, filter generated codes against a blocklist.

```js title="normalize.js"
const VALID = /^[0-9A-HJKMNP-TV-Z]+$/;

export function normalizeCode(input) {
  return input
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export const isValidCode = (code) => VALID.test(code);

export function formatCode(code, group = 4) {
  return code.match(new RegExp(`.{1,${group}}`, 'g')).join('-');
}
```

Normalize on the way in, validate, store the canonical form, and add hyphens only for display. The alphabet has a second property worth knowing about: it is in ASCII order, so fixed-length uppercase strings sort the same way as the numbers they encode. That is what lets a [ULID](https://github.com/ulid/spec) sort by time as a plain string. RFC 4648's base32 alphabet (A to Z, then 2 to 7) and base64 lack the property, while base32hex (0 to 9, then A to V) has it, as [this overview of the variants](https://en.wikipedia.org/wiki/Base32) notes. If you want text IDs that sort, you need an order-preserving alphabet, a fixed length and one consistent case.

Crockford also defines an optional check symbol: the value modulo 37, the smallest prime above 32, written with five extra symbols, `*`, `~`, `$`, `=` and `U`. It catches a wrong character or two swapped characters before the lookup hits the database. That is worth having for codes people type from paper, such as gift cards or serial numbers. It is not worth the odd punctuation for IDs that live in URLs.

## Custom formats each fix one complaint about UUIDs

Most named formats are a variation on timestamp, randomness and encoding. Which one fits depends on the complaint you are trying to fix.

| Format | Layout | Text form | Reach for it when | Watch for |
|---|---|---|---|---|
| UUIDv4 | 128 bits, 122 random | 36 hex characters with hyphens | The ID is public, or the store is range-sharded | Random inserts into a B-tree |
| UUIDv7 | 48-bit ms timestamp, then random, counter or fraction bits | Same as v4 | The ID is the primary key of a single-node store | Readable creation time; order inside a millisecond depends on the library |
| ULID | 48-bit ms timestamp, 80 random bits | 26 Crockford base32 characters | You want the v7 shape with a shorter, case-insensitive text form | The base spec doesn't guarantee order inside a millisecond; the monotonic variant errors on overflow |
| [KSUID](https://github.com/segmentio/ksuid) | 32-bit timestamp in seconds from a 2014 epoch, 128 random bits | 27 base62 characters | You want sortable strings and can spend 20 bytes | Case-sensitive alphabet; ordering depends on wall clocks |
| [Snowflake](https://en.wikipedia.org/wiki/Snowflake_ID) | 41-bit ms timestamp, 10-bit machine, 12-bit sequence | 64-bit integer | You need sortable 8-byte IDs without a central allocator | Assigning unique machine IDs; clock rollback; predictable values |
| NanoID | 126 random bits by default | 21 characters of `A-Za-z0-9_-` | You want a compact random string | Case-sensitive; custom alphabets change the collision math |
| [TypeID](https://github.com/jetify-com/typeid) | Type prefix, underscore, UUIDv7 | Prefix plus 26 base32 characters | You want the ID to say what it identifies | Inherits the v7 properties above |

Snowflake-style IDs are where a custom layout earns its keep: 64 bits fit in a bigint, sort by time, and need no coordination at generation time beyond giving each generator a unique machine ID. Instagram and Discord use variants, with a different bit split in Instagram's case and a different epoch in Discord's. The format doesn't solve machine ID assignment or what happens when a clock steps backward, so your generator has to.

Prefixed IDs are the one idea in this table I'd adopt regardless of the rest. The prefix costs a few bytes, and it tells you what an ID is when it turns up in a log line, a support ticket or a chat message. Stripe's `cus_` and `pi_` are the common example, and the Stripe article mentioned earlier says that in hindsight its author would have chosen longer, clearer prefixes, such as `payint_` in place of `pi_`. Where you can, keep the prefix out of the database column: store the bare UUID in a `uuid` column and add and strip the prefix at the API boundary. That keeps the key at 16 bytes and lets the database type-check it. Stripe's article says it stores the full prefixed string, so it is a trade: you gain size and typing, and you lose the ability to grep a database dump for `cus_`.

## How to choose, and what stays hard

| Situation | Use |
|---|---|
| Single-node relational store, rows referenced by foreign keys | A `bigint` identity as the internal key |
| Any ID an outside party sees | A separate `public_id`: random, opaque, ideally prefixed |
| Range-sharded distributed store | A random key such as UUIDv4, or a hashed shard column in front of a sequence |
| One ID column only, on a single-node store | UUIDv7 in a native `uuid` column, plus a `created_at` column |
| People read, type or say the ID | Crockford base32 of ten characters or more, normalized on input, with a unique constraint and retry |
| Text IDs that must sort | An order-preserving alphabet, fixed length, one case |

The part I don't have a clean answer for is retiring a format. Once an ID has appeared in a URL, a partner's database, a webhook payload and a bookmark, changing it means running both formats side by side for as long as anyone still holds the old one, and no choice above avoids that. Treating IDs as opaque strings from the first day, with a separate public column you can re-mint, shrinks the migration, but I don't have a design that makes it free.
