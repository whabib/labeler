import type { SignedLabel } from "../util/types.js";

/** A signed label as stored in the database, with its sequence number. */
export type StoredLabel = SignedLabel & { id: number };

/** Filters for {@link LabelStore#query}. */
export interface LabelQuery {
	/**
	 * SQL `LIKE` patterns to match label URIs against, using `\` as the escape character.
	 * An empty array matches every URI.
	 */
	uriPatterns: Array<string>;
	/** Label sources (DIDs) to match. An empty array matches every source. */
	sources: Array<string>;
	/** Only return labels with an id greater than this. */
	cursor: number;
	/** The maximum number of labels to return. */
	limit: number;
}

/**
 * Persistent storage for labels.
 * Label ids are the sequence numbers used by subscribeLabels, so they must be
 * assigned in increasing order and never reused.
 */
export interface LabelStore {
	/** Create the schema if needed. Called once before any other method. */
	init(): Promise<void>;
	/**
	 * Insert a signed label and return its id.
	 * Inserts must become visible to readers in id order.
	 */
	insert(label: SignedLabel): Promise<number>;
	/** Return labels matching the query, ordered by id ascending. */
	query(query: LabelQuery): Promise<Array<StoredLabel>>;
	/** Return the largest label id, or 0 if there are no labels. */
	maxId(): Promise<number>;
	/** Throw if the database is unreachable. */
	ping(): Promise<void>;
	/** Release any connections the store owns. */
	close(): Promise<void>;
}
