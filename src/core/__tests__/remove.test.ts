import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { removeSession } from "../remove.ts";
import type { Session } from "../scan.ts";

const ID = "44444444-4444-4444-8444-444444444444";

let root = "";
let configDir = "";

/**
 * Writes a fixture file, creating its folders.
 *
 * @param path - Path relative to the fixture root
 * @returns The absolute path
 */
async function put(path: string): Promise<string> {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, "x");
    return full;
}

/**
 * Tells whether a path exists.
 *
 * @param path - Path to check
 * @returns True when it exists
 */
async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

/**
 * Builds a session that owns the given paths.
 *
 * @param paths - Paths the session would delete
 * @param id - Session UUID
 * @returns A session with no size
 */
function session(paths: string[], id = ID): Session {
    return {
        id,
        configDir,
        projectDir: "-p",
        project: "p",
        title: "",
        bytes: 0,
        mtime: 0,
        recent: false,
        open: false,
        paths,
        parts: [],
    };
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "ccleanup-remove-"));
    configDir = join(root, "claude");
});

after(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("removeSession", () => {
    it("refuses a path outside the config folder and deletes nothing", async () => {
        const inside = await put(`claude/projects/-p/${ID}.jsonl`);
        const outside = await put(`${ID}.jsonl`);
        await assert.rejects(removeSession(configDir, session([inside, outside])));
        assert.equal(await exists(inside), true);
        assert.equal(await exists(outside), true);
    });

    it("refuses a path that is not named after the session", async () => {
        const memory = await put("claude/projects/-p/memory/MEMORY.md");
        await assert.rejects(removeSession(configDir, session([join(memory, "..")])));
        assert.equal(await exists(memory), true);
    });

    it("refuses an id that is not a UUID", async () => {
        const file = await put("claude/projects/-p/memory.jsonl");
        await assert.rejects(removeSession(configDir, session([file], "memory")));
        assert.equal(await exists(file), true);
    });

    it("deletes every path of a valid session and nothing else", async () => {
        const transcript = await put(`claude/projects/-p/${ID}.jsonl`);
        const folder = dirname(await put(`claude/projects/-p/${ID}/tool-results/out.txt`));
        const history = dirname(await put(`claude/file-history/${ID}/snapshot`));
        const memory = await put("claude/projects/-p/memory/MEMORY.md");
        await removeSession(configDir, session([transcript, join(folder, ".."), history]));
        assert.equal(await exists(transcript), false);
        assert.equal(await exists(folder), false);
        assert.equal(await exists(history), false);
        assert.equal(await exists(memory), true);
    });
});
