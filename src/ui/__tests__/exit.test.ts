import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripAnsi } from "../../lib/text.ts";
import { createTheme } from "../theme.ts";
import { exitSummary } from "../view.ts";

const stream = { isTTY: true, getColorDepth: () => 24 } as unknown as NodeJS.WriteStream;
const theme = createTheme(stream, { dark: true, env: { LANG: "en_US.UTF-8", TERM: "xterm" } });
const UPDATE = { latest: "1.1.0", current: "1.0.3", cols: 100 };

describe("exitSummary", () => {
    it("adds one line under the wordmark when an update is available", () => {
        const plain = { deleted: 0, freed: 0, errors: [] };
        const without = exitSummary(plain, theme, "en");
        const lines = exitSummary(plain, theme, "en", UPDATE);
        assert.equal(lines.length, without.length + 1);
        assert.equal(
            stripAnsi(lines.at(-1)!),
            "          1.1.0 is available, you have 1.0.3: npm i -g ccleanup@latest",
        );
    });

    it("speaks French, and sets the line apart from the failures", () => {
        const session = { id: "a", title: "t" } as never;
        const errors = [{ session, message: "denied" }];
        const lines = exitSummary({ deleted: 0, freed: 0, errors }, theme, "fr", UPDATE);
        assert.equal(stripAnsi(lines.at(-2)!), "");
        assert.match(stripAnsi(lines.at(-1)!), /1\.1\.0 est disponible, tu as la 1\.0\.3 :/);
    });

    it("puts the command on its own line when the terminal is too narrow", () => {
        const plain = { deleted: 0, freed: 0, errors: [] };
        for (const lang of ["en", "fr"] as const) {
            const wide = exitSummary(plain, theme, lang, UPDATE).map(stripAnsi);
            const medium = exitSummary(plain, theme, lang, { ...UPDATE, cols: 60 }).map(stripAnsi);
            const narrow = exitSummary(plain, theme, lang, { ...UPDATE, cols: 40 }).map(stripAnsi);
            assert.equal(medium.length, wide.length + 1);
            assert.equal(medium.at(-1), "          npm i -g ccleanup@latest");
            assert.ok(medium.slice(-2).every((line) => line.length <= 60));
            assert.equal(narrow.length, wide.length + 1);
            assert.equal(narrow.at(-1), "npm i -g ccleanup@latest");
            assert.ok(narrow.slice(-2).every((line) => line.length <= 40));
        }
    });

    it("adds nothing without an update", () => {
        const lines = exitSummary({ deleted: 2, freed: 10, errors: [] }, theme, "en");
        assert.ok(lines.every((line) => !stripAnsi(line).includes("npm i -g")));
    });
});
