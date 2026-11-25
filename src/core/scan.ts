import type { Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitize } from "../lib/text.ts";

/**
 * What a session is made of on disk: its transcript, the folder beside it, the file
 * history, environment and debug log kept by id in the config folder, and the scratch
 * folder Claude Code keeps for it in the temporary folder of the system.
 */
export type PartKind = "transcript" | "folder" | "history" | "env" | "debug" | "scratch";

/**
 * A Claude Code session, found in the config folder `configDir`. `bytes` is the disk
 * usage of everything in `paths`, which are removed together, and `parts` splits it by
 * kind; `mtime` is the newest change in the transcript and its folder; `startedAt` is
 * the time of its first record, when known; `recent` flags a session changed less than
 * the recent delay ago, which may be running; `open` flags a session running right now
 * in Claude Code, which is never deleted; `pending` marks a placeholder that is not
 * measured yet.
 */
export interface Session {
    id: string;
    configDir: string;
    projectDir: string;
    project: string;
    title: string;
    bytes: number;
    mtime: number;
    startedAt?: number;
    recent: boolean;
    open: boolean;
    cwd?: string;
    pending?: boolean;
    paths: string[];
    parts: { kind: PartKind; bytes: number }[];
}

/**
 * A session found on disk before any measurement; `configDir` is the config folder it
 * belongs to and `dir` the project folder that holds its transcript. The same id can
 * appear in two project folders: only the first one owns the folders kept by id outside
 * projects (file history, environment, debug log), so they are counted and deleted once.
 */
export interface Entry {
    id: string;
    configDir: string;
    projectDir: string;
    dir: string;
    ownsExtras: boolean;
}

/**
 * When to scan: `recentMs` is the delay under which a session counts as recent; `open`
 * lists the ids of the sessions running now, from openSessions; `tempRoot` is the folder of
 * claudeTempRoot, where the scratch folders are looked for, none when it is not given.
 */
export interface ScanOptions {
    now: number;
    recentMs: number;
    open: ReadonlySet<string>;
    tempRoot?: string;
}

/**
 * One parsed line of a transcript.
 */
type JsonRecord = Record<string, unknown>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE = 64 * 1024;
const TITLE_MAX = 200;

// Longest project folder name Claude Code keeps before it adds a hash
const PROJECT_DIR_MAX = 200;

export const CONCURRENCY = 8;

/**
 * Identifies a session uniquely, even when its id appears in two project folders or two
 * config folders.
 *
 * @param session - Session or entry, read for its config folder, project folder and id
 * @returns "<configDir>/projects/<projectDir>/<id>"
 */
export function sessionKey(session: { configDir: string; projectDir: string; id: string }): string {
    return join(session.configDir, "projects", session.projectDir, session.id);
}

/**
 * Measures a file or a whole folder without following symlinks.
 *
 * @param path - File or folder
 * @returns Disk usage in bytes (allocated blocks) and newest modification time, or null when the path does not exist; a file with several hard links is counted once
 */
async function measure(path: string): Promise<{ bytes: number; mtime: number } | null> {
    let info;
    try {
        info = await lstat(path);
    } catch {
        return null;
    }
    const usage = (stat: typeof info) => (stat.blocks > 0 ? stat.blocks * 512 : stat.size);
    if (!info.isDirectory()) return { bytes: usage(info), mtime: info.mtimeMs };

    let bytes = usage(info);
    let mtime = info.mtimeMs;
    const stack = [path];
    const linked = new Set<string>();
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        const stats = await Promise.all(
            entries.map(async (entry) => {
                const full = join(dir, entry.name);
                try {
                    return { full, isDir: entry.isDirectory(), stat: await lstat(full) };
                } catch {
                    return null;
                }
            }),
        );
        for (const item of stats) {
            if (!item) continue;
            mtime = Math.max(mtime, item.stat.mtimeMs);

            // Deleting every link frees the file once
            if (!item.isDir && item.stat.nlink > 1) {
                const key = `${item.stat.dev}:${item.stat.ino}`;
                if (linked.has(key)) continue;
                linked.add(key);
            }
            bytes += usage(item.stat);
            if (item.isDir) stack.push(item.full);
        }
    }
    return { bytes, mtime };
}

