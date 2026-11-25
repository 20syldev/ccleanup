import { type Session, sessionKey } from "../core/scan.ts";
import type { SortMode } from "../core/select.ts";
import { type KeyLabel, type KeyName, messages } from "../i18n/messages.ts";
import { DAY, formatAge, formatDuration, formatSize, GB, type Lang, MB } from "../lib/format.ts";
import { cut, fit, skip, width } from "../lib/text.ts";

import { line, type Segment, selectionStyle } from "./line.ts";
import { logo, LOGO_WIDTH, wordmark } from "./logo.ts";
import { confirmBox, DETAILS_ROWS, detailsBox, helpBox, overlay } from "./panels.ts";
import { tooSmallView } from "./small.ts";
import { mix, type Style, type Theme, type Tone } from "./theme.ts";

/**
 * Deletion state of a row, absent while the session is untouched.
 */
export type RowState = "deleting" | "deleted" | "error";

/**
 * Header statistics that flash when they change.
 */
export type StatKey = "sessions" | "marked" | "releasable" | "freed";

/**
 * Header statistics: counts with their bytes, and the bytes freed during this run.
 */
export interface Stats {
    sessions: { count: number; bytes: number };
    marked: { count: number; bytes: number };
    releasable: { count: number; bytes: number };
    freed: number;
}

/**
 * A failed deletion and the reason the file system gave.
 */
export interface DeletionError {
    session: Session;
    message: string;
}

/**
 * Everything a frame shows; `marked` and `states` are keyed by sessionKey. `now` is the
 * time of the scan, for ages; `clock` the
 * current time, for animations; `deletion` is set while a deletion runs, with its
 * progress in sessions and bytes. `sessions` are the rows shown, after the search
 * `query`, out of `total` measured ones; `searching` is set while the query is typed.
 * `targets` are the sessions a confirmed deletion would remove, `hiddenTargets` of them
 * out of the search. `view` writes back three layout values: `top`, the first visible
 * row; `errorsScroll` and `helpScroll`, clamped to their panels; `listHeight`, the rows
 * of the list, which sets the page size of PgUp and PgDn.
 */
export interface ViewState {
    lang: Lang;
    theme: Theme;
    version: string;
    now: number;
    clock: number;
    sessions: Session[];
    sort: SortMode;
    reversed: boolean;
    step: 1 | -1;
    cursor: number;
    top: number;
    marked: Set<string>;
    states: Map<string, RowState>;
    olderThan: number;
    markable: (session: Session) => boolean;
    stats: Stats;
    flashes: Map<StatKey, number>;
    scan: { total: number; done: number; startedAt: number; endedAt?: number };
    deletion?: { total: number; done: number; bytes: number; freed: number; startedAt: number };
    errors: DeletionError[];
    errorsOpen: boolean;
    errorsScroll: number;
    listHeight: number;
    confirming: boolean;
    toast?: { text: string; tone: Tone; until: number };
    query: string;
    searching: boolean;
    total: number;
    helpOpen: boolean;
    helpScroll: number;
    detailsOpen: boolean;
    targets: Session[];
    hiddenTargets: number;
    oldShown: boolean;
    includeRecent: boolean;
}

/**
 * What a row needs besides the session: theme, language, scan time, age threshold and
 * clock for the spinner.
 */
type RowContext = Pick<ViewState, "theme" | "lang" | "now" | "olderThan" | "clock">;

/**
 * Display options of one row. `prefix` adds the cursor and mark columns of the
 * interactive list; the others describe the state of the session in that list.
 */
interface RowOptions {
    prefix?: boolean;
    selected?: boolean;
    marked?: boolean;
    markable?: boolean;
    rowState?: RowState;
}

const UPDATE_COMMAND = "npm i -g ccleanup@latest";
const INDENT = 10;
const SIZE_WIDTH = 9;
const AGE_WIDTH = 5;
const PREFIX_WIDTH = 4;
const SPARE = 1;
const STATS_WIDTH = 50;
const FULL_ROWS = 18;
const SCAN_FOLD_AT = 2000;
const SCAN_FOLD_MS = 400;
const FIREFLY_CELLS = 8;
const FIREFLY_TRAIL = 60;
const FIREFLY_TRAIL_MS = 500;

// Top speed of the firefly across, in braille dots per millisecond
const FIREFLY_SPEED = 0.02;
const EMBER_SPAWN_MS = 110;
const EMBER_LIFE_MS = 1300;
const BRAILLE = 0x2800;

// Braille dot bits, top to bottom, for the left and right columns
const BRAILLE_DOTS: [number, number][] = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
];

export const SCAN_SETTLE_MS = SCAN_FOLD_AT + SCAN_FOLD_MS;

export const MIN_COLS = 40;
export const MIN_ROWS = 8;

/**
 * Color of a size: the bigger, the louder.
 *
 * @param bytes - Size of the session
 * @returns Muted under 10 MB, plain under 100 MB, warning under 1 GB, error above
 */
function sizeTone(bytes: number): Tone {
    if (bytes >= GB) return "err";
    if (bytes >= 100 * MB) return "warn";
    if (bytes < 10 * MB) return "muted";
    return "text";
}

/**
 * Ease-in-out curve for the progress bar motion.
 *
 * @param t - Progress, clamped to 0..1
 * @returns The eased progress, 0..1
 */
