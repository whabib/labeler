import type { ComAtprotoLabelQueryLabels } from "@atcute/atproto";
import { Did, isDid } from "@atcute/lexicons/syntax";
import type { ToolsOzoneModerationEmitEvent } from "@atcute/ozone";
import { XRPCError } from "@atcute/xrpc-server";

import { fastifyWebsocket } from "@fastify/websocket";
import fastify, {
	type FastifyInstance,
	type FastifyListenOptions,
	type FastifyRequest,
} from "fastify";
import { WebSocket } from "ws";
import type { LabelStore } from "./store/LabelStore.js";
import { PostgresLabelStore, type PostgresLabelStoreOptions } from "./store/PostgresLabelStore.js";
import { SqliteLabelStore } from "./store/SqliteLabelStore.js";
import { parsePrivateKey, verifyJwt } from "./util/crypto.js";
import { formatLabel, toSignedLabel } from "./util/labels.js";
import type {
	CreateLabelData,
	LabelSubject,
	ProcedureHandler,
	QueryHandler,
	SavedLabel,
	SignedLabel,
	SubscriptionHandler,
	UnsignedLabel,
} from "./util/types.js";
import { excludeNullish, frameToBytes } from "./util/util.js";

const INVALID_DID_ERROR =
	`Make sure to provide a valid DID using either did:plc or did:web methods.`;
const INVALID_SIGNING_KEY_ERROR = `Make sure to provide a private signing key, not a public key.

If you don't have a key, generate and set one using the \`npx github:whabib/labeler setup\` command or the \`import { plcSetupLabeler } from "labeler/scripts"\` function.
For more information, see https://github.com/whabib/labeler#readme`;

/**
 * Options for the {@link LabelerServer} class.
 */
export interface LabelerOptions {
	/** The DID of the labeler account. */
	did: string;

	/**
	 * The private signing key used for the labeler.
	 * If you don't have a key, generate and set one using {@link plcSetupLabeler}.
	 */
	signingKey: string;

	/**
	 * A function that returns whether a DID is authorized to create labels.
	 * By default, only the labeler account is authorized.
	 * @param did The DID to check.
	 */
	auth?: (did: string) => boolean | Promise<boolean>;

	/**
	 * The path to the SQLite `.db` database file.
	 * @default labels.db
	 */
	dbPath?: string;

	/**
	 * The URL of the remote SQLite database.
	 * If provided, {@link dbPath} is ignored.
	 */
	dbUrl?: string;

	/**
	 * The authentication token for the remote SQLite database.
	 * Required if {@link dbUrl} is provided.
	 */
	dbToken?: string;

	/**
	 * Store labels in PostgreSQL instead of SQLite.
	 * Cannot be combined with {@link dbPath} or {@link dbUrl}.
	 */
	postgres?: PostgresLabelStoreOptions;
}

const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MB backpressure limit per subscriber
const REPLAY_PAGE_SIZE = 500; // Labels fetched per query during subscribeLabels replay
const REPLAY_DRAIN_TIMEOUT_MS = 30_000; // Give up on a subscriber that stops reading during replay

/** Tracks per-subscriber state including a catch-up buffer for historical replay. */
interface SubscriberState {
	ws: WebSocket;
	catchingUp: boolean;
	buffer: Array<{ seq: number; bytes: Uint8Array }>;
	bufferedBytes: number;
}

export class LabelerServer {
	/** The Fastify application instance. */
	app: FastifyInstance;

	/** The label storage backend. */
	readonly store: LabelStore;

	/** The DID of the labeler account. */
	did: Did;

	/** A function that returns whether a DID is authorized to create labels. */
	private auth: (did: string) => boolean | Promise<boolean>;

	/** Open WebSocket connections, mapped by request NSID. */
	private connections = new Map<string, Set<SubscriberState>>();

	/** The signing key used for the labeler. */
	#signingKey: Uint8Array;

	/**
	 * Promise that resolves when database initialization is complete.
	 * This should be awaited before any database operations.
	 */
	private readonly dbInitLock?: Promise<void>;

	/** Chains label inserts so labels are stored and emitted in id order. */
	private insertQueue: Promise<unknown> = Promise.resolve();

