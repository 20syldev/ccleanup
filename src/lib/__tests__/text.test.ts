import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cut, ELLIPSIS, ESC, fit, fold, sanitize, skip, width } from "../text.ts";

/**
 * Builds a string from code points, so the test source stays ASCII.
 *
 * @param codes - Unicode code points, in order
 * @returns The string they form
 */
function cp(...codes: number[]): string {
    return String.fromCodePoint(...codes);
}

const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

describe("width", () => {
    it("counts one cell per ASCII character", () => {
        assert.equal(width("ccleanup"), 8);
    });

    it("ignores escape sequences", () => {
        assert.equal(width(`${RED}abc${RESET}`), 3);
    });

    it("counts two cells for CJK and emoji", () => {
        assert.equal(width(cp(0x4e2d, 0x6587)), 4);
        assert.equal(width(cp(0x1f600)), 2);
    });

    it("counts no cell for a combining mark", () => {
        assert.equal(width(`e${cp(0x0301)}`), 1);
    });
});

describe("cut", () => {
    it("keeps text that fits", () => {
        assert.equal(cut("abc", 3), "abc");
    });

    it("ends a cut with an ellipsis within the width", () => {
        assert.equal(cut("abcdef", 4), `abc${ELLIPSIS}`);
        assert.equal(cut("abcdef", 2, "..."), "ab");
    });

    it("never splits an emoji", () => {
        const text = `ab${cp(0x1f600)}cd`;
        assert.equal(cut(text, 4), `ab${ELLIPSIS}`);
        assert.ok(width(cut(text, 4)) <= 4);
    });
});

describe("fit", () => {
    it("pads to the exact width on the chosen side", () => {
        assert.equal(fit("ab", 4), "ab  ");
        assert.equal(fit("ab", 4, "right"), "  ab");
    });

    it("cuts to the exact width with the given ellipsis", () => {
        assert.equal(width(fit("abcdef", 4)), 4);
        assert.equal(fit("abcdef", 5, "left", "..."), "ab...");
    });
});

describe("sanitize", () => {
    it("turns control characters into spaces", () => {
        assert.equal(sanitize(`a${ESC}[2Jb\tc`), "a [2Jb c");
    });

    it("drops bidirectional controls", () => {
        assert.equal(sanitize(`a${cp(0x202e)}b`), "ab");
    });

    it("reduces a joined emoji sequence to its first emoji", () => {
        const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
        assert.equal(sanitize(family), cp(0x1f468));
    });
});

describe("skip and fold", () => {
    it("drops the first cells, padding a wide character cut in half", () => {
        assert.equal(skip("abcdef", 2), "cdef");
        assert.equal(skip("a\u{1F600}b", 2), " b");
        assert.equal(skip("abc", 0), "abc");
    });

    it("folds case and accents", () => {
        assert.equal(fold("Été Déjà"), "ete deja");
    });
});