function easeInOut(t: number): number {
    const x = Math.min(1, Math.max(0, t));
    return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

/**
 * Two-tone progress bar.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param fraction - Filled part, clamped to 0..1
 * @param cells - Width of the bar
 * @param tone - Color of the filled part; the rest is a dim track
 * @returns The bar segments
 */
function bar(theme: Theme, fraction: number, cells: number, tone: Tone): Segment[] {
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells);
    return [
        [theme.glyphs.bar.repeat(filled), { fg: tone }],
        [theme.glyphs.track.repeat(cells - filled), { fg: "muted", dim: true }],
    ];
}

/**
 * Color between two tokens.
 *
 * @param theme - Theme of the output: an exact mix from 256 colors up, the nearer token below
 * @param from - Token at ratio 0
 * @param to - Token at ratio 1
 * @param ratio - Position between the two, 0 to 1
 * @returns The style of that color
 */
function tint(theme: Theme, from: Tone, to: Tone, ratio: number): Style {
    if (theme.depth >= 8) return { rgb: mix(theme.rgb(from), theme.rgb(to), ratio) };
    return { fg: ratio < 0.5 ? from : to };
}

/**
 * Progress bar of the scan: an accent to pink filled part crossed by a slow wave of light.
 *
 * @param theme - Theme of the output; below 256 colors the filled part takes the accent
 * @param fraction - Filled part, clamped to 0..1
 * @param cells - Width of the bar
 * @param clock - Current time, which moves the wave
 * @returns The bar segments
 */
function shimmer(theme: Theme, fraction: number, cells: number, clock: number): Segment[] {
    if (theme.depth < 8) return bar(theme, fraction, cells, "accent");
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells);
    const accent = theme.rgb("accent");
    const pink = theme.rgb("pink");
    const glow = theme.rgb("glow");
    const segments: Segment[] = [];
    for (let i = 0; i < filled; i++) {
        const wave = (Math.sin(i / 2.5 - clock / 140) + 1) / 2;
        const base = mix(accent, pink, i / Math.max(1, cells - 1));
        segments.push([theme.glyphs.bar, { rgb: mix(base, glow, wave * 0.7) }]);
    }
    segments.push([theme.glyphs.track.repeat(cells - filled), { fg: "muted", dim: true }]);
    return segments;
}

/**
 * Firefly of the scan line: a light wandering over a few braille cells, its trail cooling
 * from glow to ember, like the embers that rise under the list.
 *
 * Its path mixes two slow waves, across and up and down the four dot rows, and the trail
 * is the same path a little earlier, so the frame depends only on the clock. Without
 * Unicode it falls back to the ASCII spinner.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param clock - Current time
 * @returns FIREFLY_CELLS cells
 */
function firefly(theme: Theme, clock: number): Segment[] {
    if (!theme.unicode) {
        return [
            [spinner(theme, clock), { fg: "accent", bold: true }],
            [" ".repeat(FIREFLY_CELLS - 1)],
        ];
    }
    const span = FIREFLY_CELLS * 2 - 1;
    const pace = (2 * FIREFLY_SPEED) / span;
    const dots = Array<number>(FIREFLY_CELLS).fill(0);
    const heat = Array<number>(FIREFLY_CELLS).fill(0);
    for (let k = 0; k < FIREFLY_TRAIL; k++) {
        const t = clock - (k * FIREFLY_TRAIL_MS) / FIREFLY_TRAIL;
        const x = Math.round(((Math.sin(t * pace) + 1) / 2) * span);
        const y = Math.min(3, Math.floor(((Math.sin(t / 430 + 1) + 1) / 2) * 4));
        const cell = Math.floor(x / 2);
        dots[cell] = dots[cell]! | BRAILLE_DOTS[y]![x % 2]!;
        heat[cell] = Math.max(heat[cell]!, 1 - k / FIREFLY_TRAIL);
    }
    return dots.map((bits, i): Segment =>
        bits === 0
            ? [" "]
            : [String.fromCodePoint(BRAILLE + bits), tint(theme, "ember", "glow", heat[i]!)],
    );
}

/**
 * Mixes the bits of an integer, for the placement of the embers.
 *
 * @param n - Integer to hash; only its low 32 bits count
 * @returns An unsigned 32-bit hash
 */
