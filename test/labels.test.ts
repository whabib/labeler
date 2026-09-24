import { fromBytes, toBytes } from "@atcute/cbor";
import { secp256k1 as k256 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import { formatLabel, labelIsSigned, signLabel, toSignedLabel } from "../src/util/labels.js";
import type { UnsignedLabel } from "../src/util/types.js";

describe("labels", () => {
	const privateKey = k256.utils.randomPrivateKey();
	const testDid = "did:plc:ragtjsm2j2vknq6zbnujgah7" as const;
	const testPostUri =
		"at://did:plc:ragtjsm2j2vknq6zbnujgah7/app.bsky.feed.post/3k63v2p5xwk2l" as const;

	const baseUnsignedLabel: UnsignedLabel = {
		src: testDid,
		uri: testPostUri,
		val: "spam",
		cts: "2026-01-01T00:00:00.000Z",
	};

	describe("signLabel & toSignedLabel", () => {
		it("signs an unsigned label with secp256k1", () => {
			const signed = signLabel(baseUnsignedLabel, privateKey);

			expect(signed.ver).toBe(1);
			expect(signed.neg).toBe(false);
			expect(signed.sig).toBeInstanceOf(Uint8Array);
			expect(signed.sig.byteLength).toBe(64);
			expect(labelIsSigned(signed)).toBe(true);
		});

		it("toSignedLabel preserves existing signature as Uint8Array", () => {
			const sigBytes = new Uint8Array(64).fill(1);
			const labelWithBytes = { ...baseUnsignedLabel, sig: toBytes(sigBytes) };

			const result = toSignedLabel(labelWithBytes, privateKey);
			expect(result.sig).toEqual(sigBytes);
		});

		it("toSignedLabel accepts ArrayBuffer signature", () => {
			const sigBytes = new Uint8Array(64).fill(2);
			const labelWithBuffer = { ...baseUnsignedLabel, sig: sigBytes.buffer };

			const result = toSignedLabel(labelWithBuffer, privateKey);
			expect(result.sig).toEqual(sigBytes);
		});

		it("toSignedLabel signs unsigned label if no sig present", () => {
			const result = toSignedLabel(baseUnsignedLabel, privateKey);
			expect(result.sig).toBeInstanceOf(Uint8Array);
			expect(result.sig.byteLength).toBe(64);
		});
	});

	describe("formatLabel", () => {
		it("formats a signed label for wire transport with $bytes signature", () => {
			const signed = signLabel(baseUnsignedLabel, privateKey);
			const formatted = formatLabel(signed);

			expect(formatted.ver).toBe(1);
			expect(formatted.src).toBe(testDid);
			expect(formatted.uri).toBe(testPostUri);
			expect(formatted.sig).toHaveProperty("$bytes");
			expect(typeof formatted.sig.$bytes).toBe("string");

			// Roundtrip bytes
			const decodedSig = fromBytes(formatted.sig);
			expect(decodedSig).toEqual(signed.sig);
		});

		it("accepts a DID as subject uri", () => {
			const accountLabel: UnsignedLabel = {
				src: testDid,
				uri: "did:plc:anotheraccount12345678",
				val: "bot",
				cts: "2026-01-01T00:00:00.000Z",
			};
			const signed = signLabel(accountLabel, privateKey);
			const formatted = formatLabel(signed);

			expect(formatted.uri).toBe("did:plc:anotheraccount12345678");
		});

		it("throws when src is not a valid DID", () => {
			const invalid = {
				src: "not-a-did",
				uri: testPostUri,
				val: "test",
				cts: "2026-01-01T00:00:00.000Z",
				sig: new Uint8Array(64),
			};
			expect(() => formatLabel(invalid as unknown as UnsignedLabel)).toThrow(
				/Expected src to be a DID/,
			);
		});

		it("throws when uri is neither a DID nor an AT URI", () => {
			const invalid = {
				src: testDid,
				uri: "https://example.com/post/123",
				val: "test",
				cts: "2026-01-01T00:00:00.000Z",
				sig: new Uint8Array(64),
			};
			expect(() => formatLabel(invalid as unknown as UnsignedLabel)).toThrow(
				/Expected uri to be a DID or AT URI/,
			);
		});

		it("throws when signature is missing or malformed", () => {
			const noSig = { ...baseUnsignedLabel };
			expect(() => formatLabel(noSig)).toThrow(/Expected sig to be an object/);
		});
	});

	describe("labelIsSigned", () => {
		it("returns true for signed label and false for unsigned", () => {
			expect(labelIsSigned(baseUnsignedLabel)).toBe(false);

			const signed = signLabel(baseUnsignedLabel, privateKey);
			expect(labelIsSigned(signed)).toBe(true);
		});
	});
});
