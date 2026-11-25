import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../core/scan.ts";
import { stripAnsi, width } from "../../lib/text.ts";
import { createTheme } from "../theme.ts";
import { view, type ViewState } from "../view.ts";

const NOW = Date.UTC(2026, 10, 25, 12);
const BRAILLE = /[⠀-⣿]/;

/**
 * A made-up session.
 *
 * @param index - Position, which also sets its size and age
 * @returns The session
 */
function session(index: number): Session {
    return {
        id: `${index.toString(16).padStart(8, "0")}-4c1e-4a7f-9b2d-5e8f3a6c0001`,
        configDir: "/home/u/.claude",
        projectDir: "-home-u-p",
        project: "u/p",
        title: `Session ${index}`,
        bytes: (index + 1) * 1_000_000,
        mtime: NOW - (index + 2) * 86_400_000,
        startedAt: NOW - (index + 3) * 86_400_000,
        recent: false,
        open: false,
        cwd: "/home/u/p",
        paths: [],
        parts: [{ kind: "transcript", bytes: (index + 1) * 1_000_000 }],
    } as unknown as Session;
}

/**
 * The state of a scan in progress, drawn as a true color terminal would.
 *
 * @param count - Sessions listed so far
 * @param clock - Time of the frame
 * @param scan - Scan fields that differ from a scan under way
 * @returns The frame state
 */
function scanning(count: number, clock: number, scan: Partial<ViewState["scan"]> = {}): ViewState {
    const stream = { isTTY: true, getColorDepth: () => 24 } as unknown as NodeJS.WriteStream;
    const theme = createTheme(stream, {
        dark: true,
        env: { LANG: "en_US.UTF-8", TERM: "xterm-256color" },
    });
    const list = Array.from({ length: count }, (_, i) => session(i));
    const empty = { count: 0, bytes: 0 };
    return {
        lang: "en",
        theme,
        version: "1.2.0",
        now: NOW,
        clock,
        sessions: list,
        sort: "size",
        reversed: false,
        step: 1,
        cursor: 0,
        top: 0,
        marked: new Set(),
        states: new Map(),
        olderThan: 14 * 86_400_000,
        markable: () => true,
        stats: { sessions: empty, marked: empty, releasable: empty, freed: 0 },
        flashes: new Map(),
        scan: { total: 30, done: count, startedAt: NOW, ...scan },
        errors: [],
        errorsOpen: false,
        errorsScroll: 0,
        listHeight: 10,
        confirming: false,
        query: "",
        searching: false,
        total: count,
        helpOpen: false,
        helpScroll: 0,
        detailsOpen: false,
        detailsShown: false,
        rowsTop: -1,
        targets: [],
        hiddenTargets: 0,
        oldShown: false,
        includeRecent: false,
    };
}

describe("view during the scan", () => {
    it("never draws more rows or wider lines than the terminal has", () => {
        for (const count of [0, 1, 5, 12, 30]) {
            for (let cols = 40; cols <= 160; cols += 7) {
                for (let rows = 8; rows <= 40; rows += 3) {
                    for (const clock of [NOW + 300, NOW + 2000, NOW + 4000]) {
                        const lines = view(scanning(count, clock), cols, rows);
                        assert.equal(lines.length, rows, `${count} sessions, ${cols}x${rows}`);
                        for (const line of lines) {
                            assert.ok(width(stripAnsi(line)) <= cols, `${cols}x${rows}`);
                        }
                    }
                }
            }
        }
    });

    it("lets embers rise under the list, no wider than the footer text", () => {
        const lines = view(scanning(8, NOW + 3000), 120, 30).map(stripAnsi);
        const footer = lines.at(-1)!;
        const dusty = lines.filter((line) => BRAILLE.test(line) && !line.includes("Scanning"));
        assert.ok(dusty.length > 0);
        assert.ok(dusty.length <= 3);
        for (const line of dusty) {
            assert.ok(width(line.trimEnd()) <= width(footer.trimEnd()), line);
        }
    });

    it("keeps the embers a little after the scan, then none", () => {
        const done = { endedAt: NOW + 2000 };
        const after = (ms: number) =>
            view(scanning(8, NOW + 2000 + ms, done), 120, 30)
                .map(stripAnsi)
                .filter((line) => BRAILLE.test(line)).length;
        assert.ok(after(500) > 0);
        assert.equal(after(2600), 0);
    });

    it("never resizes the list: the embers only use the free rows under it", () => {
        for (const [count, rows] of [
            [8, 30],
            [20, 24],
            [30, 20],
            [60, 40],
        ] as const) {
            const sessionRows = (clock: number, scan: Partial<ViewState["scan"]> = {}) =>
                view(scanning(count, clock, scan), 120, rows)
                    .map(stripAnsi)
                    .filter((line) => /Session \d+/.test(line)).length;
            const during = sessionRows(NOW + 3000);
            const after = sessionRows(NOW + 9000, { endedAt: NOW + 2000 });
            assert.equal(during, after, `${count} sessions, ${rows} rows`);
        }
    });

    it("draws no embers when the list fills the screen", () => {
        const lines = view(scanning(60, NOW + 3000), 120, 20).map(stripAnsi);
        const dusty = lines.filter((line) => BRAILLE.test(line) && !line.includes("Scanning"));
        assert.equal(dusty.length, 0);
    });
});