/**
 * Parses the JSON lines of a transcript chunk.
 *
 * @param text - Chunk of a .jsonl file
 * @returns The records that parse; a line cut at a chunk boundary is skipped
 */
function parseLines(text: string): JsonRecord[] {
    const out: JsonRecord[] = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
            out.push(JSON.parse(line) as JsonRecord);
        } catch {
            continue;
        }
    }
    return out;
}

/**
 * Reads the first and last 64 KB of a transcript.
 *
 * A file of several hundred MB thus costs two small reads.
 *
 * @param file - Transcript path
 * @returns Records of the head and of the tail; both hold the whole file when it is small
 */
async function readEdges(file: string): Promise<{ head: JsonRecord[]; tail: JsonRecord[] }> {
    const handle = await open(file, "r");
    try {
        const { size } = await handle.stat();
        const read = async (position: number, length: number) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            return buffer.toString("utf8", 0, bytesRead);
        };
        if (size <= EDGE * 2) {
            const all = parseLines(await read(0, size));
            return { head: all, tail: all };
        }
        const headText = await read(0, EDGE);
        const tailText = await read(size - EDGE, EDGE);
        return {
            head: parseLines(headText.slice(0, headText.lastIndexOf("\n"))),
            tail: parseLines(tailText.slice(tailText.indexOf("\n") + 1)),
        };
    } finally {
        await handle.close();
    }
}

/**
 * Extracts the text a user typed from a transcript record.
 *
 * @param record - Transcript record
 * @returns The prompt text, or undefined for other records, meta records and injected context such as system reminders
 */
function promptText(record: JsonRecord): string | undefined {
    if (record.type !== "user" || record.isMeta === true) return undefined;
    const content = (record.message as { content?: unknown } | undefined)?.content;
    let text: string | undefined;
    if (typeof content === "string") {
        text = content;
    } else if (Array.isArray(content)) {
        const part = content.find(
            (item): item is { type: string; text: string } =>
                typeof item === "object" &&
                item !== null &&
                (item as JsonRecord).type === "text" &&
                typeof (item as JsonRecord).text === "string",
        );
        text = part?.text;
    }
    if (!text || text.trimStart().startsWith("<")) return undefined;
    return text;
}

/**
 * Turns transcript text into a one-line title.
 *
 * @param text - Raw title or prompt
 * @returns Sanitized text on one line, at most 200 characters, empty when missing
 */
function clean(text: string | undefined): string {
    return sanitize(text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, TITLE_MAX);
}

/**
 * Short project label for the list.
 *
 * @param cwd - Working directory recorded in the transcript
 * @param projectDir - Encoded project folder name, slashes turned into dashes by Claude Code
 * @returns "~" for the home folder, the two last segments of the cwd, or a guess from the folder name when the cwd is unknown
 */
export function shortProject(cwd: string | undefined, projectDir: string): string {
    if (!cwd) return projectDir.replace(/^-/, "").split("-").slice(-2).join("/");
    if (cwd === homedir()) return "~";
    return sanitize(cwd.split("/").filter(Boolean).slice(-2).join("/"));
}

/**
 * Tells whether a project folder was named after a working directory, the way Claude Code
 * names them: each character other than a letter or a digit turned into a dash. A longer
 * name is cut and given a hash, so only its start is compared, as Claude Code does.
 *
 * @param cwd - Working directory
 * @param projectDir - Name of the project folder
 * @returns True when the folder belongs to that working directory
 */
export function ownsProjectDir(cwd: string, projectDir: string): boolean {
    const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    if (name.length <= PROJECT_DIR_MAX) return name === projectDir;
    return projectDir.startsWith(`${name.slice(0, PROJECT_DIR_MAX)}-`);
}

/**
 * Finds the first value a picker returns over a list of records.
 *
 * @param records - Records to scan
 * @param pick - Returns a value for a matching record, undefined otherwise
 * @param last - Scan from the end, to get the latest value
 * @returns The first value found, or undefined
 */
