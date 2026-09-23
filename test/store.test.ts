import { secp256k1 as k256 } from "@noble/curves/secp256k1";
import pg from "pg";
import * as ui8 from "uint8arrays";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LabelerServer } from "../src/LabelerServer.js";
import { PostgresLabelStore } from "../src/store/PostgresLabelStore.js";

const did = "did:plc:ragtjsm2j2vknq6zbnujgah7";
const signingKey = ui8.toString(k256.utils.randomPrivateKey(), "hex");

describe("Postgres store options", () => {
	it.each(["labels; DROP TABLE users", "Labels", "a.b.c", "\"quoted\"", "1labels", ""])(
		"rejects the table name %j",
		(table) => {
			expect(() => new PostgresLabelStore({ connectionString: "postgres://x", table }))
				.toThrow(/Invalid Postgres table name/);
		},
	);

	it("accepts plain and schema-qualified table names", () => {
		for (const table of ["labels", "labeler.labels_development", "_x.y_1"]) {
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
