import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { pool, UUID } from "./scan.ts";

const PROC = "/proc";
const PROC_CONCURRENCY = 32;

// A record from another process namespace is trusted while this fresh
const FOREIGN_MS = 24 * 3_600_000;

// Start time in /proc/<pid>/stat, after the command name (field 22)
const START_FIELD = 19;

// Options of the claude command that name the session it runs
const SESSION_FLAGS = new Set(["--resume", "-r", "--session-id"]);

/**
 * Tells whether a process exists.
 *
 * @param pid - Process id, a positive integer
 * @returns True when the process runs, even under another user
 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Start time of a process, as the kernel counts it.
 *
 * @param pid - Process id
 * @returns The start time in clock ticks since boot, or undefined without /proc
 */
async function processStart(pid: number): Promise<string | undefined> {
    try {
        const stat = await readFile(join(PROC, String(pid), "stat"), "utf8");

        // The command name may hold spaces: count after its parenthesis.
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[START_FIELD];
    } catch {
        return undefined;
    }
}

/**
 * Process namespace of this program, as Claude Code writes it at the end of `pidDomain`.
 *
 * @returns A value such as `pid:[4026531836]`, or undefined without /proc
 */
async function ownNamespace(): Promise<string | undefined> {
    try {
        return await readlink(join(PROC, "self", "ns", "pid"));
    } catch {
        return undefined;
    }
}

/**
 * Tells whether a record was written by Claude Code lately.
 *
 * @param path - Path of the record
 * @returns True when the file changed less than FOREIGN_MS ago
 */
async function fresh(path: string): Promise<boolean> {
    try {
        return Date.now() - (await stat(path)).mtimeMs < FOREIGN_MS;
    } catch {
        return false;
    }
}

/**
 * Reads one record that Claude Code keeps for each running instance.
 *
 * @param path - Path of a `sessions/<pid>.json` file
 * @param namespace - Process namespace of this program, when known
 * @returns The session id when its process still runs, else undefined
 */
async function registeredSession(
    path: string,
    namespace: string | undefined,
): Promise<string | undefined> {
    let record: Record<string, unknown>;
    try {
        record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const { pid, sessionId, procStart, pidDomain } = record;
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) return undefined;

    // Its process ids mean nothing here: rely on the file date.
    if (namespace && typeof pidDomain === "string" && !pidDomain.endsWith(namespace)) {
        return (await fresh(path)) ? sessionId : undefined;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (!alive(pid)) return undefined;

    // A reused process id belongs to another program, started at another time.
    if (typeof procStart === "string") {
        const start = await processStart(pid);
        if (start !== undefined && start !== procStart) return undefined;
    }
    return sessionId;
}

/**
 * Sessions that Claude Code declares running, from `<config>/sessions/<pid>.json`.
 *
 * @param configDir - Claude Code config folder
 * @returns Session ids whose process still runs; none when the folder is missing
 */
async function registeredSessions(configDir: string): Promise<string[]> {
    const dir = join(configDir, "sessions");
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const files = names.filter((name) => /^\d+\.json$/.test(name));
    const namespace = await ownNamespace();
    const ids = await pool(files, PROC_CONCURRENCY, (name) =>
        registeredSession(join(dir, name), namespace),
    );
    return ids.filter((id): id is string => id !== undefined);
}

/**
 * Session ids named on a command line, as `--resume <id>`, `--resume=<id>`, `-r <id>` or
 * `--session-id <id>`.
 *
 * @param args - Arguments of a process
 * @returns The ids found, possibly none
 */
export function sessionArgs(args: string[]): string[] {
    const ids: string[] = [];
    args.forEach((arg, i) => {
        const equal = arg.indexOf("=");
        const flag = equal === -1 ? arg : arg.slice(0, equal);
        if (!SESSION_FLAGS.has(flag)) return;
        const value = equal === -1 ? args[i + 1] : arg.slice(equal + 1);
        if (value !== undefined && UUID.test(value)) ids.push(value);
    });
    return ids;
}

/**
 * Sessions resumed by a running process, from the command lines in /proc.
 *
 * Any process counts, not only claude: a false match only protects a session longer.
 *
 * @returns Session ids found; none off Linux
 */
async function resumedSessions(): Promise<string[]> {
    if (process.platform !== "linux") return [];
    let pids: string[];
    try {
        pids = (await readdir(PROC)).filter((name) => /^\d+$/.test(name));
    } catch {
        return [];
    }
    const found = await pool(pids, PROC_CONCURRENCY, async (pid) => {
        try {
            const cmdline = await readFile(join(PROC, pid, "cmdline"), "utf8");
            return sessionArgs(cmdline.split("\0"));
        } catch {
            return [];
        }
    });
    return found.flat();
}

/**
 * Sessions open right now in a Claude Code instance, so they are never deleted.
 *
 * Two sources are merged: the records Claude Code keeps per running instance, checked
 * against the live processes, and on Linux the session ids passed to running commands.
 * A record from another process namespace counts as open for a day after its last write.
 *
 * @param configDirs - Claude Code config folders, each with its own records
 * @returns Ids of the open sessions, lowercase
 */
export async function openSessions(configDirs: string[]): Promise<Set<string>> {
    const [registered, resumed] = await Promise.all([
        Promise.all(configDirs.map(registeredSessions)),
        resumedSessions(),
    ]);
    return new Set([...registered.flat(), ...resumed].map((id) => id.toLowerCase()));
}