function find<T>(
    records: JsonRecord[],
    pick: (record: JsonRecord) => T | undefined,
    last = false,
): T | undefined {
    const list = last ? [...records].reverse() : records;
    for (const record of list) {
        const value = pick(record);
        if (value !== undefined) return value;
    }
    return undefined;
}

/**
 * Reads a non-empty string field of a record.
 *
 * @param record - Transcript record
 * @param key - Field name
 * @returns The value, or undefined when it is missing, empty or not a string
 */
function field(record: JsonRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value ? value : undefined;
}

/**
 * Reads the title, the project and the working directory of a transcript.
 *
 * The title is the latest AI title, else the first prompt, else the last prompt. The cwd is
 * the one of the project folder, where `claude --resume` finds the session, else the first.
 *
 * @param transcript - Path of the .jsonl transcript
 * @param projectDir - Encoded project folder name, the fallback for the project label
 * @returns Title, short project label and cwd; an unreadable transcript gives an empty title
 */
async function describe(
    transcript: string,
    projectDir: string,
): Promise<{ title: string; project: string; cwd?: string; startedAt?: number }> {
    let head: JsonRecord[] = [];
    let tail: JsonRecord[] = [];
    try {
        ({ head, tail } = await readEdges(transcript));
    } catch {
        head = [];
    }
    const aiTitle = (r: JsonRecord) => (r.type === "ai-title" ? field(r, "aiTitle") : undefined);
    const lastPrompt = (r: JsonRecord) =>
        r.type === "last-prompt" ? field(r, "lastPrompt") : undefined;
    const cwdOf = (r: JsonRecord) => field(r, "cwd");
    const ownCwd = (r: JsonRecord) => {
        const value = cwdOf(r);
        return value !== undefined && ownsProjectDir(value, projectDir) ? value : undefined;
    };

    const title = clean(
        find(tail, aiTitle, true) ??
            find(head, aiTitle, true) ??
            find(head, promptText) ??
            find(tail, lastPrompt, true),
    );
    const found =
        find(tail, ownCwd, true) ??
        find(head, ownCwd) ??
        find(head, cwdOf) ??
        find(tail, cwdOf, true);
    const cwd = found === undefined ? undefined : sanitize(found);
    const started = Date.parse(find(head, (r) => field(r, "timestamp")) ?? "");
    const startedAt = Number.isNaN(started) ? undefined : started;
    return { title, project: shortProject(cwd, projectDir), cwd, startedAt };
}

/**
 * Finds the sessions of `<configDir>/projects` without measuring them, which is fast.
 *
 * Only entries named after a session UUID count, so anything else in a project folder,
 * such as `memory/`, is never listed and never deleted.
 *
 * @param configDir - Claude config folder
 * @param onDenied - Called with each folder that exists but cannot be read
 * @returns Sessions sorted by project folder then id; none when the folder does not exist
 */
export async function discover(
    configDir: string,
    onDenied?: (path: string) => void,
): Promise<Entry[]> {
    const root = join(configDir, "projects");
    const denied = (path: string, error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") onDenied?.(path);
    };
    let projectDirs: string[];
    try {
        projectDirs = await readdir(root);
    } catch (error) {
        denied(root, error);
        return [];
    }
    const found: Entry[] = [];
    await Promise.all(
        projectDirs.map(async (projectDir) => {
            const dir = join(root, projectDir);
            let entries: Dirent[];
            try {
                entries = await readdir(dir, { withFileTypes: true });
            } catch (error) {
                denied(dir, error);
                return;
            }
            const ids = new Set<string>();
            for (const entry of entries) {
                const id = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -6) : entry.name;
                const kind = entry.name.endsWith(".jsonl") ? entry.isFile() : entry.isDirectory();
                if (kind && UUID.test(id)) ids.add(id);
            }
            for (const id of ids) {
                found.push({ id, configDir, projectDir, dir, ownsExtras: true });
            }
        }),
    );
    found.sort((a, b) => a.projectDir.localeCompare(b.projectDir) || a.id.localeCompare(b.id));
    const owners = new Set<string>();
    for (const entry of found) {
        entry.ownsExtras = !owners.has(entry.id);
        owners.add(entry.id);
    }
    return found;
}

