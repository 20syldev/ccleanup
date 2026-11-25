import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMouse, rowAt } from "../mouse.ts";

describe("parseMouse", () => {
    it("reads a plain left or right click, counting rows from 0", () => {
        assert.deepEqual(parseMouse(0, 12, "M"), { kind: "click", button: "left", y: 11 });
        assert.deepEqual(parseMouse(2, 12, "M"), { kind: "click", button: "right", y: 11 });
    });

    it("reads the wheel", () => {
        assert.deepEqual(parseMouse(64, 1, "M"), { kind: "wheel", direction: -1 });
        assert.deepEqual(parseMouse(65, 1, "M"), { kind: "wheel", direction: 1 });
    });

    it("ignores releases, drags, the middle button and modified clicks", () => {
        assert.equal(parseMouse(0, 12, "m"), undefined);
        assert.equal(parseMouse(32, 12, "M"), undefined);
        assert.equal(parseMouse(1, 12, "M"), undefined);
        assert.equal(parseMouse(4, 12, "M"), undefined);
        assert.equal(parseMouse(16, 12, "M"), undefined);
    });
});

describe("rowAt", () => {
    it("maps a click to the session on that row, past the first one shown", () => {
        assert.equal(rowAt(5, 5, 10, 0, 50), 0);
        assert.equal(rowAt(7, 5, 10, 20, 50), 22);
        assert.equal(rowAt(14, 5, 10, 20, 50), 29);
    });

    it("gives nothing above, below or past the end of the list", () => {
        assert.equal(rowAt(4, 5, 10, 0, 50), undefined);
        assert.equal(rowAt(15, 5, 10, 0, 50), undefined);
        assert.equal(rowAt(8, 5, 10, 0, 3), undefined);
    });

    it("gives nothing when no list is drawn", () => {
        assert.equal(rowAt(0, -1, 10, 0, 50), undefined);
    });
});
