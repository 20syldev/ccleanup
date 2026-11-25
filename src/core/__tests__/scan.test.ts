import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { discover, measureEntry, placeholder, scan } from "../scan.ts";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ORPHAN = "33333333-3333-4333-8333-333333333333";
const TWIN = "55555555-5555-4555-8555-555555555555";
const MOVED = "66666666-6666-4666-8666-666666666666";
const DAY = 24 * 3_600_000;
const RECENT_MS = 30 * 60_000;
const BEL = String.fromCharCode(0x07);

let root = "";

/**
 * Writes a fixture file, creating its folders.
 *
 * @param path - Path relative to the fixture root
 * @param content - File content
 * @param ageDays - Age given to the file through its modification time
 */
async function put(path: string, content: string, ageDays = 0): Promise<void> {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    const time = new Date(Date.now() - ageDays * DAY);
    await utimes(full, time, time);
}

/**
 * Serializes transcript records as JSON lines.
 *
 * @param records - Records in file order
 * @returns The .jsonl content
 */
function jsonl(...records: object[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "ccleanup-scan-"));
    const alpha = "projects/-home-test-alpha";
    await put(
        `${alpha}/${ALPHA}.jsonl`,
        jsonl(
            { type: "user", cwd: "/home/test/alpha", message: { content: "<system-reminder>x" } },
            { type: "user", message: { content: [{ type: "text", text: "first\nprompt" }] } },
            { type: "ai-title", aiTitle: "Old title" },
            { type: "ai-title", aiTitle: `Latest${BEL} title` },
        ),
        40,
    );
    await put(`${alpha}/${ALPHA}/tool-results/out.txt`, "x".repeat(5000), 40);
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(join(root, alpha, ALPHA, "tool-results"), old, old);
    await utimes(join(root, alpha, ALPHA), old, old);
    await put(`${alpha}/memory/MEMORY.md`, "never listed");
    await put(`${alpha}/notes.txt`, "not a session");
    await put(
        `projects/-home-test-beta/${BETA}.jsonl`,
        jsonl({ type: "user", cwd: "/home/test/beta", message: { content: "beta prompt" } }),
    );
    await put(`projects/-home-test-beta/${ORPHAN}/subagents/a.jsonl`, "{}", 50);
    await put(`file-history/${ALPHA}/snapshot`, "h".repeat(3000), 40);
    await put(`debug/${ALPHA}.txt`, "debug", 40);
    await put(
        `projects/-home-test-alpha/${TWIN}.jsonl`,
        jsonl({ type: "user", message: { content: "a" } }),
    );
    await put(
        `projects/-home-test-beta/${TWIN}.jsonl`,
        jsonl({ type: "user", message: { content: "b" } }),
    );
    await put(`file-history/${TWIN}/snapshot`, "t");
});

after(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("discover", () => {
    it("lists sessions only, never memory or other files", async () => {
        const ids = (await discover(root)).map((entry) => entry.id).sort();
        assert.deepEqual(ids, [ALPHA, BETA, ORPHAN, TWIN, TWIN].sort());
    });

    it("gives the folders kept by id to one of two sessions sharing an id", async () => {
        const twins = (await discover(root)).filter((entry) => entry.id === TWIN);
        assert.deepEqual(
            twins.map((entry) => entry.ownsExtras),
            [true, false],
        );
        const options = {
            now: Date.now(),
            recentMs: RECENT_MS,
            open: new Set<string>(),
        };
        const [first, second] = await Promise.all(twins.map((e) => measureEntry(e, options)));
        assert.equal(first!.paths.length, 2);
        assert.equal(second!.paths.length, 1);
    });

    it("returns nothing for a missing folder", async () => {
        assert.deepEqual(await discover(join(root, "missing")), []);
    });
});

describe("measureEntry", () => {
    const options = () => ({
        now: Date.now(),
        recentMs: RECENT_MS,
        open: new Set<string>(),
    });

    it("reads the latest AI title, sanitized, and the project from the cwd", async () => {
        const entry = (await discover(root)).find((e) => e.id === ALPHA)!;
        const session = (await measureEntry(entry, options()))!;
        assert.equal(session.title, "Latest title");
        assert.equal(session.project, "test/alpha");
        assert.equal(session.cwd, "/home/test/alpha");
        assert.equal(session.recent, false);
    });

    it("counts the folder, the file history and the debug log with the transcript", async () => {
        const entry = (await discover(root)).find((e) => e.id === ALPHA)!;
        const session = (await measureEntry(entry, options()))!;
        const names = session.paths.map((path) => path.slice(root.length));
        assert.equal(names.length, 4);
        assert.ok(names.some((name) => name.startsWith("/file-history/")));
        assert.ok(names.some((name) => name.startsWith("/debug/")));
        assert.ok(session.bytes >= 8000);
    });

    it("falls back to the first prompt and flags a fresh session as recent", async () => {
        const entry = (await discover(root)).find((e) => e.id === BETA)!;
        const session = (await measureEntry(entry, options()))!;
        assert.equal(session.title, "beta prompt");
        assert.equal(session.recent, true);
    });

    it("takes the cwd of the project folder when the session moved", async () => {
        const moved = await mkdtemp(join(tmpdir(), "ccleanup-moved-"));
        try {
            const path = join(moved, "projects", "-home-test-gamma-app", `${MOVED}.jsonl`);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
                path,
                jsonl(
                    { type: "user", cwd: "/home/test", message: { content: "start at home" } },
                    { type: "user", cwd: "/home/test/gamma.app" },
                    { type: "user", cwd: "/home/test/gamma.app/src" },
                ),
            );
            const entry = (await discover(moved))[0]!;
            const session = (await measureEntry(entry, options()))!;
            assert.equal(session.cwd, "/home/test/gamma.app");
            assert.equal(session.project, "test/gamma.app");
        } finally {
            await rm(moved, { recursive: true, force: true });
        }
    });

    it("matches a long project folder that Claude Code cut and gave a hash", async () => {
        const moved = await mkdtemp(join(tmpdir(), "ccleanup-long-"));
        try {
            const cwd = `/home/test/${"verylongsegment/".repeat(14)}app`;
            const folder = `${cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-1x2y3z`;
            const path = join(moved, "projects", folder, `${MOVED}.jsonl`);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
                path,
                jsonl(
                    { type: "user", cwd: "/home/test", message: { content: "start at home" } },
                    { type: "user", cwd },
                ),
            );
            const entry = (await discover(moved))[0]!;
            const session = (await measureEntry(entry, options()))!;
            assert.equal(session.cwd, cwd);
            assert.equal(session.project, "verylongsegment/app");
        } finally {
            await rm(moved, { recursive: true, force: true });
        }
    });

    it("measures a folder without transcript, with a project guessed from its name", async () => {
        const entry = (await discover(root)).find((e) => e.id === ORPHAN)!;
        const session = (await measureEntry(entry, options()))!;
        assert.equal(session.title, "");
        assert.equal(session.project, "test/beta");
    });
});

describe("placeholder and scan", () => {
    it("builds a pending row before measurement", async () => {
        const entry = (await discover(root))[0]!;
        const row = placeholder(entry);
        assert.equal(row.pending, true);
        assert.deepEqual(row.paths, []);
    });

    it("measures everything", async () => {
        const sessions = await scan([root], {
            now: Date.now(),
            recentMs: RECENT_MS,
            open: new Set<string>(),
        });
        assert.equal(sessions.length, 5);
        assert.ok(sessions.every((session) => !session.pending));
    });
});
