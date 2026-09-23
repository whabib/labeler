<h1 align="center">labeler</h1>

A lightweight alternative to Ozone for operating an atproto labeler.

Forked from [skyware-js/labeler](https://github.com/skyware-js/labeler).

## CLI

The `labeler` package also comes with a CLI for setting up and managing a labeler.

```sh
$ npx github:whabib/labeler
Usage: npx github:whabib/labeler [command]
Commands:
  setup - Initialize an account as a labeler.
  clear - Restore a labeler account to normal.
  recreate - Recreate the labeler declaration (recommended if labels are not showing up).
  label add - Add new label declarations to a labeler account.
  label delete - Remove label declarations from a labeler account.
  label edit - Bulk edit label definitions.
```

To set up a new labeler account, run the `setup` command above.

## Installation

```sh
npm install github:whabib/labeler
```

## Example Usage

This library requires an existing labeler declaration. To get set up, use the `setup` command of the [CLI](#cli).

```js
import { LabelerServer } from "labeler";

const server = new LabelerServer({ did: "···", signingKey: "···" });

server.start(14831, (error, address) => {
    if (error) {
        console.error(error);
    } else {
        console.log(`Labeler server listening on ${address}`);
    }
});
```

## Storage

By default, labels are stored in a local SQLite file (`labels.db`). Use `dbPath` to change its location, or `dbUrl` and `dbToken` to use a remote libSQL database.

### PostgreSQL

To store labels in PostgreSQL instead, pass the `postgres` option with either a connection string or an existing [`pg`](https://node-postgres.com) pool:

```js
import { LabelerServer } from "labeler";

const server = new LabelerServer({
    did: "···",
    signingKey: "···",
    postgres: {
        connectionString: process.env.DATABASE_URL,
        // Optional, defaults to "labels". May be schema-qualified; the table name itself
        // can be up to 55 lowercase letters, digits and underscores.
        table: "labeler.labels",
    },
});
```

The schema, table and index are created on startup if they don't exist. A pool you pass in is never closed by the server.

Several servers can share one table (for example, while an old and a new deployment overlap): inserts take a Postgres advisory lock so label ids are committed in order.

`cts` and `exp` are stored as text, because labels are signed over the exact timestamp strings.

To import existing labels with their original ids, insert them with explicit `id` values after the server has created the table (`await server.ready()`), then advance the id sequence:

```sql
SELECT setval(pg_get_serial_sequence('labeler.labels', 'id'), (SELECT MAX(id) FROM labeler.labels));
```

### Development

`pnpm test` runs the integration tests against SQLite. To also run them against PostgreSQL, point `TEST_DATABASE_URL` at a disposable database. The tests create and drop tables in a `labeler_test` schema.

```sh
docker run -d --rm --name labeler-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:18
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/postgres pnpm test
```

## Upgrading to 0.3.0

- The public `db` field (a libSQL client) was replaced by `store`, which works with both SQLite and PostgreSQL. `createLabel` and `createLabels` return each label's `id` and signature, so there's no need to query the database after creating a label.
- `close()` now also closes the database connection, unless you passed in your own Postgres pool.
