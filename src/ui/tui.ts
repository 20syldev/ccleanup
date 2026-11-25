import type { Key } from "node:readline";

import { DEFAULT_OLDER_THAN } from "../core/args.ts";
import { openSessions } from "../core/live.ts";
import { removeSession, UnsafePathError } from "../core/remove.ts";
import { resumePlan } from "../core/resume.ts";
import {
    CONCURRENCY,
    type Entry,
    measureEntry,
    placeholder,
    pool,
    type Session,
    sessionKey,
} from "../core/scan.ts";
import {
    type Filter,
    hasFilter,
    matches,
    searchMatches,
    SORT_MODES,
    type SortMode,
    sortSessions,
} from "../core/select.ts";
import { type Messages, messages } from "../i18n/messages.ts";
import { formatSize, type Lang } from "../lib/format.ts";
import { sanitize } from "../lib/text.ts";

import { createInput, type Input } from "./input.ts";
import { type MouseEvent, rowAt, WHEEL_ROWS } from "./mouse.ts";
import { createScreen, type Screen } from "./screen.ts";
import { createTheme, darkFromEnv, probeDark, type Theme, type Tone } from "./theme.ts";
import {
    type DeletionError,
    MIN_COLS,
    MIN_ROWS,
    type RowState,
    SCAN_SETTLE_MS,
    type StatKey,
    type Stats,
    view,
    type ViewState,
} from "./view.ts";

/**
 * Inputs of the interface: `entries` come from discover and are measured while the list
 * is shown; `olderThan`, `minSize` and `includeRecent` pre-mark sessions like the
 * command line filters; `recentMs` is the delay under which a session is protected;
 * `open` resolves to the sessions running at launch, which are protected too; the list
 * does not wait for it.
 */
export interface TuiOptions {
    configDirs: string[];
    entries: Entry[];
    denied: string[];
    open: Promise<ReadonlySet<string>>;
    lang: Lang;
    version: string;
    now: number;
    recentMs: number;
    olderThan?: number;
    minSize?: number;
    includeRecent: boolean;
    mouse?: boolean;
}

/**
 * Outcome of a run, with the theme so the exit summary matches the interface. `resume` is the
 * session to run in claude once the interface is closed, when the user picked one.
 */
export interface TuiResult {
    deleted: number;
    freed: number;
    errors: DeletionError[];
    theme: Theme;
    resume?: Session;
}

/**
 * The running interface; `run` resolves when the user quits.
 */
interface App {
    run: () => Promise<TuiResult>;
}

const FRAME_MS = 80;
const FLASH_MS = 700;
const TOAST_MS = 4000;
const QUERY_MAX = 80;

// Text typed in the search: anything but control characters
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const CTRL_C_MS = 2000;
const CONFIRM_GUARD_MS = 150;

/**
 * Counts sessions and adds up their sizes.
 *
 * @param list - Sessions to count
 * @returns Number of sessions and total bytes
 */
function total(list: Session[]): { count: number; bytes: number } {
    return { count: list.length, bytes: list.reduce((sum, session) => sum + session.bytes, 0) };
}

/**
 * Computes the header statistics.
 *
 * @param sessions - Rows of the list; pending and deleted ones are left out
 * @param states - Deletion state per session key
 * @param marked - Keys of the marked sessions
 * @param ageFilter - Filter of the releasable count, the one the o key applies
 * @param freed - Bytes freed during this run
 * @returns Totals, marked, releasable and freed
 */
function computeStats(
    sessions: Session[],
    states: Map<string, RowState>,
    marked: Set<string>,
    ageFilter: Filter,
    freed: number,
): Stats {
    const alive = sessions.filter(
        (session) => !session.pending && states.get(sessionKey(session)) !== "deleted",
    );
    return {
        sessions: total(alive),
        marked: total(alive.filter((session) => marked.has(sessionKey(session)))),
        releasable: total(alive.filter((session) => matches(session, ageFilter))),
        freed,
    };
}

/**
 * Lists the statistics that changed between two frames.
 *
 * @param previous - Statistics of the previous frame
 * @param next - Statistics of this frame
 * @returns Keys of the values that changed
 */
