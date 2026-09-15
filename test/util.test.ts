import { decodeFirst } from "@atcute/cbor";
import { describe, expect, it } from "vitest";
import { excludeNullish, frameToBytes } from "../src/util/util.js";

describe("util", () => {
	describe("excludeNullish", () => {
		it("removes undefined and null properties", () => {
			const input = { a: "hello", b: undefined, c: null, d: 123 };
			const result = excludeNullish(input);
			expect(result).toEqual({ a: "hello", d: 123 });
			expect("b" in result).toBe(false);
			expect("c" in result).toBe(false);
		});

		it("preserves falsy values that are not null or undefined", () => {
			const input = { zero: 0, emptyStr: "", booleanFalse: false, nan: NaN };
			const result = excludeNullish(input);
			expect(result).toEqual({ zero: 0, emptyStr: "", booleanFalse: false, nan: NaN });
		});

		it("handles empty objects", () => {
			expect(excludeNullish({})).toEqual({});
		});
	});

	describe("frameToBytes", () => {
		it("correctly encodes error frames", () => {
			const errorBody = { error: "FutureCursor", message: "Cursor is in the future" };
			const bytes = frameToBytes("error", errorBody);

			expect(bytes).toBeInstanceOf(Uint8Array);

			const [header, remainder] = decodeFirst(bytes);
			expect(header).toEqual({ op: -1 });

			const [body] = decodeFirst(remainder);
			expect(body).toEqual(errorBody);
		});

		it("correctly encodes message frames with type tag", () => {
			const messageBody = { seq: 42, labels: [] };
			const bytes = frameToBytes("message", messageBody, "#labels");

			expect(bytes).toBeInstanceOf(Uint8Array);

			const [header, remainder] = decodeFirst(bytes);
			expect(header).toEqual({ op: 1, t: "#labels" });

			const [body] = decodeFirst(remainder);
			expect(body).toEqual(messageBody);
		});
	});
});
