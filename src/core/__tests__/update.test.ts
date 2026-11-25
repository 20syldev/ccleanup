import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { DAY } from "../../lib/format.ts";
import { cacheFile, isNewer, startUpdateCheck, updateDisabled } from "../update.ts";

const NOW = Date.UTC(2026, 10, 25, 12);
const PATIENCE = 2000;

let dir = "";
let file = "";
let count = 0;

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccleanup-update-"));
});

after(async () => {
    await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
    file = join(dir, `cache-${count++}`, "update.json");
});

/**
 * A fetch that answers with a registry manifest, and counts its calls.
 *
 * @param body - JSON body of the answer
 * @param status - HTTP status
 * @returns The fetch function and its call counter
 */
function answering(body: unknown, status = 200): { fetcher: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetcher = (async () => {
        calls++;
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fetcher, calls: () => calls };
}

/**
 * Keeps a cache file, as an earlier run would have left it.
 *
 * @param content - What to write, serialized as JSON
 */
async function keep(content: unknown): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(content));
}

describe("isNewer", () => {
    it("compares the three numbers one by one", () => {
        assert.equal(isNewer("1.1.0", "1.0.3"), true);
        assert.equal(isNewer("1.0.10", "1.0.9"), true);
        assert.equal(isNewer("2.0.0", "1.99.99"), true);
        assert.equal(isNewer("1.0.3", "1.0.3"), false);
        assert.equal(isNewer("1.0.2", "1.0.3"), false);
    });

    it("never calls anything else a newer version", () => {
        assert.equal(isNewer("1.1.0-beta.1", "1.0.3"), false);
        assert.equal(isNewer("\u001b[2J", "1.0.3"), false);
        assert.equal(isNewer("1.1.0", "dev"), false);
    });
});

describe("updateDisabled", () => {
    it("follows NO_UPDATE_NOTIFIER, CI and npx", () => {
        assert.equal(updateDisabled({}), false);
        assert.equal(updateDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
        assert.equal(updateDisabled({ CI: "true" }), true);
        assert.equal(updateDisabled({ npm_command: "exec" }), true);
        assert.equal(updateDisabled({ npm_command: "run-script" }), false);
    });
});

describe("cacheFile", () => {
    it("lives in the cache folder, ~/.cache by default", () => {
        assert.equal(cacheFile({ HOME: "/h" }), join("/h", ".cache", "ccleanup", "update.json"));
        assert.equal(
            cacheFile({ HOME: "/h", XDG_CACHE_HOME: "/x" }),
            join("/x", "ccleanup", "update.json"),
        );
        assert.equal(
            cacheFile({ HOME: "/h", XDG_CACHE_HOME: "relative" }),
            join("/h", ".cache", "ccleanup", "update.json"),
        );
    });
});

describe("startUpdateCheck", () => {
    it("asks the registry when nothing is kept, keeps the answer and reports it", async () => {
        const { fetcher, calls } = answering({ version: "1.1.0" });
        const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher });
        assert.equal(await check.finish(PATIENCE), "1.1.0");
        assert.equal(calls(), 1);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
            checkedAt: NOW,
            latest: "1.1.0",
        });
    });

    it("answers from the cache, without asking, for a day", async () => {
        await keep({ checkedAt: NOW - DAY + 1000, latest: "1.1.0" });
        const { fetcher, calls } = answering({ version: "9.9.9" });
        const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher });
        assert.equal(await check.finish(PATIENCE), "1.1.0");
        assert.equal(calls(), 0);
    });

    it("asks again after a day, or when the kept date is in the future", async () => {
        for (const checkedAt of [NOW - DAY, NOW + 1000]) {
            await keep({ checkedAt, latest: "1.0.4" });
            const { fetcher, calls } = answering({ version: "1.2.0" });
            const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher });
            assert.equal(await check.finish(PATIENCE), "1.2.0");
            assert.equal(calls(), 1);
        }
    });

    it("says nothing when the running version is the latest, or ahead", async () => {
        const { fetcher } = answering({ version: "1.0.3" });
        assert.equal(
            await startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher }).finish(PATIENCE),
            undefined,
        );
        await keep({ checkedAt: NOW, latest: "1.0.3" });
        assert.equal(
            await startUpdateCheck("1.1.0", { env: {}, now: NOW, file, fetcher }).finish(PATIENCE),
            undefined,
        );
    });

    it("keeps the earlier answer and waits a day when the registry fails", async () => {
        await keep({ checkedAt: NOW - 2 * DAY, latest: "1.1.0" });
        for (const failing of [
            answering({}, 503).fetcher,
            (async () => Promise.reject(new Error("offline"))) as typeof fetch,
        ]) {
            const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher: failing });
            assert.equal(await check.finish(PATIENCE), "1.1.0");
            assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
                checkedAt: NOW,
                latest: "1.1.0",
            });
            await keep({ checkedAt: NOW - 2 * DAY, latest: "1.1.0" });
        }
    });

    it("ignores an answer that is not a plain version", async () => {
        for (const version of ["\u001b[2J", "1.1.0-beta.1", 110, undefined]) {
            const { fetcher, calls } = answering({ version });

            // Each answer meets an empty cache, else the first one would hide the others
            await rm(file, { force: true });
            const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher });
            assert.equal(await check.finish(PATIENCE), undefined);
            assert.equal(calls(), 1);
        }
    });

    it("ignores a cache that is damaged or holds something else than a version", async () => {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "{not json");
        const { fetcher } = answering({ version: "1.1.0" });
        assert.equal(
            await startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher }).finish(PATIENCE),
            "1.1.0",
        );
        await keep({ checkedAt: NOW, latest: "\u001b[2J" });
        assert.equal(
            await startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher }).finish(PATIENCE),
            undefined,
        );
    });

    it("drops a request still running at the exit, and keeps nothing of it", async () => {
        await keep({ checkedAt: NOW - 2 * DAY, latest: "1.1.0" });
        const slow = ((_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
                const signal = init!.signal!;
                if (signal.aborted) reject(new Error("aborted"));
                signal.addEventListener("abort", () => reject(new Error("aborted")));
            })) as unknown as typeof fetch;
        const check = startUpdateCheck("1.0.3", { env: {}, now: NOW, file, fetcher: slow });
        assert.equal(await check.finish(20), "1.1.0");
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
            checkedAt: NOW - 2 * DAY,
            latest: "1.1.0",
        });
    });

    it("reads and sends nothing when it is disabled", async () => {
        await keep({ checkedAt: NOW - 2 * DAY, latest: "1.1.0" });
        const { fetcher, calls } = answering({ version: "1.2.0" });
        for (const env of [{ NO_UPDATE_NOTIFIER: "1" }, { CI: "1" }, { npm_command: "exec" }]) {
            const check = startUpdateCheck("1.0.3", { env, now: NOW, file, fetcher });
            assert.equal(await check.finish(PATIENCE), undefined);
        }
        assert.equal(calls(), 0);
    });
});
