import { secp256k1 as k256 } from "@noble/curves/secp256k1";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import * as ui8 from "uint8arrays";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LabelerServer } from "../src/LabelerServer.js";
import { type PgPoolLike, PostgresLabelStore } from "../src/store/PostgresLabelStore.js";
import { SqliteLabelStore } from "../src/store/SqliteLabelStore.js";

const did = "did:plc:ragtjsm2j2vknq6zbnujgah7";
const signingKey = ui8.toString(k256.utils.randomPrivateKey(), "hex");

describe("Postgres store options", () => {
	it.each([
		"labels; DROP TABLE users",
		"Labels",
		"a.b.c",
		"\"quoted\"",
		"1labels",
		"",
		"x".repeat(56),
		`s.${"x".repeat(56)}`,
	])("rejects the table name %j", (table) => {
		expect(() => new PostgresLabelStore({ connectionString: "postgres://x", table })).toThrow(
			/Invalid Postgres table name/,
		);
	});

	it("accepts plain and schema-qualified table names", () => {
		for (const table of ["labels", "labeler.labels_development", "_x.y_1", "x".repeat(55)]) {
			expect(() => new PostgresLabelStore({ connectionString: "postgres://x", table })).not
				.toThrow();
		}
	});

	it("requires exactly one of pool and connectionString", () => {
		expect(() => new PostgresLabelStore({})).toThrow(/either `pool` or `connectionString`/);
		const pool = new pg.Pool();
		expect(() => new PostgresLabelStore({ pool, connectionString: "postgres://x" })).toThrow(
			/not both/,
		);
	});

	it("cannot be combined with SQLite options", () => {
		expect(() =>
			new LabelerServer({
				did,
				signingKey,
				dbPath: "labels.db",
				postgres: { connectionString: "postgres://x" },
			})
		).toThrow(/cannot be combined/);
	});
});

