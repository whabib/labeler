import { decodeFirst } from "@atcute/cbor";
import { secp256k1 as k256 } from "@noble/curves/secp256k1";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ui8 from "uint8arrays";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LabelerServer } from "../src/LabelerServer.js";

describe("LabelerServer integration", () => {
	let server: LabelerServer;
	let dbDir: string;
	let wsBaseUrl: string;

	const labelerDid = "did:plc:ragtjsm2j2vknq6zbnujgah7";
	const privateKeyBytes = k256.utils.randomPrivateKey();
	const privateKeyHex = ui8.toString(privateKeyBytes, "hex");

	beforeAll(async () => {
		dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "labeler-test-"));
		const dbPath = path.join(dbDir, "labels.db");

		server = new LabelerServer({ did: labelerDid, signingKey: privateKeyHex, dbPath });

		// Start server on an ephemeral free port
		await new Promise<void>((resolve, reject) => {
			server.start({ port: 0, host: "127.0.0.1" }, (err, address) => {
				if (err) {
					reject(err);
					return;
				}
				wsBaseUrl = address.replace(/^http/, "ws");
				resolve();
			});
		});
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		await fs.rm(dbDir, { recursive: true, force: true });
	});

	describe("Health Check", () => {
		it("returns 200 and version on GET /xrpc/_health", async () => {
			const res = await server.app.inject({ method: "GET", url: "/xrpc/_health" });

			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toEqual({ version: "0.2.0" });
		});
	});

	describe("Label Creation & Persistence", () => {
		it("creates and signs a label", async () => {
			const label = await server.createLabel({
				uri: "did:plc:testtarget123",
				val: "verified",
			});

			expect(label.id).toBeDefined();
			expect(typeof label.id).toBe("number");
			expect(label.src).toBe(labelerDid);
			expect(label.uri).toBe("did:plc:testtarget123");
			expect(label.val).toBe("verified");
			expect(label.ver).toBe(1);
			expect(label.neg).toBe(false);
			expect(label.sig).toBeDefined();
		});

		it("creates batch labels with createLabels", async () => {
			const labels = await server.createLabels({
				uri: "at://did:plc:testtarget123/app.bsky.feed.post/12345",
			}, { create: ["pinned", "featured"], negate: ["hidden"] });

			expect(labels).toHaveLength(3);
			expect(labels[0].val).toBe("pinned");
			expect(labels[0].neg).toBe(false);
			expect(labels[1].val).toBe("featured");
			expect(labels[1].neg).toBe(false);
			expect(labels[2].val).toBe("hidden");
			expect(labels[2].neg).toBe(true);
		});
	});

	describe("com.atproto.label.queryLabels", () => {
		it("queries labels with pagination", async () => {
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?limit=2",
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(Array.isArray(body.labels)).toBe(true);
			expect(body.labels.length).toBe(2);
			expect(typeof body.cursor).toBe("string");
		});

		it("filters by uriPatterns exact match", async () => {
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?uriPatterns=did:plc:testtarget123",
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.labels.length).toBeGreaterThanOrEqual(1);
			expect(body.labels.every((l: { uri: string }) => l.uri === "did:plc:testtarget123"))
				.toBe(true);
		});

		it("filters by uriPatterns prefix wildcard", async () => {
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?uriPatterns=at://did:plc:testtarget123/*",
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.labels.length).toBe(3);
			expect(
				body.labels.every((l: { uri: string }) =>
					l.uri.startsWith("at://did:plc:testtarget123/")
				),
			).toBe(true);
		});

		it("rejects wildcard in middle of uriPattern", async () => {
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?uriPatterns=did:*:test",
			});

			expect(res.statusCode).toBe(400);
			const body = JSON.parse(res.body);
			expect(body.error).toBe("InvalidRequest");
		});

		it("validates limit boundaries", async () => {
			const resUnder = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?limit=0",
			});
			expect(resUnder.statusCode).toBe(400);

			const resOver = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?limit=251",
			});
			expect(resOver.statusCode).toBe(400);
		});
	});

	describe("com.atproto.label.subscribeLabels (WebSocket)", () => {
		it("receives real-time labels when a label is created", async () => {
			const ws = new WebSocket(`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels`);

			await new Promise<void>((resolve, reject) => {
				ws.on("open", () => {
					resolve();
				});
				ws.on("error", reject);
			});

			const framePromise = new Promise<Uint8Array>((resolve, reject) => {
				ws.once("message", (data: Buffer) => {
					resolve(new Uint8Array(data));
				});
				ws.once("error", reject);
			});

			// Create a label while the client is subscribed
			const created = await server.createLabel({
				uri: "did:plc:realtimetest",
				val: "live-event",
			});

			const lastFrame = await framePromise;
			ws.close();
			const [header, remainder] = decodeFirst(lastFrame);
			expect(header).toEqual({ op: 1, t: "#labels" });

			const [body] = decodeFirst(remainder);
			expect((body as { seq: number }).seq).toBe(created.id);
			expect((body as { labels: Array<{ val: string }> }).labels[0].val).toBe("live-event");
		});

		it("replays historical labels when cursor is provided", async () => {
			const ws = new WebSocket(
				`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels?cursor=0`,
			);

			const receivedFrames: Array<Uint8Array> = [];
			await new Promise<void>((resolve, reject) => {
				ws.on("message", (data: Buffer) => {
					receivedFrames.push(new Uint8Array(data));
				});
				ws.on("error", reject);
				setTimeout(resolve, 500);
			});

			ws.close();
			expect(receivedFrames.length).toBeGreaterThanOrEqual(1);

			const [header] = decodeFirst(receivedFrames[0]);
			expect(header).toEqual({ op: 1, t: "#labels" });
		});

		it("sends error frame and terminates when cursor is in the future", async () => {
			const ws = new WebSocket(
				`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels?cursor=9999999`,
			);

			const receivedFrames: Array<Uint8Array> = [];
			let closed = false;

			await new Promise<void>((resolve) => {
				ws.on("message", (data: Buffer) => {
					receivedFrames.push(new Uint8Array(data));
				});
				ws.on("close", () => {
					closed = true;
					resolve();
				});
				setTimeout(resolve, 1000);
			});

			expect(receivedFrames.length).toBe(1);
			expect(closed).toBe(true);

			const [header, remainder] = decodeFirst(receivedFrames[0]);
			expect(header).toEqual({ op: -1 });

			const [body] = decodeFirst(remainder);
			expect(body).toEqual({ error: "FutureCursor", message: "Cursor is in the future" });
		});
	});

	describe("tools.ozone.moderation.emitEvent", () => {
		it("rejects request without Authorization header", async () => {
			const res = await server.app.inject({
				method: "POST",
				url: "/xrpc/tools.ozone.moderation.emitEvent",
				payload: {},
			});

			expect(res.statusCode).toBe(401);
			expect(JSON.parse(res.body).error).toBe("AuthRequired");
		});

		it("rejects non-Bearer authorization header", async () => {
			const res = await server.app.inject({
				method: "POST",
				url: "/xrpc/tools.ozone.moderation.emitEvent",
				headers: { authorization: "Basic 12345" },
				payload: {},
			});

			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toBe("MissingJwt");
		});
	});

	describe("Method Not Implemented", () => {
		it("returns 501 for unknown XRPC routes", async () => {
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.example.nonexistent",
			});

			expect(res.statusCode).toBe(501);
			expect(JSON.parse(res.body)).toEqual({
				error: "MethodNotImplemented",
				message: "Method Not Implemented",
			});
		});
	});

	describe("LIKE ESCAPE clause", () => {
		it("correctly matches URIs containing literal underscores", async () => {
			// Create a label with a literal underscore in the URI
			await server.createLabel({
				uri: "at://did:plc:underscore_test/app.bsky.feed.post/abc",
				val: "underscore-label",
			});

			// Query with exact match containing underscore — should match only the underscore URI
			const res = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?uriPatterns=at://did:plc:underscore_test/*",
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.labels.length).toBeGreaterThanOrEqual(1);
			// Verify all returned labels have the literal underscore in the URI
			expect(
				body.labels.every((l: { uri: string }) =>
					l.uri.startsWith("at://did:plc:underscore_test/")
				),
			).toBe(true);

			// An underscore in SQL LIKE without ESCAPE matches any single character.
			// Verify that "underscore.test" (dot instead of underscore) does NOT match.
			const resDot = await server.app.inject({
				method: "GET",
				url: "/xrpc/com.atproto.label.queryLabels?uriPatterns=at://did:plc:underscore.test/*",
			});
			expect(resDot.statusCode).toBe(200);
			const bodyDot = JSON.parse(resDot.body);
			expect(bodyDot.labels.length).toBe(0);
		});
	});

	describe("Subscription catch-up buffering", () => {
		it("delivers both historical and live labels through the catch-up flow", async () => {
			// First, create baseline labels to establish history
			const baseline1 = await server.createLabel({
				uri: "did:plc:catchupbase1",
				val: "baseline-1",
			});
			await server.createLabel({ uri: "did:plc:catchupbase2", val: "baseline-2" });

			// Record the cursor before the baselines
			const cursorBeforeBaselines = baseline1.id - 1;

			// Collect all frames as they arrive
			const receivedFrames: Array<Uint8Array> = [];

			// Connect with cursor — the handler will stream historical rows then transition to live
			const ws = new WebSocket(
				`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels?cursor=${cursorBeforeBaselines}`,
			);

			ws.on("message", (data: Buffer) => {
				receivedFrames.push(new Uint8Array(data));
			});

			await new Promise<void>((resolve, reject) => {
				ws.on("open", resolve);
				ws.on("error", reject);
			});

			// Wait for historical replay to complete
			await new Promise<void>((resolve) => setTimeout(resolve, 200));

			// Now create a live label — subscriber should be in live mode and receive this
			const liveLabel = await server.createLabel({
				uri: "did:plc:livecatchup",
				val: "live-after-catchup",
			});

			// Wait for the live event to be delivered
			await new Promise<void>((resolve) => setTimeout(resolve, 200));

			ws.close();

			// We should have received at least the 2 baseline labels + 1 live label
			expect(receivedFrames.length).toBeGreaterThanOrEqual(3);

			// Verify all are valid message frames and extract sequence numbers
			const allSeqs: number[] = [];
			for (const frame of receivedFrames) {
				const [header, remainder] = decodeFirst(frame);
				if ((header as { op: number }).op === 1) {
					const [body] = decodeFirst(remainder);
					allSeqs.push((body as { seq: number }).seq);
				}
			}

			// Historical labels should be present
			expect(allSeqs).toContain(baseline1.id);

			// The live label should also have been delivered (not dropped)
			expect(allSeqs).toContain(liveLabel.id);

			// Sequence numbers should be monotonically increasing
			for (let i = 1; i < allSeqs.length; i++) {
				expect(allSeqs[i]).toBeGreaterThan(allSeqs[i - 1]);
			}
		});
	});

	describe("emitLabel with closed sockets", () => {
		it("handles closed sockets without errors or affecting other subscribers", async () => {
			// Connect two WebSocket subscribers
			const ws1 = new WebSocket(`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels`);
			const ws2 = new WebSocket(`${wsBaseUrl}/xrpc/com.atproto.label.subscribeLabels`);

			await Promise.all([
				new Promise<void>((resolve, reject) => {
					ws1.on("open", resolve);
					ws1.on("error", reject);
				}),
				new Promise<void>((resolve, reject) => {
					ws2.on("open", resolve);
					ws2.on("error", reject);
				}),
			]);

			// Close one subscriber immediately
			ws1.close();
			await new Promise<void>((resolve) => {
				ws1.on("close", resolve);
			});

			// Set up listener on the surviving subscriber
			const framePromise = new Promise<Uint8Array>((resolve, reject) => {
				ws2.once("message", (data: Buffer) => {
					resolve(new Uint8Array(data));
				});
				ws2.once("error", reject);
			});

			// Create a label — emitLabel should prune the closed ws1 and still deliver to ws2
			const created = await server.createLabel({
				uri: "did:plc:closedtest",
				val: "survives-close",
			});

			const frame = await framePromise;
			ws2.close();

			const [header, remainder] = decodeFirst(frame);
			expect(header).toEqual({ op: 1, t: "#labels" });

			const [body] = decodeFirst(remainder);
			expect((body as { seq: number }).seq).toBe(created.id);
			expect((body as { labels: Array<{ val: string }> }).labels[0].val).toBe(
				"survives-close",
			);
		});
	});
});
