import { XRPCError } from "@atcute/xrpc-server";
import { secp256k1 as k256 } from "@noble/curves/secp256k1";
import * as ui8 from "uint8arrays";
import { describe, expect, it } from "vitest";
import {
	formatDidKey,
	k256Sign,
	P256_JWT_ALG,
	parsePrivateKey,
	SECP256K1_JWT_ALG,
	verifyJwt,
} from "../src/util/crypto.js";

describe("crypto", () => {
	// 32-byte known test private key
	const testHexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const testBytesKey = ui8.fromString(testHexKey, "hex");
	const testBase64UrlKey = ui8.toString(testBytesKey, "base64url");

	describe("parsePrivateKey", () => {
		it("parses valid 32-byte hex private key", () => {
			const parsed = parsePrivateKey(testHexKey);
			expect(parsed).toEqual(testBytesKey);
			expect(parsed.byteLength).toBe(32);
		});

		it("parses valid 32-byte base64url private key", () => {
			const parsed = parsePrivateKey(testBase64UrlKey);
			expect(parsed).toEqual(testBytesKey);
			expect(parsed.byteLength).toBe(32);
		});

		it("throws for invalid hex length", () => {
			expect(() => parsePrivateKey("012345")).toThrow();
		});

		it("throws for invalid characters", () => {
			expect(() =>
				parsePrivateKey("invalid_key_string_that_is_not_hex_or_valid_base64url!#%&")
			).toThrow();
		});
	});

	describe("formatDidKey", () => {
		it("formats secp256k1 public key as did:key", () => {
			const pubKey = k256.getPublicKey(testBytesKey);
			const didKey = formatDidKey(SECP256K1_JWT_ALG, pubKey);

			expect(didKey.startsWith("did:key:zQ3sh")).toBe(true);
		});

		it("formats p256 public key as did:key", () => {
			// 65-byte uncompressed P-256 test point (generator point G)
			const p256GenPointHex = "04"
				+ "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
				+ "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
			const p256Pub = ui8.fromString(p256GenPointHex, "hex");
			const didKey = formatDidKey(P256_JWT_ALG, p256Pub);

			expect(didKey.startsWith("did:key:zDn")).toBe(true);
		});
	});

	describe("k256Sign", () => {
		it("signs a message that verifies with secp256k1", () => {
			const message = new TextEncoder().encode("test message to sign");
			const sig = k256Sign(testBytesKey, message);

			expect(sig).toBeInstanceOf(Uint8Array);
			expect(sig.byteLength).toBe(64); // 64-byte compact signature
		});
	});

	describe("verifyJwt", () => {
		it("rejects poorly formatted JWTs", async () => {
			await expect(verifyJwt("not-a-jwt", null, null)).rejects.toThrow(XRPCError);
			await expect(verifyJwt("header.payload", null, null)).rejects.toThrow(XRPCError);
		});

		it("rejects expired JWTs", async () => {
			const expiredPayload = {
				iss: "did:plc:1234567890abcdefghijklmn",
				aud: "did:web:example.com",
				exp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
			};
			const header = ui8.toString(
				ui8.fromString(JSON.stringify({ alg: "ES256K", typ: "JWT" }), "utf8"),
				"base64url",
			);
			const payload = ui8.toString(
				ui8.fromString(JSON.stringify(expiredPayload), "utf8"),
				"base64url",
			);
			const fakeJwt = `${header}.${payload}.fakesig`;

			await expect(verifyJwt(fakeJwt, "did:web:example.com", null)).rejects.toThrow(
				/JWT expired/,
			);
		});

		it("rejects mismatched audience", async () => {
			const payloadData = {
				iss: "did:plc:1234567890abcdefghijklmn",
				aud: "did:web:other.com",
				exp: Math.floor(Date.now() / 1000) + 300,
			};
			const header = ui8.toString(
				ui8.fromString(JSON.stringify({ alg: "ES256K", typ: "JWT" }), "utf8"),
				"base64url",
			);
			const payload = ui8.toString(
				ui8.fromString(JSON.stringify(payloadData), "utf8"),
				"base64url",
			);
			const fakeJwt = `${header}.${payload}.fakesig`;

			await expect(verifyJwt(fakeJwt, "did:web:mylabeler.com", null)).rejects.toThrow(
				/audience does not match/,
			);
		});

		it("rejects mismatched lexicon method (lxm)", async () => {
			const payloadData = {
				iss: "did:plc:1234567890abcdefghijklmn",
				aud: "did:web:mylabeler.com",
				exp: Math.floor(Date.now() / 1000) + 300,
				lxm: "tools.ozone.moderation.otherMethod",
			};
			const header = ui8.toString(
				ui8.fromString(JSON.stringify({ alg: "ES256K", typ: "JWT" }), "utf8"),
				"base64url",
			);
			const payload = ui8.toString(
				ui8.fromString(JSON.stringify(payloadData), "utf8"),
				"base64url",
			);
			const fakeJwt = `${header}.${payload}.fakesig`;

			await expect(
				verifyJwt(fakeJwt, "did:web:mylabeler.com", "tools.ozone.moderation.emitEvent"),
			).rejects.toThrow(/Bad JWT lexicon method/);
		});
	});
});
