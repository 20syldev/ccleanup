import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openSessions, sessionArgs } from "../live.ts";

const RUNNING = "11111111-1111-4111-8111-111111111111";
const DEAD = "22222222-2222-4222-8222-222222222222";
const REUSED = "33333333-3333-4333-8333-333333333333";
const RESUMED = "55555555-5555-4555-8555-555555555555";
const FOREIGN = "66666666-6666-4666-8666-666666666666";
const STALE = "77777777-7777-4777-8777-777777777777";
const LINUX = process.platform === "linux";

// A process id above the kernel limit, which can never run
const NO_PID = 2 ** 22 + 1;

let root = "";
let child: ChildProcess | undefined;

/**
 * Writes the record Claude Code keeps for a running instance.
 *
 * @param pid - Process id of the instance
 * @param sessionId - Session it runs
 * @param procStart - Start time of the process, when known
 */
async function record(pid: number, sessionId: string, procStart?: string): Promise<void> {
    const body = JSON.stringify({ pid, sessionId, procStart, kind: "interactive" });
    await writeFile(join(root, "sessions", `${pid}.json`), body);
}

/**
 * Start time of this test process, as written by Claude Code.
 *
 * @returns Field 22 of /proc/self/stat, or undefined off Linux
 */
async function ownStart(): Promise<string | undefined> {
    if (!LINUX) return undefined;
    const stat = await readFile("/proc/self/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "ccleanup-live-"));
    await mkdir(join(root, "sessions"));
});

after(async () => {
    child?.kill();
    await rm(root, { recursive: true, force: true });
});

describe("sessionArgs", () => {
    it("reads the session flags of the claude command", () => {
        assert.deepEqual(sessionArgs(["claude", `--resume=${RUNNING}`]), [RUNNING]);
        assert.deepEqual(sessionArgs(["claude", "--resume", RUNNING]), [RUNNING]);
        assert.deepEqual(sessionArgs(["claude", "-r", RUNNING, "--session-id", DEAD]), [
            RUNNING,
            DEAD,
        ]);
    });

    it("ignores other flags and values that are not session ids", () => {
        assert.deepEqual(sessionArgs(["claude", "--resume"]), []);
        assert.deepEqual(sessionArgs(["claude", "--resume", "latest"]), []);
        assert.deepEqual(sessionArgs(["node", "--model", RUNNING]), []);
    });
});

describe("openSessions", () => {
    it("finds nothing without a sessions folder", async () => {
        const empty = await mkdtemp(join(tmpdir(), "ccleanup-live-empty-"));
        try {
            const open = await openSessions([empty]);
            assert.equal(open.has(RUNNING), false);
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });

    it("keeps the records of live processes only", async () => {
        await record(process.pid, RUNNING, await ownStart());
        await record(NO_PID, DEAD);
        await writeFile(join(root, "sessions", "77.json"), "{ not json");
        const open = await openSessions([root]);
        assert.equal(open.has(RUNNING), true);
        assert.equal(open.has(DEAD), false);
    });

    it("drops a record whose process id was reused", { skip: !LINUX }, async () => {
        await rm(join(root, "sessions", `${process.pid}.json`));
        await record(process.pid, REUSED, "1");
        const open = await openSessions([root]);
        assert.equal(open.has(REUSED), false);
    });

    it(
        "trusts a fresh record from another namespace, not a stale one",
        { skip: !LINUX },
        async () => {
            const own = await readlink("/proc/self/ns/pid");
            const domain = `linux:0000:pid:[1${own.replace(/\D/g, "")}]`;
            const write = async (pid: number, sessionId: string) => {
                const body = JSON.stringify({ pid, sessionId, pidDomain: domain });
                await writeFile(join(root, "sessions", `${pid}.json`), body);
            };
            await write(NO_PID + 1, FOREIGN);
            await write(NO_PID + 2, STALE);
            const old = new Date(Date.now() - 2 * 24 * 3_600_000);
            await utimes(join(root, "sessions", `${NO_PID + 2}.json`), old, old);
            const open = await openSessions([root]);
            assert.equal(open.has(FOREIGN), true);
            assert.equal(open.has(STALE), false);
        },
    );

    it("finds a session resumed by a running command", { skip: !LINUX }, async () => {
        const keepAlive = "setTimeout(() => {}, 30000)";
        child = spawn(process.execPath, ["-e", keepAlive, "--", "--resume", RESUMED], {
            stdio: "ignore",
        });
        await new Promise((resolve) => child!.once("spawn", resolve));
        const open = await openSessions([root]);
        assert.equal(open.has(RESUMED), true);
    });
});