/**
 * Builds the row shown for a session before it is measured.
 *
 * @param entry - Session found by discover
 * @returns A pending session with no size, no age and a project guessed from the folder name
 */
export function placeholder(entry: Entry): Session {
    return {
        id: entry.id,
        configDir: entry.configDir,
        projectDir: entry.projectDir,
        project: shortProject(undefined, entry.projectDir),
        title: "",
        bytes: 0,
        mtime: 0,
        recent: false,
        open: false,
        pending: true,
        paths: [],
        parts: [],
    };
}

/**
 * Measures one session.
 *
 * It covers the transcript, its folder (tool results, subagents, workflows) and, when
 * the entry owns them, the file history, session environment and debug log, then the
 * scratch folder of the session in its project.
 *
 * @param entry - Session found by discover
 * @param options - Reference time, recent delay and open sessions
 * @returns The measured session, or null when it vanished since discover
 */
export async function measureEntry(entry: Entry, options: ScanOptions): Promise<Session | null> {
    const { now, recentMs } = options;
    const { id, configDir, dir, projectDir } = entry;
    const transcript = join(dir, `${id}.jsonl`);
    const folder = join(dir, id);
    const own = await Promise.all([measure(transcript), measure(folder)]);
    if (!own[0] && !own[1]) return null;

    // Kept by id only, so one session owns them; the scratch folder is kept by project too
    const extras: { path: string; kind: PartKind }[] = [
        ...(entry.ownsExtras
            ? [
                  { path: join(configDir, "file-history", id), kind: "history" as const },
                  { path: join(configDir, "session-env", id), kind: "env" as const },
                  { path: join(configDir, "debug", `${id}.txt`), kind: "debug" as const },
              ]
            : []),
        ...(options.tempRoot
            ? [{ path: join(options.tempRoot, projectDir, id), kind: "scratch" as const }]
            : []),
    ];
    const extraSizes = await Promise.all(extras.map(({ path }) => measure(path)));

    const paths: string[] = [];
    const parts: Session["parts"] = [];
    let bytes = 0;
    let mtime = 0;
    const ownKinds: PartKind[] = ["transcript", "folder"];
    [transcript, folder].forEach((path, i) => {
        const size = own[i];
        if (!size) return;
        paths.push(path);
        parts.push({ kind: ownKinds[i]!, bytes: size.bytes });
        bytes += size.bytes;
        mtime = Math.max(mtime, size.mtime);
    });
    extras.forEach(({ path, kind }, i) => {
        const size = extraSizes[i];
        if (!size) return;
        paths.push(path);
        parts.push({ kind, bytes: size.bytes });
        bytes += size.bytes;
    });

    const { title, project, cwd, startedAt } = own[0]
        ? await describe(transcript, projectDir)
        : { title: "", project: shortProject(undefined, projectDir) };
    return {
        id,
        configDir,
        projectDir,
        project,
        title,
        bytes,
        mtime,
        startedAt,
        recent: now - mtime < recentMs,
        open: options.open.has(id.toLowerCase()),
        cwd,
        paths,
        parts,
    };
}

/**
 * Runs an async task over items with a concurrency limit.
 *
 * @param items - Items to process
 * @param limit - Maximum number of tasks running at once
 * @param task - Work for one item
 * @param onResult - Called as soon as each task settles, in completion order
 * @returns The results in the order of the items
 */
export async function pool<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>,
    onResult?: (result: R, item: T) => void,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            const item = items[index]!;
            const result = await task(item);
            results[index] = result;
            onResult?.(result, item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Discovers and measures every session of the given config folders.
 *
 * @param configDirs - Claude config folders, from findConfigDirs
 * @param options - Reference time, recent delay and open sessions
 * @param onDenied - Called with each folder that exists but cannot be read
 * @returns The measured sessions, those that vanished meanwhile left out
 */
export async function scan(
    configDirs: string[],
    options: ScanOptions,
    onDenied?: (path: string) => void,
): Promise<Session[]> {
    const found = await Promise.all(configDirs.map((dir) => discover(dir, onDenied)));
    const entries = found.flat();
    const sessions = await pool(entries, CONCURRENCY, (entry) => measureEntry(entry, options));
    return sessions.filter((session): session is Session => session !== null);
}
