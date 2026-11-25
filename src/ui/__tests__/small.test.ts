import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripAnsi, width } from "../../lib/text.ts";
import { tooSmallView } from "../small.ts";
import { createTheme, type Theme } from "../theme.ts";

const NEED = { cols: 40, rows: 8 };

/**
 * A theme as a true color terminal would get it, or as the Linux console would.
 *
 * @param unicode - Unicode glyphs, else their ASCII twins
 * @returns The theme
 */
function theme(unicode: boolean): Theme {
    const stream = { isTTY: true, getColorDepth: () => 24 } as unknown as NodeJS.WriteStream;
    const env = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };
    return createTheme(stream, {
        dark: true,
        env: unicode ? env : { ...env, CCLEANUP_ASCII: "1" },
    });
}

describe("tooSmallView", () => {
    it("never draws more rows or wider lines than the terminal has", () => {
        for (const unicode of [true, false]) {
            const paint = theme(unicode);
            for (let cols = 1; cols < NEED.cols; cols++) {
                for (let rows = 1; rows < 20; rows++) {
                    const lines = tooSmallView(paint, "fr", cols, rows, NEED);
                    assert.ok(lines.length <= rows, `${cols} x ${rows}: ${lines.length} rows`);
                    for (const line of lines)
                        assert.ok(width(line) <= cols, `${cols} x ${rows}: ${stripAnsi(line)}`);
                }
            }
        }
    });

    it("shows the mascot when tall enough, else the marked name, else neither", () => {
        const paint = theme(true);
        const text = (cols: number, rows: number) =>
            tooSmallView(paint, "en", cols, rows, NEED).map(stripAnsi).join("\n");
        assert.ok(!text(34, 12).includes("ccleanup"));
        assert.ok(text(34, 12).includes("press q to quit"));
        assert.ok(text(60, 6).includes(`${paint.glyphs.marked} ccleanup`));
        assert.ok(!text(22, 5).includes("ccleanup"));
        assert.ok(text(22, 5).includes(`22 ${paint.glyphs.times} 5`));
    });
});