describe("SQLite store", () => {
	it("rejects stored labels that have no signature", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "labeler-store-"));
		const store = new SqliteLabelStore({ dbPath: path.join(dir, "labels.db") });
		try {
			await store.init();
			await store.db.execute(
				`INSERT INTO labels (src, uri, val, cts) VALUES ('${did}', 'did:plc:x', 'v', '2026-01-01T00:00:00Z')`,
			);
			await expect(store.query({ uriPatterns: [], sources: [], cursor: 0, limit: 10 }))
				.rejects.toThrow(/has no signature/);
		} finally {
			await store.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("Postgres store", () => {
	let pool: pg.Pool;
	const tables: Array<string> = [];
	const newTable = () => {
		const table = `labeler_test.store_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
		tables.push(table);
		return table;
	};

	beforeAll(() => {
		pool = new pg.Pool({ connectionString: testDatabaseUrl });
	});

	afterAll(async () => {
		for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
		await pool.end();
	});

	it("keeps ids unique and ordered when two servers share a table", async () => {
		const table = newTable();
		const a = new LabelerServer({ did, signingKey, postgres: { pool, table } });
		const b = new LabelerServer({ did, signingKey, postgres: { pool, table } });

		const created = await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				(i % 2 ? a : b).createLabel({ uri: `did:plc:shared${i}`, val: "shared" })),
		);
		const ids = created.map((label) => label.id).sort((x, y) => x - y);
		expect(new Set(ids).size).toBe(40);

		const stored = await a.store.query({ uriPatterns: [], sources: [], cursor: 0, limit: 100 });
		expect(stored.map((label) => label.id)).toEqual(ids);
	});

	it("allows importing rows with explicit ids, then continues after the maximum", async () => {
		const table = newTable();
		const server = new LabelerServer({ did, signingKey, postgres: { pool, table } });
		await server.ready();

		// This is how an existing label history is migrated in, keeping its ids
		await pool.query(
			`INSERT INTO ${table} (id, src, uri, val, neg, cts, sig)
			VALUES (100, $1, 'did:plc:imported', 'imported', false, '2026-01-01T00:00:00.000Z', '\\x00')`,
			[did],
		);
		await pool.query(
			`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`,
		);

		const next = await server.createLabel({ uri: "did:plc:afterimport", val: "next" });
		expect(next.id).toBe(101);
		expect(await server.store.maxId()).toBe(101);
	});

	it("uses the same lock for a table with and without its schema", async () => {
		const name = newTable().split(".")[1];
		tables.push(`public.${name}`);
		const unqualified = new PostgresLabelStore({ pool, table: name });
		const qualified = new PostgresLabelStore({ pool, table: `public.${name}` });
		await Promise.all([unqualified.init(), qualified.init()]);

		const lockKey = (store: PostgresLabelStore) =>
			(store as unknown as { lockKey: string }).lockKey;
		expect(lockKey(unqualified)).toBe(`labeler:public.${name}`);
		expect(lockKey(qualified)).toBe(lockKey(unqualified));
	});

	it("keeps using the resolved schema when connections have a different search_path", async () => {
		const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
		const [resolved, other] = [`labeler_sp_a_${suffix}`, `labeler_sp_b_${suffix}`];
		await pool.query(`CREATE SCHEMA ${resolved}`);
		await pool.query(`CREATE SCHEMA ${other}`);
		const poolA = new pg.Pool({
			connectionString: testDatabaseUrl,
			options: `-c search_path=${resolved}`,
		});
		const poolB = new pg.Pool({
			connectionString: testDatabaseUrl,
			options: `-c search_path=${other}`,
		});
		// Resolving the schema sees `resolved`; every later query runs with `other`
		const mixedPool: PgPoolLike = {
			query: (text, values) =>
				(text.includes("current_schema()") ? poolA : poolB).query(text, values),
			connect: () => poolB.connect(),
			end: () => Promise.resolve(),
		};

		try {
			const server = new LabelerServer({
				did,
				signingKey,
				postgres: { pool: mixedPool, table: "labels" },
			});
			await server.createLabel({ uri: "did:plc:searchpath", val: "sp" });

			const tablesFound = await pool.query(
				"SELECT table_schema FROM information_schema.tables WHERE table_name = 'labels' AND table_schema IN ($1, $2)",
				[resolved, other],
			);
			expect(tablesFound.rows.map((row) => row.table_schema)).toEqual([resolved]);
			const count = await pool.query(`SELECT COUNT(*)::int AS n FROM ${resolved}.labels`);
			expect(count.rows[0].n).toBe(1);
		} finally {
			await Promise.all([poolA.end(), poolB.end()]);
			await pool.query(`DROP SCHEMA ${resolved} CASCADE`);
			await pool.query(`DROP SCHEMA ${other} CASCADE`);
		}
	});

	it("creates the index for a table name at the maximum length", async () => {
		const table = `labeler_test.${"x".repeat(55)}`;
		tables.push(table);
		const store = new PostgresLabelStore({ pool, table });
		await store.init();
		await store.init(); // Idempotent

		const result = await pool.query(
			"SELECT indexname FROM pg_indexes WHERE schemaname = 'labeler_test' AND tablename = $1",
			["x".repeat(55)],
		);
		expect(result.rows.map((row) => row.indexname)).toContain(`${"x".repeat(55)}_uri_idx`);
	});

	it("sets up different tables in one new schema concurrently", async () => {
		const schema = `labeler_race_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
		try {
			const stores = Array.from(
				{ length: 10 },
				(_, i) => new PostgresLabelStore({ pool, table: `${schema}.labels_${i}` }),
			);
			await Promise.all(stores.map((store) => store.init()));
		} finally {
			await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		}
	});

	it("rejects stored labels that have no signature", async () => {
		const table = newTable();
		const store = new PostgresLabelStore({ pool, table });
		await store.init();
		await pool.query(
			`INSERT INTO ${table} (src, uri, val, cts) VALUES ($1, 'did:plc:x', 'v', '2026-01-01T00:00:00Z')`,
			[did],
		);
		await expect(store.query({ uriPatterns: [], sources: [], cursor: 0, limit: 10 })).rejects
			.toThrow(/has no signature/);
	});

	it("does not end a pool it was given", async () => {
		const server = new LabelerServer({
			did,
			signingKey,
			postgres: { pool, table: newTable() },
		});
		await server.ready();
		await new Promise<void>((resolve) => {
			server.close(resolve);
		});

		const result = await pool.query("SELECT 1 AS ok");
		expect(result.rows[0].ok).toBe(1);
	});
});