	/**
	 * Create a labeler server.
	 * @param options Configuration options.
	 */
	constructor(options: LabelerOptions) {
		this.did = options.did as Did;
		this.auth = options.auth ?? ((did) => did === this.did);

		if (!isDid(this.did)) {
			throw new Error(INVALID_DID_ERROR);
		}

		try {
			if (options.signingKey.startsWith("did:key:")) throw 0;
			this.#signingKey = parsePrivateKey(options.signingKey);
			if (this.#signingKey.byteLength !== 32) throw 0;
		} catch {
			throw new Error(INVALID_SIGNING_KEY_ERROR);
		}

		if (options.postgres) {
			if (options.dbPath || options.dbUrl) {
				throw new Error(
					"The `postgres` option cannot be combined with `dbPath` or `dbUrl`.",
				);
			}
			this.store = new PostgresLabelStore(options.postgres);
		} else {
			this.store = new SqliteLabelStore(options);
		}

		this.dbInitLock = this.initializeDatabase();

		this.app = fastify();
		void this.app.register(async (app) => {
			await app.register(fastifyWebsocket);
			app.get("/xrpc/com.atproto.label.queryLabels", this.queryLabelsHandler);
			app.post("/xrpc/tools.ozone.moderation.emitEvent", this.emitEventHandler);
			app.get(
				"/xrpc/com.atproto.label.subscribeLabels",
				{ websocket: true },
				this.subscribeLabelsHandler,
			);
			app.get("/xrpc/_health", this.healthHandler);
			app.get("/xrpc/*", this.unknownMethodHandler);
			app.setErrorHandler(this.errorHandler);
		});
	}

	/**
	 * Initializes the database with the required schema.
	 * @returns A promise that resolves when initialization is complete
	 */
	private async initializeDatabase() {
		await this.store.init().catch((error: unknown) => {
			console.error("Failed to initialize database:", error);
			throw error;
		});
	}

	/**
	 * Wait for the database schema to be created.
	 * Label methods already wait for this; use it before querying the store directly.
	 */
	async ready(): Promise<void> {
		await this.dbInitLock;
	}

	/**
	 * Start the server.
	 * @param port The port to listen on.
	 * @param callback A callback to run when the server is started.
	 */
	start(port: number, callback: (error: Error | null, address: string) => void): void;
	/**
	 * Start the server.
	 * @param options Options for the server.
	 * @param callback A callback to run when the server is started.
	 */
	start(
		options: FastifyListenOptions,
		callback: (error: Error | null, address: string) => void,
	): void;
	start(
		portOrOptions: number | FastifyListenOptions,
		callback: (error: Error | null, address: string) => void = () => {},
	) {
		if (typeof portOrOptions === "number") {
			this.app.listen({ port: portOrOptions }, callback);
		} else {
			this.app.listen(portOrOptions, callback);
		}
	}

	/**
	 * Stop the server.
	 * @param callback A callback to run when the server is stopped.
	 */
	close(callback: () => void = () => {}) {
		this.app.close(() => {
			this.store.close().catch((error: unknown) => {
				console.error("Failed to close database:", error);
			}).finally(callback);
		});
	}

	/**
	 * Alias for {@link LabelerServer#close}.
	 * @param callback A callback to run when the server is stopped.
	 */
	stop(callback: () => void = () => {}) {
		this.close(callback);
	}

	/**
	 * Insert a label into the database, emitting it to subscribers.
	 * @param label The label to insert.
	 * @returns The inserted label.
	 */
	private async saveLabel(label: UnsignedLabel): Promise<SavedLabel> {
		await this.dbInitLock;

		const signed = toSignedLabel(label, this.#signingKey);

		// Insert and emit one label at a time, so subscribers receive labels in id order
		const saved = this.insertQueue.then(async () => {
			const id = await this.store.insert(signed);
			this.emitLabel(id, signed);
			return id;
		});
		this.insertQueue = saved.catch(() => {});

		const id = await saved;
		return { id, ...formatLabel(signed) };
	}

	/**
	 * Create and insert a label into the database, emitting it to subscribers.
	 * @param label The label to create.
	 * @returns The created label.
	 */
	async createLabel(label: CreateLabelData): Promise<SavedLabel> {
		return await this.saveLabel(
			excludeNullish({
				...label,
				src: (label.src ?? this.did),
				cts: label.cts ?? new Date().toISOString(),
			}),
		);
	}

	/**
	 * Create and insert labels into the database, emitting them to subscribers.
	 * @param subject The subject of the labels.
	 * @param labels The labels to create.
	 * @returns The created labels.
	 */
	async createLabels(
		subject: LabelSubject,
		labels: { create?: Array<string>; negate?: Array<string> },
	): Promise<Array<SavedLabel>> {
		await this.dbInitLock;

		const { create, negate } = labels;

		const createdLabels: Array<SavedLabel> = [];
		if (create) {
			for (const val of create) {
				const created = await this.createLabel({ ...subject, val });
				createdLabels.push(created);
			}
		}
		if (negate) {
			for (const val of negate) {
				const negated = await this.createLabel({ ...subject, val, neg: true });
				createdLabels.push(negated);
			}
		}
		return createdLabels;
	}

	/**
	 * Emit a label to all subscribers connected to this server.
	 * Servers sharing a Postgres table don't see each other's labels live; a subscriber
	 * receives labels created elsewhere when it reconnects and replays from its cursor.
	 * @param seq The label's id.
	 * @param label The label to emit.
	 */
	private emitLabel(seq: number, label: SignedLabel) {
		const bytes = frameToBytes("message", { seq, labels: [formatLabel(label)] }, "#labels");
		const subs = this.connections.get("com.atproto.label.subscribeLabels");
		if (!subs) return;

		for (const sub of subs) {
			// Prune closed or closing connections
			if (sub.ws.readyState === WebSocket.CLOSING || sub.ws.readyState === WebSocket.CLOSED) {
				subs.delete(sub);
				continue;
			}

			// If the subscriber is still catching up on historical data, buffer the event
			if (sub.catchingUp) {
				const nextBufferedBytes = sub.bufferedBytes + bytes.byteLength;
				if (nextBufferedBytes > MAX_BUFFERED_AMOUNT) {
					try {
						sub.ws.terminate();
					} catch { /* already dying */ }
					subs.delete(sub);
					continue;
				}
				sub.buffer.push({ seq, bytes });
				sub.bufferedBytes = nextBufferedBytes;
				continue;
			}

			// Enforce backpressure: if the socket's send buffer is too large, terminate it
			if (sub.ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
				try {
					sub.ws.terminate();
				} catch { /* already dying */ }
				subs.delete(sub);
				continue;
			}

			try {
				sub.ws.send(bytes);
			} catch {
				// Send failed — clean up this subscriber without affecting others
				subs.delete(sub);
			}
		}

		if (!subs.size) this.connections.delete("com.atproto.label.subscribeLabels");
	}

	/**
	 * Parse a user DID from an Authorization header JWT.
	 * @param req The Express request object.
	 */
	private async parseAuthHeaderDid(req: FastifyRequest): Promise<string> {
		const authHeader = req.headers.authorization;
		if (!authHeader) {
			throw new XRPCError({
				status: 401,
				error: "AuthRequired",
				description: "Authorization header is required",
			});
		}

		const [type, token] = authHeader.split(" ");
		if (type !== "Bearer" || !token) {
			throw new XRPCError({
				status: 400,
				error: "MissingJwt",
				description: "Missing or invalid bearer token",
			});
		}

		const nsid = (req.originalUrl || req.url || "").split("?")[0].replace("/xrpc/", "").replace(
			/\/$/,
			"",
		);

		const payload = await verifyJwt(token, this.did, nsid);

		return payload.iss;
	}

	/**
	 * Handler for [com.atproto.label.queryLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/queryLabels.json).
	 */
	queryLabelsHandler: QueryHandler<ComAtprotoLabelQueryLabels.$params> = async (req, res) => {
		await this.dbInitLock;

		let uriPatterns: Array<string>;
		if (!req.query.uriPatterns) {
			uriPatterns = [];
		} else if (typeof req.query.uriPatterns === "string") {
			uriPatterns = [req.query.uriPatterns];
		} else {
			uriPatterns = req.query.uriPatterns || [];
		}

		let sources: Array<string>;
		if (!req.query.sources) {
			sources = [];
		} else if (typeof req.query.sources === "string") {
			sources = [req.query.sources];
		} else {
			sources = req.query.sources || [];
		}

		const cursor = parseInt(`${req.query.cursor || 0}`, 10);
		if (cursor !== undefined && Number.isNaN(cursor)) {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Cursor must be an integer",
			});
		}

		const limit = parseInt(`${req.query.limit || 50}`, 10);
		if (Number.isNaN(limit) || limit < 1 || limit > 250) {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Limit must be an integer between 1 and 250",
			});
		}

		const patterns = uriPatterns.includes("*") ? [] : uriPatterns.map((pattern) => {
			pattern = pattern.replaceAll(/%/g, "").replaceAll(/_/g, "\\_");

			const starIndex = pattern.indexOf("*");
			if (starIndex === -1) return pattern;

			if (starIndex !== pattern.length - 1) {
				throw new XRPCError({
					status: 400,
					error: "InvalidRequest",
					description: "Only trailing wildcards are supported in uriPatterns",
				});
			}
			return pattern.slice(0, -1) + "%";
		});

		const rows = await this.store.query({ uriPatterns: patterns, sources, cursor, limit });
		const labels = rows.map(formatLabel);

		const nextCursor = rows[rows.length - 1]?.id?.toString(10) || "0";

		await res.send({ cursor: nextCursor, labels } satisfies ComAtprotoLabelQueryLabels.$output);
	};

	/**
	 * Handler for [com.atproto.label.subscribeLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/subscribeLabels.json).
	 */
	subscribeLabelsHandler: SubscriptionHandler<{ cursor?: string }> = async (ws, req) => {
		await this.dbInitLock;

		const cursor = parseInt(req.query.cursor ?? "NaN", 10);
		const hasCursor = !Number.isNaN(cursor);

		// Register the subscriber immediately so emitLabel can buffer events during catch-up
		const sub = this.addSubscription("com.atproto.label.subscribeLabels", ws, hasCursor);

		ws.on("close", () => {
			this.removeSubscription("com.atproto.label.subscribeLabels", sub);
		});

		if (hasCursor) {
			if (cursor > await this.store.maxId()) {
				const errorBytes = frameToBytes("error", {
					error: "FutureCursor",
					message: "Cursor is in the future",
				});
				try {
					ws.send(errorBytes);
				} catch { /* connection may already be dead */ }
				this.removeSubscription("com.atproto.label.subscribeLabels", sub);
				ws.terminate();
				return;
			}

			let maxHistoricalSeq = 0;
			try {
				// Replay history a page at a time, waiting for the socket to drain between
				// pages, so a subscriber starting far back doesn't pull it all into memory
				let pageCursor = cursor;
				while (true) {
					const page = await this.store.query({
						uriPatterns: [],
						sources: [],
						cursor: pageCursor,
						limit: REPLAY_PAGE_SIZE,
					});

					for (const { id: seq, ...label } of page) {
						if (ws.readyState !== WebSocket.OPEN) {
							this.removeSubscription("com.atproto.label.subscribeLabels", sub);
							return;
						}
						maxHistoricalSeq = Math.max(maxHistoricalSeq, seq);
						const bytes = frameToBytes(
							"message",
							{ seq, labels: [formatLabel(label)] },
							"#labels",
						);
						ws.send(bytes);
					}

					if (page.length < REPLAY_PAGE_SIZE) break;
					pageCursor = page[page.length - 1].id;

					if (!await waitForDrain(ws)) {
						this.removeSubscription("com.atproto.label.subscribeLabels", sub);
						ws.terminate();
						return;
					}
				}
			} catch (e) {
				console.error(e);
				const errorBytes = frameToBytes("error", {
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
				try {
					ws.send(errorBytes);
				} catch { /* connection may already be dead */ }
				this.removeSubscription("com.atproto.label.subscribeLabels", sub);
				ws.terminate();
				return;
			}

			// Flush buffered events that arrived during historical replay,
			// but only those with seq > maxHistoricalSeq to avoid duplicates
			for (const buffered of sub.buffer) {
				if (buffered.seq > maxHistoricalSeq) {
					if (ws.readyState !== WebSocket.OPEN) {
						this.removeSubscription("com.atproto.label.subscribeLabels", sub);
						return;
					}
					if (ws.bufferedAmount + buffered.bytes.byteLength > MAX_BUFFERED_AMOUNT) {
						this.removeSubscription("com.atproto.label.subscribeLabels", sub);
						ws.terminate();
						return;
					}
					try {
						ws.send(buffered.bytes);
					} catch {
						this.removeSubscription("com.atproto.label.subscribeLabels", sub);
						return;
					}
				}
			}

			// Transition from catch-up to live mode
			sub.catchingUp = false;
			sub.buffer = [];
			sub.bufferedBytes = 0;
		}
	};

	/**
	 * Handler for [tools.ozone.moderation.emitEvent](https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/emitEvent.json).
	 */
	emitEventHandler: ProcedureHandler<ToolsOzoneModerationEmitEvent.$output> = async (
		req,
		res,
	) => {
		const actorDid = await this.parseAuthHeaderDid(req);
		const authed = await this.auth(actorDid);
		if (!authed) {
			throw new XRPCError({
				status: 401,
				error: "AuthRequired",
				description: "Unauthorized",
			});
		}

		// The request body is untrusted: clients may omit subjectBlobCids despite its type
		// eslint-disable-next-line @typescript-eslint/no-useless-default-assignment
		const { event, subject, subjectBlobCids = [], createdBy } = req.body;
		if (!event || !subject || !createdBy) {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Missing required field(s)",
			});
		}

		if (event.$type !== "tools.ozone.moderation.defs#modEventLabel") {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Unsupported event type",
			});
		}

		if (!event.createLabelVals?.length && !event.negateLabelVals?.length) {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Must provide at least one label value",
			});
		}

		const uri = subject.$type === "com.atproto.admin.defs#repoRef"
			? subject.did
			: subject.$type === "com.atproto.repo.strongRef"
			? subject.uri
			: null;
		const cid = subject.$type === "com.atproto.repo.strongRef" ? subject.cid : undefined;

		if (!uri) {
			throw new XRPCError({
				status: 400,
				error: "InvalidRequest",
				description: "Invalid subject",
			});
		}

		const labelSubject: LabelSubject = { uri };
		if (cid) {
			labelSubject.cid = cid;
		}

		const labels = await this.createLabels(labelSubject, {
			create: event.createLabelVals,
			negate: event.negateLabelVals,
		});

		if (!labels.length || !labels[0]?.id) {
			throw new Error(`No labels were created\nEvent:\n${JSON.stringify(event, null, 2)}`);
		}

		await res.send(
			{
				id: labels[0].id,
				event,
				subject,
				subjectBlobCids,
				createdBy,
				createdAt: new Date().toISOString(),
			} satisfies ToolsOzoneModerationEmitEvent.$output,
		);
	};

	/**
	 * Handler for the health check endpoint.
	 */
	healthHandler: QueryHandler = async (_req, res) => {
		const VERSION = "1.0.1";
		try {
			await this.store.ping();
		} catch {
			return res.status(503).send({ version: VERSION, error: "Service Unavailable" });
		}
		return res.send({ version: VERSION });
	};

	/**
	 * Catch-all handler for unknown XRPC methods.
	 */
	unknownMethodHandler: QueryHandler = async (_req, res) =>
		res.status(501).send({ error: "MethodNotImplemented", message: "Method Not Implemented" });

	/**
	 * Default error handler.
	 */
	errorHandler: typeof this.app.errorHandler = async (err, _req, res) => {
		if (err instanceof XRPCError) {
			return res.status(err.status).send({ error: err.error, message: err.description });
		} else {
			console.error(err);
			return res.status(500).send({
				error: "InternalServerError",
				message: "An unknown error occurred",
			});
		}
	};

	/**
	 * Add a WebSocket connection to the list of subscribers for a given lexicon.
	 * @param nsid The NSID of the lexicon to subscribe to.
	 * @param ws The WebSocket connection to add.
	 */
	private addSubscription(
		nsid: string,
		ws: WebSocket,
		catchingUp: boolean = false,
	): SubscriberState {
		const sub: SubscriberState = { ws, catchingUp, buffer: [], bufferedBytes: 0 };
		const subs = this.connections.get(nsid) ?? new Set();
		subs.add(sub);
		this.connections.set(nsid, subs);
		return sub;
	}

	/**
	 * Remove a subscriber from the list of subscribers for a given lexicon.
	 * @param nsid The NSID of the lexicon to unsubscribe from.
	 * @param sub The subscriber state to remove.
	 */
	private removeSubscription(nsid: string, sub: SubscriberState) {
		const subs = this.connections.get(nsid);
		if (subs) {
			subs.delete(sub);
			if (!subs.size) this.connections.delete(nsid);
		}
	}
}

/**
 * Wait until a socket's send buffer drops below {@link MAX_BUFFERED_AMOUNT}.
 * @returns false if the socket closed or didn't drain within {@link REPLAY_DRAIN_TIMEOUT_MS}.
 */
async function waitForDrain(ws: WebSocket): Promise<boolean> {
	const deadline = Date.now() + REPLAY_DRAIN_TIMEOUT_MS;
	while (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
		if (ws.readyState !== WebSocket.OPEN || Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ws.readyState === WebSocket.OPEN;
}