function changedStats(previous: Stats, next: Stats): StatKey[] {
    const changed: StatKey[] = [];
    if (next.sessions.count !== previous.sessions.count) changed.push("sessions");
    if (
        next.marked.count !== previous.marked.count ||
        next.marked.bytes !== previous.marked.bytes
    ) {
        changed.push("marked");
    }
    if (next.releasable.bytes !== previous.releasable.bytes) changed.push("releasable");
    if (next.freed !== previous.freed) changed.push("freed");
    return changed;
}

/**
 * Explains why a deletion failed, in the language of the interface.
 *
 * @param error - Error thrown by removeSession
 * @param m - Texts of the interface
 * @returns The refused path for a safety refusal, else the file system message
 */
function deletionMessage(error: unknown, m: Messages): string {
    if (error instanceof UnsafePathError) return m.refusing(error.path);
    return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the interface: its state, its key handling, the live scan, the background
 * deletions and the terminal lifecycle, all kept in this closure.
 *
 * Frames are drawn on demand (a key, a resize, a measured session) and every 80 ms only
 * while something moves, so an idle list costs nothing.
 *
 * @param options - Sessions to show, language, version and filters
 * @param theme - Theme of the output
 * @param screen - Full-screen output, not entered yet
 * @returns The app; call run once
 */
function createApp(options: TuiOptions, theme: Theme, screen: Screen): App {
    const { stdin, stdout } = process;
    const m = messages(options.lang);
    const olderThan = options.olderThan ?? DEFAULT_OLDER_THAN;
    const ageFilter: Filter = { olderThan, includeRecent: options.includeRecent, now: options.now };
    const preselect: Filter = {
        olderThan: options.olderThan,
        minSize: options.minSize,
        includeRecent: options.includeRecent,
        now: options.now,
    };

    const all = new Map(options.entries.map((entry) => [sessionKey(entry), placeholder(entry)]));
    const states = new Map<string, RowState>();
    const marked = new Set<string>();
    const errors = new Map<string, DeletionError>();
    const flashes = new Map<StatKey, number>();
    const scan: ViewState["scan"] = { total: all.size, done: 0, startedAt: Date.now() };

    let sort: SortMode = "size";
    let query = "";
    let searching = false;
    let helpOpen = false;
    let helpScroll = 0;
    let detailsOpen = false;

    // Whether the last frame drew the details: a short terminal cannot
    let detailsShown = false;

    // Screen row of the first session drawn, to map a click to a session
    let rowsTop = -1;
    let reversed = false;

    // Direction of the cursor after a mark: the way the user last moved
    let step: 1 | -1 = 1;
    let sessions: Session[] = [];
    let needsResort = true;
    let cursor = 0;
    let top = 0;
    let listHeight = 10;
    let moved = false;
    let confirming = false;
    let confirmOpenedAt = 0;
    let errorsOpen = false;
    let errorsScroll = 0;
    let pasting = false;
    let toast: ViewState["toast"];
    let ctrlArmedUntil = 0;
    let stopRequested = false;
    let closed = false;
    let freed = 0;
    let deleted = 0;
    let deletion: ViewState["deletion"];
    let previousStats: Stats | undefined;
    let scanSettled = false;
    let frameTimer: NodeJS.Timeout | undefined;
    let renderQueued = false;
    let input: Input | undefined;
    let resuming: Session | undefined;
    let resolveRun: (result: TuiResult) => void = () => undefined;

    const keyOf = (session: Session) => sessionKey(session);
    const markable = (session: Session) =>
        !session.pending &&
        !session.open &&
        states.get(keyOf(session)) !== "deleted" &&
        (options.includeRecent || !session.recent);
    const tooSmall = () => {
        const { cols, rows } = screen.size();
        return cols < MIN_COLS || rows < MIN_ROWS;
    };

    const notify = (text: string, tone: Tone = "text", ms = TOAST_MS) => {
        toast = { text, tone, until: Date.now() + ms };
    };

    // Every measured session, whatever the search shows
    const measured = () => [...all.values()].filter((session) => !session.pending);

    // What a confirmed deletion would remove: every marked session, shown or not
    const deletionTargets = () =>
        sortSessions(
            measured().filter((session) => marked.has(keyOf(session)) && markable(session)),
            sort,
            reversed,
        );

    const setQuery = (next: string) => {
        query = sanitize([...next].slice(0, QUERY_MAX).join(""));
        moved = true;
        resort();
    };

    const resort = () => {
        needsResort = false;
        const current = sessions[cursor];
        const focused = current ? keyOf(current) : undefined;

        // Only measured sessions are listed: the list grows with the scan.
        const shown = measured().filter((session) => searchMatches(session, query));
        sessions = sortSessions(shown, sort, reversed);

        // Until the user moves, the cursor stays on the first row.
        if (moved && focused) {
            cursor = Math.max(
                0,
                sessions.findIndex((session) => keyOf(session) === focused),
            );
        }
        cursor = Math.min(cursor, Math.max(0, sessions.length - 1));
    };

    const animating = (clock: number) =>
        scan.endedAt === undefined ||
        clock - scan.endedAt < SCAN_SETTLE_MS ||
        deletion !== undefined ||
        (toast !== undefined && toast.until > clock) ||
        ctrlArmedUntil > clock ||
        [...flashes.values()].some((until) => until > clock);

    const render = () => {
        if (closed || !screen.active) return;
        if (needsResort) resort();
        const clock = Date.now();
        const everything = measured();
        const stats = computeStats(everything, states, marked, ageFilter, freed);
        const targets = confirming ? deletionTargets() : [];
        const shownKeys = new Set(sessions.map(keyOf));

        // Totals move during the scan: only flash changes made after it.
        if (previousStats && scanSettled) {
            for (const key of changedStats(previousStats, stats)) {
                flashes.set(key, clock + FLASH_MS);
            }
        }
        previousStats = stats;
        scanSettled = scan.endedAt !== undefined;

        const { cols, rows } = screen.size();
        const state: ViewState = {
            lang: options.lang,
            theme,
            version: options.version,
            now: options.now,
            clock,
            sessions,
            sort,
            reversed,
            step: nextStep(),
            cursor,
            top,
            marked,
            states,
            olderThan,
            markable,
            stats,
            flashes,
            scan,
            deletion,
            errors: [...errors.values()],
            errorsOpen,
            errorsScroll,
            listHeight,
            confirming,
            toast,
            query,
            searching,
            total: everything.filter((session) => states.get(keyOf(session)) !== "deleted").length,
            helpOpen,
            helpScroll,
            detailsOpen,
            detailsShown,
            rowsTop,
            targets,
            hiddenTargets: targets.filter((session) => !shownKeys.has(keyOf(session))).length,
            oldShown: sessions.some((s) => markable(s) && matches(s, ageFilter)),
            includeRecent: options.includeRecent,
        };
        screen.draw(view(state, cols, rows));
        top = state.top;
        errorsScroll = state.errorsScroll;
        helpScroll = state.helpScroll;
        listHeight = state.listHeight;
        detailsShown = state.detailsShown;
        rowsTop = state.rowsTop;

        if (animating(clock)) {
            frameTimer ??= setTimeout(() => {
                frameTimer = undefined;
                render();
            }, FRAME_MS);
        }
    };

    const requestRender = () => {
        if (renderQueued || closed) return;
        renderQueued = true;
        setImmediate(() => {
            renderQueued = false;
            render();
        });
    };

    const restore = () => {
        screen.leave();
        if (stdin.isTTY) stdin.setRawMode(false);
    };
    const exitOn = (code: number) => () => {
        restore();
        process.exit(code);
    };
    const onSigterm = exitOn(143);
    const onSighup = exitOn(129);
    const onSigint = exitOn(130);
    const onCrash = (error: unknown) => {
        restore();
        console.error(error);
        process.exit(1);
    };
    const onResize = () => {
        screen.invalidate();
        if (tooSmall()) confirming = false;
        requestRender();
    };

    const onCont = () => {
        process.on("SIGTSTP", onTstp);
        if (closed) return;
        stdin.setRawMode(true);
        screen.enter();
        render();
    };
    const onTstp = () => {
        clearTimeout(frameTimer);
        frameTimer = undefined;
        restore();
        process.removeListener("SIGTSTP", onTstp);
        process.once("SIGCONT", onCont);

        // SIGSTOP cannot be caught, so this handler cannot loop.
        process.kill(process.pid, "SIGSTOP");
    };
    const suspend = () => {
        // A real Ctrl+Z stops the whole foreground group, npx included.
        if (process.platform !== "win32") process.kill(0, "SIGTSTP");
    };

    const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(frameTimer);
        input?.close();
        stdout.removeListener("resize", onResize);
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("SIGHUP", onSighup);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTSTP", onTstp);
        process.removeListener("SIGCONT", onCont);
        process.removeListener("uncaughtException", onCrash);
        process.removeListener("unhandledRejection", onCrash);
        process.removeListener("exit", restore);
        restore();
        stdin.pause();
        resolveRun({ deleted, freed, errors: [...errors.values()], theme, resume: resuming });
    };

    const deleteMarked = async () => {
        let targets = deletionTargets();
        if (targets.length === 0) return;
        deletion = {
            total: targets.length,
            done: 0,
            bytes: total(targets).bytes,
            freed: 0,
            startedAt: Date.now(),
        };
        requestRender();

        // A session may have opened since the scan: check again.
        const open = await openSessions(options.configDirs);
        const opened = targets.filter((session) => open.has(session.id.toLowerCase()));
        for (const session of opened) {
            session.open = true;
            marked.delete(keyOf(session));
        }
        if (opened.length > 0) {
            targets = targets.filter((session) => !session.open);
            deletion.total = targets.length;
            deletion.bytes = total(targets).bytes;
        }
        let deletedNow = 0;
        let failedNow = 0;
        for (const session of targets) {
            if (stopRequested) break;
            const key = keyOf(session);
            states.set(key, "deleting");
            requestRender();
            try {
                await removeSession(session.configDir, session);
                states.set(key, "deleted");
                marked.delete(key);
                errors.delete(key);
                deletedNow++;
                deleted++;
                freed += session.bytes;
                deletion.freed += session.bytes;
            } catch (error) {
                states.set(key, "error");
                errors.set(key, { session, message: deletionMessage(error, m) });
                failedNow++;
            }
            deletion.done++;
        }
        const freedNow = deletion.freed;
        deletion = undefined;
        if (stopRequested) return finish();

        // When every target turned out open, say only that: nothing was meant to go.
        let done = m.done(deletedNow, formatSize(freedNow, options.lang));
        if (opened.length > 0 && targets.length === 0) done = m.openSkipped(opened.length);
        else if (opened.length > 0) done += ` ${m.openSkipped(opened.length)}`;
        if (failedNow > 0) notify(`${done} ${m.failed(failedNow)}`, "err", TOAST_MS * 3);
        else
            notify(done, opened.length > 0 ? "warn" : "ok", TOAST_MS * (opened.length > 0 ? 2 : 1));
        requestRender();
    };

    const move = (to: number) => {
        moved = true;
        cursor = Math.max(0, Math.min(sessions.length - 1, to));
    };

    // At either end, the nearest row is the other way: space turns back.
    const nextStep = (): 1 | -1 => {
        const next = cursor + step;
        return next < 0 || next >= sessions.length ? (step > 0 ? -1 : 1) : step;
    };

    const toggle = (session: Session | undefined) => {
        if (!session || session.pending) return;
        if (!markable(session)) {
            if (session.open) notify(m.openProtected, "warn");
            else if (session.recent) notify(m.recentProtected, "warn");
            return;
        }
        const key = keyOf(session);
        if (marked.has(key)) marked.delete(key);
        else marked.add(key);
    };

    const resumeSession = () => {
        const session = sessions[cursor];
        if (!session || session.pending || states.get(keyOf(session)) === "deleted") return;
        if (!resumePlan(session)) return notify(m.noResumeFolder, "warn");
        resuming = session;
        finish();
    };

    const purgeDeleted = () => {
        for (const [key, state] of states) {
            if (state !== "deleted") continue;
            all.delete(key);
            states.delete(key);
        }
    };

    const requestStop = () => {
        stopRequested = true;
        notify(m.stopping, "warn");
    };

    const onEdit = (name: string | undefined, text: string | undefined) => {
        if (name === "space") {
            toggle(sessions[cursor]);

            // The details follow the cursor: stay on the session being read
            if (!detailsShown) {
                step = nextStep();
                move(cursor + step);
            }
        } else if (text === "S") {
            purgeDeleted();
            reversed = !reversed;
            step = 1;
            moved = true;
            resort();
        } else if (name === "a") {
            // Any shown row marked: a unmarks the shown rows, else marks them.
            const shownMarked = sessions.filter((session) => marked.has(keyOf(session)));
            if (shownMarked.length > 0)
                for (const session of shownMarked) marked.delete(keyOf(session));
            else for (const session of sessions.filter(markable)) marked.add(keyOf(session));
        } else if (name === "o") {
            for (const session of sessions) {
                if (markable(session) && matches(session, ageFilter)) marked.add(keyOf(session));
            }
        } else if (name === "s") {
            purgeDeleted();
            sort = SORT_MODES[(SORT_MODES.indexOf(sort) + 1) % SORT_MODES.length]!;
            step = 1;
            moved = true;
            resort();
        } else if (name === "return") {
            if (deletionTargets().length === 0) {
                notify(m.nothingMarked, "muted");
            } else {
                confirming = true;
                confirmOpenedAt = Date.now();
            }
        }
    };

    const onNavigate = (name: string | undefined, text: string | undefined) => {
        const page = Math.max(1, listHeight - 1);
        let to: number;
        if (name === "up" || name === "k") to = cursor - 1;
        else if (name === "down" || name === "j") to = cursor + 1;
        else if (name === "pageup") to = cursor - page;
        else if (name === "pagedown") to = cursor + page;
        else if (name === "home" || text === "g") to = 0;
        else if (name === "end" || text === "G") to = sessions.length - 1;
        else return false;

        // Space then follows this move: down from the top, up from the bottom.
        if (name === "home" || text === "g") step = 1;
        else if (name === "end" || text === "G") step = -1;
        else step = to < cursor ? -1 : 1;
        move(to);
        return true;
    };

    const onConfirm = (name: string | undefined, text: string | undefined) => {
        // A key typed ahead must not answer the question.
        if (Date.now() - confirmOpenedAt < CONFIRM_GUARD_MS) return;
        confirming = false;
        if (name !== "escape" && text && m.confirmKeys.includes(text.toLowerCase())) {
            void deleteMarked();
        }
    };

    const onErrorsPanel = (name: string | undefined) => {
        if (name === "up" || name === "k") errorsScroll = Math.max(0, errorsScroll - 1);
        else if (name === "down" || name === "j") errorsScroll++;
        else if (name === "e" || name === "return") errorsOpen = false;
    };

    const onCtrlC = () => {
        const now = Date.now();
        if (deletion) requestStop();
        else if (ctrlArmedUntil > now) return finish();
        else {
            ctrlArmedUntil = now + CTRL_C_MS;
            notify(m.ctrlCAgain, "warn", CTRL_C_MS);
        }
        render();
    };

    // Typing the search: text goes to the query, arrows still move.
    const onSearch = (name: string | undefined, text: string | undefined, key: Key | undefined) => {
        if (name === "return" || name === "enter") searching = false;
        else if (name === "escape") {
            searching = false;
            setQuery("");
        } else if (name === "backspace") setQuery([...query].slice(0, -1).join(""));
        else if (key?.ctrl && name === "u") setQuery("");
        else if (name && ["up", "down", "pageup", "pagedown"].includes(name)) {
            onNavigate(name, undefined);
        } else if (text && !key?.ctrl && !key?.meta && PRINTABLE.test(text)) {
            setQuery(query + text);
        }
    };

    const onKey = (text: string | undefined, key: Key | undefined) => {
        const name = key?.name;
        if (name === "paste-start" || name === "paste-end") {
            pasting = name === "paste-start";
            return;
        }

        // A paste only ever lands in the search, never as keys that mark or delete.
        if (pasting) {
            if (searching && text && PRINTABLE.test(text)) setQuery(query + text);
            return requestRender();
        }
        if (key?.ctrl && name === "c") return onCtrlC();
        if (key?.ctrl && name === "z") return suspend();
        if (ctrlArmedUntil > 0) {
            ctrlArmedUntil = 0;
            toast = undefined;
        }

        if (searching) {
            onSearch(name, text, key);
            return render();
        }
        if (helpOpen) {
            if (name === "escape" || name === "q" || text === "?") helpOpen = false;
            else if (name === "up" || name === "k") helpScroll = Math.max(0, helpScroll - 1);
            else if (name === "down" || name === "j") helpScroll++;
            return render();
        }
        if (name === "q" || name === "escape") {
            if (errorsOpen || confirming) {
                errorsOpen = false;
                confirming = false;
            } else if (name === "escape" && query) {
                setQuery("");
            } else if (!deletion) {
                return finish();
            } else {
                requestStop();
            }
            return render();
        }
        if (tooSmall()) return;

        if (errorsOpen) onErrorsPanel(name);
        else if (confirming) onConfirm(name, text);
        else if (onNavigate(name, text)) moved = true;
        else if (name === "e" && errors.size > 0) {
            errorsOpen = true;
            errorsScroll = 0;
        } else if (text === "?") {
            helpOpen = true;
            helpScroll = 0;
        } else if (text === "/") searching = true;
        else if (name === "i" && !key?.ctrl) detailsOpen = !detailsOpen;
        else if (name === "c" && !key?.ctrl && detailsShown && !deletion) resumeSession();
        else if (!deletion) onEdit(name, text);
        render();
    };

    // A click selects a row, a click on the selected row marks it, a right click shows its details.
    const onMouse = (event: MouseEvent) => {
        if (pasting || helpOpen || errorsOpen || confirming || tooSmall()) return;
        if (ctrlArmedUntil > 0) {
            ctrlArmedUntil = 0;
            toast = undefined;
        }
        if (event.kind === "wheel") {
            step = event.direction;
            move(cursor + event.direction * WHEEL_ROWS);
        } else {
            const index = rowAt(event.y, rowsTop, listHeight, top, sessions.length);
            if (index === undefined) return;
            const selected = index === cursor;
            const showing = detailsShown && selected;
            if (!selected) step = index < cursor ? -1 : 1;
            move(index);

            // The details of the row, or none when they already showed it
            if (event.button === "right") detailsOpen = !showing;
            else if (selected && !deletion) toggle(sessions[index]);
        }
        render();
    };

    // Sessions open at launch, once known.
    let openAtLaunch: ReadonlySet<string> | undefined;
    const applyOpen = (session: Session) => {
        if (!openAtLaunch?.has(session.id.toLowerCase())) return;
        session.open = true;
        marked.delete(keyOf(session));
    };

    const startScan = () => {
        const scanOptions = {
            now: options.now,
            recentMs: options.recentMs,
            open: new Set<string>(),
        };
        void options.open.then((open) => {
            openAtLaunch = open;
            for (const session of all.values()) applyOpen(session);
            requestRender();
        });
        void pool(
            options.entries,
            CONCURRENCY,
            (entry) => (closed ? Promise.resolve(null) : measureEntry(entry, scanOptions)),
            (session, entry) => {
                scan.done++;
                if (closed) return;
                const key = sessionKey(entry);
                if (!session) {
                    all.delete(key);
                } else {
                    all.set(key, session);
                    applyOpen(session);
                    if (hasFilter(preselect) && matches(session, preselect)) marked.add(key);
                }
                needsResort = true;
                requestRender();
            },
        ).then(() => {
            scan.endedAt = Date.now();
            requestRender();
        });
    };

    const run = () =>
        new Promise<TuiResult>((resolve) => {
            resolveRun = resolve;
            stdin.setRawMode(true);
            input = createInput(stdin, onKey, onMouse);
            stdout.on("resize", onResize);
            process.on("SIGTERM", onSigterm);
            process.on("SIGHUP", onSighup);
            process.on("SIGINT", onSigint);
            process.on("SIGTSTP", onTstp);
            process.on("uncaughtException", onCrash);
            process.on("unhandledRejection", onCrash);
            process.on("exit", restore);
            screen.enter();
            if (options.denied.length > 0) notify(m.denied(options.denied), "err", TOAST_MS * 3);
            startScan();
            render();
        });

    return { run };
}

/**
 * Runs the interactive list until the user quits.
 *
 * The list opens at once with a row per discovered session; sizes, ages and titles fill
 * in as they are measured. Deletions run in the background, so the list stays navigable,
 * and the terminal is restored on quit, on Ctrl+Z, on a signal or on a crash.
 *
 * @param options - Sessions to show, language, version and filters
 * @returns What was deleted, what failed, and the theme in use
 */
export async function runTui(options: TuiOptions): Promise<TuiResult> {
    const { stdin, stdout } = process;

    // Ask the background color before the alternate screen.
    const dark = (await probeDark(stdin, stdout)) ?? darkFromEnv();
    const theme = createTheme(stdout, { dark });
    return createApp(options, theme, createScreen(stdout, { mouse: options.mouse })).run();
}
