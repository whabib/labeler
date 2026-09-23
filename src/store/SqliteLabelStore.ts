import type { Datetime, Did } from "@atcute/lexicons";
import { type Client, createClient, type Row } from "@libsql/client";
import type { SignedLabel } from "../util/types.js";
import type { LabelQuery, LabelStore, StoredLabel } from "./LabelStore.js";

/** Options for {@link SqliteLabelStore}. */
export interface SqliteLabelStoreOptions {
	/**
	 * The path to the SQLite `.db` database file.
	 * @default labels.db
	 */
	dbPath?: string | undefined;
	/** The URL of a remote SQLite (libSQL) database. If provided, {@link dbPath} is ignored. */
	dbUrl?: string | undefined;
	/** The authentication token for the remote database. Required if {@link dbUrl} is provided. */
	dbToken?: string | undefined;
}

/** Stores labels in a local SQLite file or a remote libSQL database. */
export class SqliteLabelStore implements LabelStore {
	/** The libSQL client. */
	readonly db: Client;

	constructor(options: SqliteLabelStoreOptions = {}) {
		if (options.dbUrl) {
			if (!options.dbToken) {
				throw new Error(
					"The `dbToken` option is required when using a remote database URL.",
				);
			}
			this.db = createClient({ url: options.dbUrl, authToken: options.dbToken });
		} else {
			this.db = createClient({ url: "file:" + (options.dbPath ?? "labels.db") });
		}
	}

	async init() {
		await this.db.execute("PRAGMA journal_mode = WAL").catch(() => {
			console.warn(
				"Unable to set WAL mode — performance and concurrent access may be impacted.",
			);
		});

		await this.db.execute(`
			CREATE TABLE IF NOT EXISTS labels (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				src TEXT NOT NULL,
				uri TEXT NOT NULL,
				cid TEXT,
				val TEXT NOT NULL,
				neg BOOLEAN DEFAULT FALSE,
				cts DATETIME NOT NULL,
				exp DATETIME,
				sig BLOB
			);
		`);
	}

	async insert(label: SignedLabel) {
		const { src, uri, cid, val, neg, cts, exp, sig } = label;
		const result = await this.db.execute({
			sql: `
				INSERT INTO labels (src, uri, cid, val, neg, cts, exp, sig)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				RETURNING id
			`,
			args: [src, uri, cid || null, val, neg ? 1 : 0, cts, exp || null, sig],
		});
		if (!result.rows.length) throw new Error("Failed to insert label");
		return Number(result.rows[0].id);
	}

	async query({ uriPatterns, sources, cursor, limit }: LabelQuery) {
		const conditions: string[] = [];
		const args: Array<string | number> = [];

		if (uriPatterns.length) {
			conditions.push(
				"(" + uriPatterns.map(() => "uri LIKE ? ESCAPE '\\'").join(" OR ") + ")",
			);
			args.push(...uriPatterns);
		}
		if (sources.length) {
			conditions.push(`src IN (${sources.map(() => "?").join(", ")})`);
			args.push(...sources);
		}
		if (cursor) {
			conditions.push("id > ?");
			args.push(cursor);
		}
		args.push(limit);

		const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const result = await this.db.execute({
			sql: `SELECT * FROM labels ${whereClause} ORDER BY id ASC LIMIT ?`,
			args,
		});
		return result.rows.map(rowToLabel);
	}

	async maxId() {
		const result = await this.db.execute("SELECT MAX(id) AS id FROM labels");
		return Number(result.rows[0]?.id ?? 0);
	}

	async ping() {
		await this.db.execute("SELECT 1");
	}

	close() {
		this.db.close();
		return Promise.resolve();
	}
}

function rowToLabel(row: Row): StoredLabel {
	return {
		id: Number(row.id),
		src: row.src as Did,
		uri: row.uri as string,
		val: row.val as string,
		neg: Boolean(row.neg),
		cts: row.cts as Datetime,
		...(row.cid ? { cid: row.cid as string } : {}),
		...(row.exp ? { exp: row.exp as Datetime } : {}),
		sig: new Uint8Array(row.sig as ArrayBuffer),
	};
}
