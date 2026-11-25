import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../core/scan.ts";
import { stripAnsi } from "../../lib/text.ts";
import { detailsBox } from "../panels.ts";
import { createTheme } from "../theme.ts";
import type { ViewState } from "../view.ts";

const ID = "c66475fb-2a96-423f-848c-c469398df881";

/**
 * The details of a session, as the frame would draw them.
 *
 * @param lang - Language of the texts
 * @param cols - Terminal width
 * @returns The Resume row of the box, without colors
 */
function resumeRow(lang: "en" | "fr", cols: number): string {
    const stream = { isTTY: true, getColorDepth: () => 24 } as unknown as NodeJS.WriteStream;
    const theme = createTheme(stream, { dark: true, env: { LANG: "en_US.UTF-8", TERM: "xterm" } });
    const session = {
        id: ID,
        title: "A title",
        project: "p",
        cwd: "/home/u/p",
        configDir: "/home/u/.claude",
        mtime: 0,
        startedAt: 0,
        bytes: 10,
        parts: [],
        open: false,
        recent: false,
    } as unknown as Session;
    const state = { theme, lang, now: 1000, marked: new Set() } as unknown as ViewState;
    const rows = detailsBox(state, session, "k", cols).map(stripAnsi);
    return rows.find((row) => row.includes("--resume"))!;
}

describe("detailsBox", () => {
    it("shows the run hint after the command when there is room", () => {
        assert.match(resumeRow("en", 100), new RegExp(`--resume ${ID}  c run`));
        assert.match(resumeRow("fr", 100), new RegExp(`--resume ${ID}  c lancer`));
    });

    it("never cuts the hint in the middle, from the narrowest width up", () => {
        for (const lang of ["en", "fr"] as const) {
            const word = lang === "en" ? "run" : "lancer";
            for (let cols = 40; cols <= 110; cols++) {
                const row = resumeRow(lang, cols);

                // A cut id leaves no room for a hint
                if (!row.includes(ID)) continue;
                const after = row.slice(row.indexOf(ID) + ID.length);

                // Whole hint, or nothing of it: no stray "c" or half a word
                assert.ok(
                    after.includes(`  c ${word}`) || !/\bc\b/.test(after.replace(/[|│\s]/g, " ")),
                    `${lang} ${cols}: ${row}`,
                );
            }
        }
    });
});