function hash(n: number): number {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * Tells whether the embers show: during the scan, then while the last ones rise.
 *
 * @param state - Frame state, read only
 * @returns False on terminals without color or Unicode
 */
function embersActive(state: ViewState): boolean {
    const { theme, scan, clock } = state;
    if (!theme.enabled || !theme.unicode || theme.depth < 4) return false;
    return scan.endedAt === undefined || clock - scan.endedAt < EMBER_LIFE_MS;
}

/**
 * Embers rising under the last row of the list, drawn with braille dots; the list grows
 * as sessions are measured, so they follow the newest rows down.
 *
 * One ember is born every EMBER_SPAWN_MS at a column taken from the hash of its birth
 * tick, then climbs the four dot rows and cools down: the frame depends only on the clock,
 * so the view stays a pure function of its state.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns The painted line, aligned with the data columns
 */
function emberLine(state: ViewState, cols: number): string {
    const { theme, clock, scan } = state;
    const cells = cols - SPARE - PREFIX_WIDTH;
    if (cells <= 0) return "";
    const dots = Array<number>(cells).fill(0);
    const heat = Array<number>(cells).fill(0);
    const first = Math.ceil(Math.max(clock - EMBER_LIFE_MS, scan.startedAt) / EMBER_SPAWN_MS);
    const last = Math.floor(Math.min(clock, scan.endedAt ?? clock) / EMBER_SPAWN_MS);
    for (let tick = first; tick <= last; tick++) {
        const age = clock - tick * EMBER_SPAWN_MS;
        if (age < 0 || age >= EMBER_LIFE_MS) continue;
        const h = hash(tick);
        const cell = h % cells;
        const height = 1 - age / EMBER_LIFE_MS;
        const row = Math.min(3, Math.floor(height * 4));
        dots[cell] = dots[cell]! | BRAILLE_DOTS[row]![(h >>> 16) & 1]!;
        heat[cell] = Math.max(heat[cell]!, height);
    }
    const segments: Segment[] = [[" ".repeat(PREFIX_WIDTH)]];
    dots.forEach((bits, i) => {
        if (bits === 0) segments.push([" "]);
        else
            segments.push([
                String.fromCodePoint(BRAILLE + bits),
                tint(theme, "ember", "glow", heat[i]!),
            ]);
    });
    return line(theme, segments, cols - SPARE);
}

/**
 * Current frame of the spinner.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param clock - Current time; one frame every 80 ms
 * @returns One glyph
 */
function spinner(theme: Theme, clock: number): string {
    const frames = theme.glyphs.spinner;
    return frames[Math.floor(clock / 80) % frames.length]!;
}

/**
 * Width of the project column, fitted to the data.
 *
 * @param sessions - Sessions shown
 * @param cols - Terminal width in cells
 * @returns The longest project label, between 8 cells and a quarter of the width (24 at most)
 */
function projectWidth(sessions: Session[], cols: number): number {
    const longest = sessions.reduce((max, session) => Math.max(max, width(session.project)), 0);
    return Math.max(8, Math.min(24, longest, Math.floor(cols / 4)));
}

/**
 * Width left for the title column.
 *
 * @param cols - Terminal width in cells
 * @param project - Width of the project column
 * @param prefix - Width of the cursor and mark columns, 0 for the plain table
 * @returns At least 8 cells
 */
function titleWidth(cols: number, project: number, prefix: number): number {
    return Math.max(8, cols - SPARE - prefix - SIZE_WIDTH - AGE_WIDTH - project - 3);
}

/**
 * Column headers, the active sort highlighted with its direction, and the position of
 * the cursor on the right.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @param project - Width of the project column
 * @returns The painted header line
 */
function columnHeader(state: ViewState, cols: number, project: number): string {
    const { theme, lang, sort, reversed, sessions, cursor } = state;
    const columns = messages(lang).columns;
    const direction = (mode: SortMode) =>
        (mode === "project") !== reversed ? theme.glyphs.sortUp : theme.glyphs.sortDown;
    const label = (text: string, mode: SortMode) =>
        sort === mode ? `${text} ${direction(mode)}` : text;
    const style = (mode: SortMode): Style =>
        sort === mode ? { fg: "accent", bold: true } : { fg: "muted" };
    const position = sessions.length > 0 ? `${cursor + 1}/${sessions.length}` : "";
    const title = titleWidth(cols, project, PREFIX_WIDTH) - width(position) - 1;
    return line(
        theme,
        [
            [" ".repeat(PREFIX_WIDTH)],
            [fit(label(columns.size, "size"), SIZE_WIDTH, "right"), style("size")],
            [" "],
            [fit(label(columns.age, "age"), AGE_WIDTH, "right"), style("age")],
            [" "],
            [
                fit(label(columns.project, "project"), project, "left", theme.glyphs.ellipsis),
                style("project"),
            ],
            [" "],
            [fit(columns.title, Math.max(0, title)), { fg: "muted" }],
            [" "],
            [position, { fg: "muted" }],
        ],
        cols - SPARE,
    );
}

/**
 * Mark column of a row: the deletion state first, else a dot when marked, else nothing.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param session - Session of the row
 * @param options - State of the row in the list
 * @param clock - Current time, for the spinner
 * @returns The mark segment, one cell wide
 */
function markSegment(theme: Theme, session: Session, options: RowOptions, clock: number): Segment {
    const { glyphs } = theme;
    if (session.pending) return [" "];
    if (options.rowState === "deleting") return [spinner(theme, clock), { fg: "warn", bold: true }];
    if (options.rowState === "deleted") return [glyphs.ok, { fg: "ok", bold: true }];
    if (options.rowState === "error") return [glyphs.err, { fg: "err", bold: true }];
    if (options.marked) return [glyphs.marked, { fg: "pink", bold: true }];
    if (options.markable) return [glyphs.unmarked, { fg: "muted", dim: true }];
    return [" "];
}

/**
 * Tag that flags a protected session: a colored word, or a soft pill when it must stand
 * out a little more, both quiet enough not to pull the eye away from the sizes.
 *
 * @param theme - Theme of the output; the pill needs 256 colors, else it stays a word
 * @param label - Text of the tag
 * @param tone - Color of the word, and tint of the pill
 * @param pill - Lay the word on a background lightly tinted with its color
 * @returns The tag segment; between brackets when the output is not a terminal
 */
function badgeSegment(theme: Theme, label: string, tone: Tone, pill = false): Segment {
    if (!theme.enabled) return [`[${label}]`];
    if (pill && theme.depth >= 8) {
        const tint = mix(theme.rgb("paper"), theme.rgb(tone), theme.dark ? 0.22 : 0.16);
        return [` ${label} `, { fg: tone, bgRgb: tint }];
    }
    return [label, { fg: tone, dim: theme.depth < 4 }];
}

/**
 * Tag of a session, if it has one: an open session, never deleted, gets the pill; a
 * recent one, protected only by default, the plain word.
 *
 * @param theme - Theme of the output
 * @param lang - Language of the label
 * @param session - Measured session
 * @returns The open tag, else the recent tag, else undefined
 */
function sessionBadge(theme: Theme, lang: Lang, session: Session): Segment | undefined {
    if (session.open) return badgeSegment(theme, messages(lang).open, "accent", true);
    if (session.recent) return badgeSegment(theme, messages(lang).recent, "ok");
    return undefined;
}

/**
 * Size, age, project and title of a measured session.
 *
 * @param context - Theme, language, scan time and age threshold
 * @param session - Measured session
 * @param room - Width left for the tag and the title
 * @param project - Width of the project column
 * @param options - State of the row in the list
 * @returns The data segments of the row
 */
function dataSegments(
    context: RowContext,
    session: Session,
    room: number,
    project: number,
    options: RowOptions,
): Segment[] {
    const { theme, lang, now, olderThan } = context;
    const deleted = options.rowState === "deleted";
    const gone: Style = { fg: "muted", strike: true };
    const age = now - session.mtime;
    const ageTone: Tone = age < DAY ? "muted" : age >= olderThan ? "warn" : "text";
    const badge = sessionBadge(theme, lang, session);
    const tagWidth = badge ? width(badge[0]) + 1 : 0;
    const titleTone: Tone = options.rowState === "error" ? "err" : badge ? "muted" : "text";

    const segments: Segment[] = [
        [
            fit(formatSize(session.bytes, lang), SIZE_WIDTH, "right"),
            deleted ? gone : { fg: sizeTone(session.bytes) },
        ],
        [" "],
        [fit(formatAge(age, lang), AGE_WIDTH, "right"), deleted ? gone : { fg: ageTone }],
        [" "],
        [
            fit(session.project, project, "left", theme.glyphs.ellipsis),
            deleted ? gone : { fg: "text" },
        ],
        [" "],
    ];
    if (badge) segments.push(deleted ? [badge[0], gone] : badge, [" "]);
    segments.push([
        cut(session.title || "-", Math.max(1, room - tagWidth), theme.glyphs.ellipsis),
        deleted ? gone : { fg: titleTone, bold: options.marked },
    ]);
    return segments;
}

/**
 * One session row, in the interactive list or in the plain table.
 *
 * @param context - Theme, language, scan time, age threshold and clock
 * @param session - Session of the row; a pending one shows dots until it is measured
 * @param cols - Terminal width in cells
 * @param project - Width of the project column
 * @param options - Cursor, mark and deletion state of the row
 * @returns The painted row, a full-width bar when selected
 */
function sessionRow(
    context: RowContext,
    session: Session,
    cols: number,
    project: number,
    options: RowOptions = {},
): string {
    const { theme, clock } = context;
    const prefix = options.prefix ? PREFIX_WIDTH : 0;
    const segments: Segment[] = [];

    if (options.prefix) {
        segments.push(
            [options.selected ? theme.glyphs.cursor : " ", { fg: "accent", bold: true }],
            [" "],
            markSegment(theme, session, options, clock),
            [" "],
        );
    }
    const room = titleWidth(cols, project, prefix);
    segments.push(...dataSegments(context, session, room, project, options));
    const base = options.selected ? selectionStyle(theme) : {};
    return line(theme, segments, cols - SPARE, base, options.selected);
}

/**
 * The four statistics shown right of the logo.
 *
 * @param state - Frame state, read only
 * @returns One list of segments per line; a changed value flashes for a moment
 */
function statLines(state: ViewState): Segment[][] {
    const { lang, stats, flashes, clock, olderThan } = state;
    const m = messages(lang);
    const size = (bytes: number) => formatSize(bytes, lang);
    const labelWidth = Math.max(...Object.values(m.stats).map((label) => width(label))) + 2;
    const countWidth = String(stats.sessions.count).length;
    const flashing = (key: StatKey) => (flashes.get(key) ?? 0) > clock;

    const entry = (key: StatKey, value: string, tone: Tone, extra: Segment[] = []) => {
        const lit = flashing(key);
        const segments: Segment[] = [
            [fit(m.stats[key], labelWidth), { fg: "muted" }],
            [
                value,
                {
                    fg: lit ? (key === "freed" ? "ok" : "warn") : tone,
                    bold: lit || key === "freed",
                },
            ],
            ...extra,
        ];
        return segments;
    };
    const pair = (count: number, bytes: number) =>
        `${String(count).padStart(countWidth)}  ${size(bytes)}`;
    const days = Math.round(olderThan / DAY);

    return [
        entry("sessions", pair(stats.sessions.count, stats.sessions.bytes), "text"),
        entry(
            "marked",
            pair(stats.marked.count, stats.marked.bytes),
            stats.marked.count > 0 ? "pink" : "muted",
        ),
        entry(
            "releasable",
            pair(stats.releasable.count, stats.releasable.bytes),
            stats.releasable.count > 0 ? "warn" : "muted",
            [[`  ${m.olderTag(days)}`, { fg: "muted", dim: true }]],
        ),
        entry("freed", size(stats.freed), stats.freed > 0 ? "ok" : "muted"),
    ];
}

/**
 * Large header: block logo with the version below, statistics on the right.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns Four lines
 */
function fullHeader(state: ViewState, cols: number): string[] {
    const { theme, lang, version } = state;
    const subtitle = `v${version}  ${messages(lang).subtitle}`;
    const left = [...logo(theme), theme.paint(subtitle, { fg: "muted" })];
    const stats = statLines(state);
    const gap = 6;
    const leftWidth = Math.max(LOGO_WIDTH, width(subtitle));
    const room = Math.max(0, cols - SPARE - leftWidth - gap - 1);
    return left.map((text, i) => {
        const pad = " ".repeat(Math.max(0, leftWidth - width(text)) + gap);
        return ` ${text}${pad}${line(theme, stats[i] ?? [], room)}`;
    });
}

/**
 * Header for a terminal too narrow to put the statistics beside the logo: the logo, the
 * version, then the statistics on one line.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns Five lines
 */
function stackedHeader(state: ViewState, cols: number): string[] {
    const { theme, lang, version } = state;
    const subtitle = theme.paint(`v${version}  ${messages(lang).subtitle}`, { fg: "muted" });
    return [
        ...logo(theme).map((row) => ` ${row}`),
        ` ${subtitle}`,
        ...compactHeader(state, cols, false),
    ];
}

/**
 * One-line header for small terminals.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @param named - Start with the name and the version; off under the logo, which shows them
 * @returns One line: name, version, totals, marked and freed space
 */
function compactHeader(state: ViewState, cols: number, named = true): string[] {
    const { theme, lang, stats, version } = state;
    const m = messages(lang);
    const size = (bytes: number) => formatSize(bytes, lang);
    const sep: Segment = ["  /  ", { fg: "muted", dim: true }];
    const head = named ? `${wordmark(theme)} ${theme.paint(`v${version}`, { fg: "muted" })}` : "";
    const rest = line(
        theme,
        [
            named ? sep : [""],
            [`${m.stats.sessions} ${stats.sessions.count}, ${size(stats.sessions.bytes)}`],
            sep,
            [
                `${m.stats.marked} ${stats.marked.count}, ${size(stats.marked.bytes)}`,
                { fg: stats.marked.count > 0 ? "pink" : "muted" },
            ],
            sep,
            [
                `${m.stats.freed} ${size(stats.freed)}`,
                { fg: stats.freed > 0 ? "ok" : "muted", bold: stats.freed > 0 },
            ],
        ],
        Math.max(0, cols - SPARE - width(head) - 1),
    );
    return [` ${head}${rest}`];
}

/**
 * Activity of a running deletion: spinner, counter, bar in bytes and elapsed time.
 *
 * @param state - Frame state with a deletion running
 * @param cells - Width of the bar
 * @returns The segments of the activity line
 */
function deletionActivity(state: ViewState, cells: number): Segment[] {
    const { theme, lang, clock } = state;
    const deletion = state.deletion!;
    const elapsed = formatDuration(clock - deletion.startedAt, lang);
    const amounts = `${formatSize(deletion.freed, lang)} / ${formatSize(deletion.bytes, lang)}`;
    return [
        [spinner(theme, clock), { fg: "warn", bold: true }],
        [` ${messages(lang).deleting(deletion.done, deletion.total)}  `, { fg: "text" }],
        ...bar(theme, deletion.bytes > 0 ? deletion.freed / deletion.bytes : 1, cells, "warn"),
        [`  ${amounts}, ${elapsed}`, { fg: "muted" }],
    ];
}

/**
 * Activity of the scan: the firefly, counter and a shimmering bar that opens with an
 * ease-in-out; once done, a check mark, then the bar folds toward its center after two
 * seconds.
 *
 * @param state - Frame state, read only
 * @param cells - Width of the bar
 * @returns The segments of the activity line
 */
function scanActivity(state: ViewState, cells: number): Segment[] {
    const { theme, lang, clock, scan } = state;
    const m = messages(lang);
    if (scan.endedAt === undefined) {
        const opening = Math.max(1, Math.round(cells * easeInOut((clock - scan.startedAt) / 300)));
        return [
            ...firefly(theme, clock),
            [`  ${m.scanning(scan.done, scan.total)}  `, { fg: "text" }],
            ...shimmer(theme, scan.total > 0 ? scan.done / scan.total : 1, opening, clock),
            [`  ${formatDuration(clock - scan.startedAt, lang)}`, { fg: "muted" }],
        ];
    }
    const since = clock - scan.endedAt;
    const fresh = since < SCAN_SETTLE_MS;
    const text = m.scanDone(scan.total, formatDuration(scan.endedAt - scan.startedAt, lang));
    const segments: Segment[] = [
        [theme.glyphs.ok, { fg: "ok", bold: fresh }],
        [` ${text}`, { fg: fresh ? "ok" : "muted" }],
    ];
    if (fresh) {
        const fold =
            since < SCAN_FOLD_AT ? 1 : 1 - easeInOut((since - SCAN_FOLD_AT) / SCAN_FOLD_MS);
        const shown = Math.round(cells * fold);
        const side = Math.floor((cells - shown) / 2);
        segments.push([`  ${" ".repeat(side)}`], [theme.glyphs.bar.repeat(shown), { fg: "ok" }]);
    }
    return segments;
}

/**
 * Line between the header and the list: deletion or scan progress, and the error count.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns The painted line
 */
function activityLine(state: ViewState, cols: number): string {
    const { theme, lang, errors } = state;
    const cells = Math.max(6, Math.min(30, Math.floor(cols / 4)));
    const segments: Segment[] = [
        [" "],
        ...(state.deletion ? deletionActivity(state, cells) : scanActivity(state, cells)),
    ];
    if (errors.length > 0) {
        segments.push(
            ["   "],
            [
                `${theme.glyphs.err} ${messages(lang).errorsHint(errors.length)}`,
                { fg: "err", bold: true },
            ],
            [", e", { fg: "muted" }],
        );
    }
    return line(theme, segments, cols - SPARE);
}

/**
 * Line above the footer: the deletion question, or the latest toast while it lasts.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns The painted line, empty when there is nothing to say
 */
function statusLine(state: ViewState, cols: number): string {
    const { theme, lang, toast, clock, query, searching, sessions, total, states } = state;
    const m = messages(lang);

    // Deleted rows stay struck through until the next sort: skip them.
    const shown = sessions.filter((session) => states.get(sessionKey(session)) !== "deleted");
    const count: Segment = [`   ${m.search.count(shown.length, total)}`, { fg: "muted" }];
    if (searching) {
        // While typing, the query end and caret always show.
        const fixed = width(" / ") + width(theme.glyphs.caret);
        const withCount = cols - SPARE - fixed - width(count[0]) >= 12;
        const room = cols - SPARE - fixed - (withCount ? width(count[0]) : 0);
        const typed =
            width(query) > room
                ? theme.glyphs.ellipsis +
                  skip(query, width(query) - room + width(theme.glyphs.ellipsis))
                : query;
        return line(
            theme,
            [
                [" /", { fg: "accent", bold: true }],
                [` ${typed}`, { fg: "text", bold: true }],
                [theme.glyphs.caret, { fg: "accent" }],
                ...(withCount ? [count] : []),
            ],
            cols - SPARE,
        );
    }
    if (toast && toast.until > clock) {
        return line(theme, [[" "], [toast.text, { fg: toast.tone, bold: true }]], cols - SPARE);
    }
    if (query) {
        return line(
            theme,
            [
                [" /", { fg: "accent", bold: true }],
                [` ${query}`, { fg: "text" }],
                count,

                // Esc closes a panel first: show the hint only when it clears.
                ...(state.confirming || state.helpOpen || state.errorsOpen
                    ? []
                    : [[`   ${m.search.clearHint}`, { fg: "muted", dim: true }] as Segment]),
            ],
            cols - SPARE,
        );
    }
    return "";
}

// Footer keys per context; when narrow, the lowest priorities go first
const KEYS: Record<
    "errors" | "confirm" | "deleting" | "help" | "search" | "main",
    [string, KeyLabel, number][]
> = {
    help: [
        ["arrows", "scroll", 1],
        ["esc", "close", 9],
    ],
    search: [
        ["enter", "keep", 6],
        ["esc", "clear", 5],
        ["arrows", "move", 3],
    ],
    errors: [
        ["arrows", "scroll", 1],
        ["esc", "close", 9],
    ],
    confirm: [
        ["yes", "yes", 2],
        ["no", "no", 9],
    ],
    deleting: [
        ["arrows", "move", 1],
        ["q", "stop", 9],
    ],
    main: [
        ["arrows", "move", 3],
        ["space", "mark", 5],
        ["a", "all", 1],
        ["a", "none", 1],
        ["o", "old", 2],
        ["sort", "sort", 2],
        ["/", "search", 4],
        ["i", "details", 3],
        ["enter", "delete", 6],
        ["e", "errors", 4],
        ["esc", "clear", 8],
        ["?", "help", 7],
        ["q", "quit", 9],
    ],
};

/**
 * Keys that work in the current context; an action with nothing to act on is left out.
 *
 * @param state - Frame state, read only
 * @returns Key, action and priority triples, in display order
 */
function contextKeys(state: ViewState): [string, KeyLabel, number][] {
    if (state.helpOpen) return KEYS.help;
    if (state.searching) return KEYS.search;
    if (state.errorsOpen) return KEYS.errors;
    if (state.confirming) return KEYS.confirm;
    if (state.deletion) return KEYS.deleting;
    const { stats, errors, sessions, marked } = state;

    // a and o act on the rows shown, so a search narrows them too.
    const shownMarked = sessions.some((session) => marked.has(sessionKey(session)));
    const available: Partial<Record<KeyLabel, boolean>> = {
        mark: sessions.length > 0,
        all: sessions.length > 0 && !shownMarked,
        none: shownMarked,
        old: state.oldShown,
        details: sessions.length > 0,
        delete: stats.marked.count > 0,
        errors: errors.length > 0,
        clear: state.query !== "",
    };
    return KEYS.main.filter(([, label]) => available[label] ?? true);
}

/**
 * Footer listing the keys of the current context; when the terminal is narrow, the gaps
 * tighten first, then the least useful keys drop out.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @returns The painted footer
 */
function footer(state: ViewState, cols: number): string {
    const { theme, lang } = state;
    const m = messages(lang);
    let gap = 3;
    const step = state.step > 0 ? theme.glyphs.sortDown : theme.glyphs.sortUp;
    let items = contextKeys(state).map(([key, label, priority]) => {
        const name = key in m.keyNames ? m.keyNames[key as KeyName] : key;
        const text = label === "mark" ? `${m.keys.mark} ${step}` : m.keys[label];
        return { name, label: text, priority };
    });
    const total = () =>
        items.reduce((sum, item) => sum + width(`${item.name} ${item.label}`) + gap, -gap);
    const room = cols - SPARE - 1;
    if (total() > room) gap = 2;
    while (items.length > 1 && total() > room) {
        const lowest = Math.min(...items.map((item) => item.priority));
        const index = items.findIndex((item) => item.priority === lowest);
        items = items.filter((_, i) => i !== index);
    }
    const segments: Segment[] = [[" "]];
    items.forEach((item, i) => {
        if (i > 0) segments.push([" ".repeat(gap)]);
        segments.push(
            [item.name, { fg: "accent", bold: true }],
            [` ${item.label}`, { fg: "muted" }],
        );
    });
    return line(theme, segments, cols - SPARE);
}

/**
 * Panel listing the failed deletions with their reason, in place of the list.
 *
 * @param state - Frame state with errors; its errorsScroll is clamped in place
 * @param cols - Terminal width in cells
 * @param height - Rows available, borders included
 * @returns The panel lines
 */
function errorsPanel(state: ViewState, cols: number, height: number): string[] {
    const { theme, lang, errors, errorsScroll } = state;
    const { box } = theme.glyphs;
    const border = (text: string) => theme.paint(text, { fg: "err" });
    const inner = Math.max(10, cols - SPARE - 4);
    const title = ` ${messages(lang).errorsTitle(errors.length)} `;
    const lines = [
        ` ${border(`${box.tl}${box.h}${title}${box.h.repeat(Math.max(0, inner - width(title) - 1))}${box.tr}`)}`,
    ];
    const body: Segment[][] = errors.flatMap(({ session, message }) => [
        [
            [`${theme.glyphs.err} `, { fg: "err", bold: true }],
            [`${session.project}, ${session.title || session.id}`, { fg: "text" }],
        ],
        [["  "], [message, { fg: "muted" }]],
    ]);
    const visible = Math.max(0, height - 2);
    const scroll = Math.min(errorsScroll, Math.max(0, body.length - visible));
    state.errorsScroll = scroll;
    for (const segments of body.slice(scroll, scroll + visible)) {
        lines.push(
            ` ${border(box.v)} ${line(theme, segments, inner - 2, {}, true)} ${border(box.v)}`,
        );
    }
    while (lines.length < height - 1)
        lines.push(` ${border(box.v)}${" ".repeat(inner)}${border(box.v)}`);
    lines.push(` ${border(`${box.bl}${box.h.repeat(inner)}${box.br}`)}`);
    return lines;
}

/**
 * Builds a whole frame, keeping the cursor visible and the error panel in range.
 *
 * @param state - Frame state; top, errorsScroll and listHeight are written back
 * @param cols - Terminal width in cells
 * @param rows - Terminal height; under 40 x 8 the frame asks for a bigger terminal
 * @returns One string per terminal row
 */
export function view(state: ViewState, cols: number, rows: number): string[] {
    const { theme, lang } = state;
    if (cols < MIN_COLS || rows < MIN_ROWS)
        return tooSmallView(theme, lang, cols, rows, { cols: MIN_COLS, rows: MIN_ROWS });

    // The compact header gives the details the logo's rows.
    const roomy = rows >= FULL_ROWS + (state.detailsOpen ? DETAILS_ROWS : 0) && theme.unicode;
    let header = compactHeader(state, cols);
    if (roomy && cols >= LOGO_WIDTH + STATS_WIDTH) header = fullHeader(state, cols);
    else if (roomy && cols >= LOGO_WIDTH + 2) header = stackedHeader(state, cols);
    const lines = [...header];
    lines.push(activityLine(state, cols));
    const listTop = lines.length;
    let height = Math.max(1, rows - lines.length - 3);

    // The details take the bottom of the list area.
    const current = state.sessions[state.cursor];
    let details: string[] = [];
    if (state.detailsOpen && current && !state.errorsOpen && height - DETAILS_ROWS >= 3) {
        details = detailsBox(state, current, sessionKey(current), cols);
        height -= details.length;
    }

    if (state.errorsOpen) {
        lines.push(...errorsPanel(state, cols, height + 1));
    } else if (state.sessions.length === 0 && state.query) {
        lines.push(columnHeader(state, cols, projectWidth(state.sessions, cols)));
        const text = cut(
            messages(lang).search.none(state.query),
            cols - SPARE - 2,
            theme.glyphs.ellipsis,
        );
        lines.push("", `  ${theme.paint(text, { fg: "muted" })}`);
    } else {
        const project = projectWidth(state.sessions, cols);

        // The embers take one row, kept free so the cursor never hides behind them.
        const embers = embersActive(state) && height >= 3;
        const shown = embers ? height - 1 : height;
        let top = state.top;
        if (state.cursor < top) top = state.cursor;
        if (state.cursor >= top + shown) top = state.cursor - shown + 1;
        state.top = Math.max(0, Math.min(top, Math.max(0, state.sessions.length - shown)));

        // Embers rise under the last row, or at the bottom of a long list.
        const withEmbers = embers;
        const frontier = Math.min(state.sessions.length - state.top, shown);
        if (!withEmbers) {
            state.top = Math.max(0, Math.min(state.top, state.sessions.length - height));
        }

        state.listHeight = withEmbers ? shown : height;
        lines.push(columnHeader(state, cols, project));
        const rows = state.sessions
            .slice(state.top, state.top + (withEmbers ? shown : height))
            .map((session, i) =>
                sessionRow(state, session, cols, project, {
                    prefix: true,
                    selected: state.top + i === state.cursor,
                    marked: state.marked.has(sessionKey(session)),
                    markable: state.markable(session),
                    rowState: state.states.get(sessionKey(session)),
                }),
            );
        if (withEmbers) rows.splice(frontier, 0, emberLine(state, cols));
        lines.push(...rows);
    }
    while (lines.length < rows - 2 - details.length) lines.push("");
    lines.push(...details);
    lines.push(statusLine(state, cols), footer(state, cols));

    // Modal panels sit over the dimmed list.
    const listEnd = rows - 2;
    if (state.helpOpen) {
        return overlay(
            theme,
            lines,
            helpBox(state, cols, listEnd - listTop),
            listTop,
            listEnd,
            cols,
        );
    }
    if (state.confirming) {
        const box = confirmBox(state, cols, listEnd - listTop);
        return overlay(theme, lines, box, listTop, listEnd, cols);
    }
    return lines;
}

/**
 * The plain table of `--list`, `--dry-run` and `--yes`.
 *
 * @param sessions - Sessions to print, in the order given
 * @param theme - Theme of the output; plain text when it is not a terminal
 * @param lang - Language of the headers and units
 * @param now - Time of the scan, for ages
 * @param cols - Width of the output
 * @returns The header, one line per session, a blank line and the total
 */
export function table(
    sessions: Session[],
    theme: Theme,
    lang: Lang,
    now: number,
    cols: number,
): string[] {
    const m = messages(lang);
    const project = projectWidth(sessions, cols);
    const context: RowContext = { theme, lang, now, olderThan: Infinity, clock: 0 };
    const head = line(
        theme,
        [
            [fit(m.columns.size, SIZE_WIDTH, "right"), { fg: "muted" }],
            [" "],
            [fit(m.columns.age, AGE_WIDTH, "right"), { fg: "muted" }],
            [" "],
            [fit(m.columns.project, project, "left", theme.glyphs.ellipsis), { fg: "muted" }],
            [" "],
            [m.columns.title, { fg: "muted" }],
        ],
        cols - SPARE,
    );
    const rows = sessions.map((session) => sessionRow(context, session, cols, project));
    const total = sessions.reduce((sum, session) => sum + session.bytes, 0);
    return [head, ...rows, "", m.totalLine(sessions.length, formatSize(total, lang))];
}

/**
 * Summary printed once the interface is closed.
 *
 * @param result - Deleted sessions, freed bytes and failures of the run
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param lang - Language of the texts
 * @param update - Newer version, running one and terminal width, when an update is available
 * @returns The lines to print; the tone of the second line grows with the freed space
 */
export function exitSummary(
    result: { deleted: number; freed: number; errors: DeletionError[] },
    theme: Theme,
    lang: Lang,
    update?: { latest: string; current: string; cols: number },
): string[] {
    const m = messages(lang);
    const lines: string[] = [];
    if (result.deleted === 0) {
        lines.push(`${wordmark(theme)}  ${theme.paint(m.exitNothing, { fg: "muted" })}`);
    } else {
        const tone = result.freed >= GB ? 2 : result.freed >= 100 * MB ? 1 : 0;
        const freed = m.exitFreed(formatSize(result.freed, lang), result.deleted);
        lines.push(
            `${wordmark(theme)}  ${theme.paint(freed, { fg: "ok", bold: true })}`,
            `${" ".repeat(10)}${theme.paint(m.exitTones[tone], { fg: "muted" })}`,
        );
    }
    if (result.errors.length > 0) {
        lines.push(
            "",
            theme.paint(m.exitFailures(result.errors.length), { fg: "err", bold: true }),
        );
        for (const { session, message } of result.errors) {
            lines.push(
                `  ${theme.paint(theme.glyphs.err, { fg: "err" })} ${session.id} ${session.title}`,
            );
            lines.push(`    ${theme.paint(message, { fg: "muted" })}`);
        }
    }
    if (update) {
        const sentence = m.updateAvailable(update.latest, update.current);
        const text = theme.paint(sentence, { fg: "muted" });
        const command = theme.paint(UPDATE_COMMAND, { fg: "accent" });

        // Under the wordmark text, or against the edge when even the sentence would not fit
        const indent = " ".repeat(INDENT + width(sentence) <= update.cols ? INDENT : 0);
        const fits = indent.length + width(sentence) + 1 + UPDATE_COMMAND.length <= update.cols;

        // After a gap when failures were listed; the command drops a line when it would wrap
        if (result.errors.length > 0) lines.push("");
        if (fits) lines.push(`${indent}${text} ${command}`);
        else lines.push(`${indent}${text}`, `${indent}${command}`);
    }
    return lines;
}
