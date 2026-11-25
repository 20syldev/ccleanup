import type { Session } from "../core/scan.ts";
import { messages } from "../i18n/messages.ts";
import { formatAge, formatDate, formatSize, tildify } from "../lib/format.ts";
import { cut, fit, sanitize, skip, stripAnsi, width } from "../lib/text.ts";

import { line, type Segment } from "./line.ts";
import type { Style, Theme, Tone } from "./theme.ts";
import type { ViewState } from "./view.ts";

const SPARE = 1;
const KEY_WIDTH = 15;
const CONFIRM_ROWS = 5;

/**
 * A box ready to lay over the screen: its painted lines and its width in cells.
 */
export interface Box {
    lines: string[];
    width: number;
}

/**
 * Draws a rounded box with a title in its top border.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param title - Title written in the top border
 * @param body - One list of segments per inner line
 * @param inner - Width inside the borders, padding included
 * @param tone - Color of the border and the title
 * @returns The box, its width being inner plus the two borders
 */
export function box(
    theme: Theme,
    title: string,
    body: Segment[][],
    inner: number,
    tone: Tone,
): Box {
    const { box: glyphs } = theme.glyphs;
    const border = (text: string) => theme.paint(text, { fg: tone });
    const label = cut(` ${title} `, Math.max(0, inner - 2), theme.glyphs.ellipsis);
    const rest = Math.max(0, inner - width(label) - 1);
    const top =
        border(`${glyphs.tl}${glyphs.h}`) +
        theme.paint(label, { fg: tone, bold: true }) +
        border(`${glyphs.h.repeat(rest)}${glyphs.tr}`);
    const lines = [top];
    for (const segments of body) {
        lines.push(
            `${border(glyphs.v)} ${line(theme, segments, inner - 2, {}, true)} ${border(glyphs.v)}`,
        );
    }
    lines.push(border(`${glyphs.bl}${glyphs.h.repeat(inner)}${glyphs.br}`));
    return { lines, width: inner + 2 };
}

/**
 * Lays a box over the middle of a screen area, the rest of that area dimmed behind it.
 *
 * @param theme - Theme of the output
 * @param lines - The whole frame, one string per terminal row
 * @param over - Box to lay over it
 * @param from - First row of the area, the header above it stays as it is
 * @param to - Row after the area, the status line and footer below it stay too
 * @param cols - Terminal width in cells
 * @returns A new frame
 */
export function overlay(
    theme: Theme,
    lines: string[],
    over: Box,
    from: number,
    to: number,
    cols: number,
): string[] {
    const dim: Style = { fg: "muted", dim: true };
    const behind = (text: string) => (text.trim() ? theme.paint(text, dim) : text);
    const out = lines.map((row, i) => (i >= from && i < to ? behind(stripAnsi(row)) : row));

    // A box taller than the area keeps its bottom border, so it never looks cut.
    const area = Math.max(0, to - from);
    const shown =
        over.lines.length > area && area > 1
            ? [...over.lines.slice(0, area - 1), over.lines.at(-1)!]
            : over.lines.slice(0, area);
    const y0 = from + Math.max(0, Math.floor((area - shown.length) / 2));
    const x0 = Math.max(0, Math.floor((cols - over.width) / 2));

    // A blank cell on each side keeps the dimmed rows off the border.
    const end = x0 + over.width;
    shown.forEach((boxLine, i) => {
        const plain = stripAnsi(lines[y0 + i] ?? "");
        const left = fit(cut(plain, Math.max(0, x0 - 1), ""), Math.max(0, x0 - 1));
        const right = cut(skip(plain, end + 1), Math.max(0, cols - SPARE - end - 1), "");
        const margin = (cells: number) => " ".repeat(Math.max(0, Math.min(1, cells)));
        out[y0 + i] =
            behind(left) + margin(x0) + boxLine + margin(cols - SPARE - end) + behind(right);
    });
    return out;
}

/**
 * The help panel: every key by section, then the legend of marks, tags and sizes.
 *
 * Sections go side by side when the terminal is wide enough, else one under the other,
 * cut to the height available.
 *
 * @param state - Frame state, read only
 * @param cols - Terminal width in cells
 * @param rows - Rows the box may take, borders included
 * @returns The box
 */
export function helpBox(state: ViewState, cols: number, rows: number): Box {
    const { theme, lang } = state;
    const { guide } = messages(lang);
    const sections = guide.sections.map((section) => [
        [[section.title, { fg: "accent", bold: true }]] as Segment[],
        ...section.rows.map(([key, action]): Segment[] => [
            [fit(key, KEY_WIDTH), { fg: "text", bold: true }],
            [action, { fg: "muted" }],
        ]),
    ]);
    const { glyphs } = theme;
    const legend: Segment[][] = [
        [[guide.legendTitle, { fg: "accent", bold: true }]],
        [
            [glyphs.marked, { fg: "pink", bold: true }],
            [`  ${guide.legend.marked}   `],
            [glyphs.unmarked, { fg: "muted" }],
            [`  ${guide.legend.markable}`, { fg: "muted" }],
        ],
        [
            [messages(lang).open, { fg: "accent", bold: true }],
            [`  ${guide.legend.open}`, { fg: "muted" }],
        ],
        [
            [messages(lang).recent, { fg: "ok" }],
            [
                `  ${state.includeRecent ? guide.legend.recentAllowed : guide.legend.recent}`,
                { fg: "muted" },
            ],
        ],
        [[guide.legend.sizes, { fg: "muted" }]],
    ];
    const footer: Segment[][] = [[], [[guide.close, { fg: "muted", dim: true }]]];
    const textWidth = (segments: Segment[]) => width(segments.map(([text]) => text).join(""));
    const column = Math.max(...sections.flat().map(textWidth));
    const across = Math.max(...legend.map(textWidth));
    const gap = 4;
    const twoColumns = cols - SPARE - 4 >= 2 * column + gap + 2;

    // Two columns when they fit, then the legend across.
    let body: Segment[][];
    if (twoColumns) {
        const half = Math.ceil(sections.length / 2);
        const left = sections.slice(0, half).flatMap((s, i) => (i > 0 ? [[], ...s] : s));
        const right = sections.slice(half).flatMap((s, i) => (i > 0 ? [[], ...s] : s));
        body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
            const l = left[i] ?? [];
            return [...l, [" ".repeat(column - textWidth(l) + gap)], ...(right[i] ?? [])];
        });
    } else {
        body = sections.flatMap((s, i) => (i > 0 ? [[], ...s] : s));
    }
    body = [...body, [], ...legend, ...footer];

    // Taller than the screen: the arrows scroll it.
    const room = Math.max(1, rows - 2);
    if (body.length > room) {
        const visible = Math.max(1, room - 1);
        const scroll = Math.min(state.helpScroll, Math.max(0, body.length - visible));
        state.helpScroll = scroll;
        const more = scroll + visible < body.length;
        body = [
            ...body.slice(scroll, scroll + visible),
            [[more ? theme.glyphs.ellipsis : "", { fg: "muted" }]],
        ];
    } else {
        state.helpScroll = 0;
    }

    // As wide as the content, so the list stays visible, dimmed, on both sides.
    const content = Math.max(twoColumns ? 2 * column + gap : column, across);
    const inner = Math.max(20, Math.min(cols - SPARE - 4, content + 2));
    return box(theme, guide.title, body, inner, "accent");
}

/**
 * The deletion question: how many sessions and bytes, the first ones by name, those the
 * search hides, and a reminder that it cannot be undone.
 *
 * @param state - Frame state with the targets of the deletion
 * @param cols - Terminal width in cells
 * @returns The box
 */
export function confirmBox(state: ViewState, cols: number, rows: number): Box {
    const { theme, lang, targets, hiddenTargets } = state;
    const m = messages(lang);
    const bytes = targets.reduce((sum, session) => sum + session.bytes, 0);
    const inner = Math.max(24, Math.min(cols - SPARE - 4, 72));
    const body: Segment[][] = [
        [[m.confirm(targets.length, formatSize(bytes, lang)), { fg: "warn", bold: true }]],
    ];
    if (hiddenTargets > 0) body.push([[m.confirmHidden(hiddenTargets), { fg: "muted" }]]);
    body.push([]);

    // Fixed lines: question, note, blanks, warning, keys and borders.
    const fixed = (hiddenTargets > 0 ? 7 : 6) + 2;
    const listed = Math.max(0, Math.min(CONFIRM_ROWS, rows - fixed - 1));
    const first = targets.slice(0, listed);
    const project = Math.min(24, Math.max(0, ...first.map((session) => width(session.project))));
    for (const session of first) {
        body.push([
            [fit(formatSize(session.bytes, lang), 9, "right"), { fg: "muted" }],
            ["  "],
            [fit(session.project, project, "left", theme.glyphs.ellipsis), { fg: "text" }],
            ["  "],
            [session.title || "-", { fg: "muted" }],
        ]);
    }
    if (targets.length > first.length && first.length > 0) {
        body.push([
            [" ".repeat(11)],
            [m.confirmMore(targets.length - first.length), { fg: "muted" }],
        ]);
    }
    const [yes = "y"] = m.confirmKeys;
    const keys: Segment[] = [
        [yes, { fg: "warn", bold: true }],
        [` ${m.keys.yes}    `, { fg: "muted" }],
        [`${m.keyNames.no}, ${m.keyNames.esc}`, { fg: "accent", bold: true }],
        [` ${m.keys.no}`, { fg: "muted" }],
    ];
    body.push([], [[m.confirmFinal(targets.length), { fg: "muted" }]], []);

    // Too short: drop the blank lines first, never the keys or the hidden note.
    let fitted = body;
    if (fitted.length + 3 > rows) fitted = body.filter((segments) => segments.length > 0);
    const room = Math.max(1, rows - 3);
    if (room < 2 && hiddenTargets > 0) {
        fitted = [[...fitted[0]!, [`  ${m.confirmHidden(hiddenTargets)}`, { fg: "muted" }]]];
    }
    fitted = [...fitted.slice(0, room), keys];
    return box(theme, m.confirmTitle, fitted, inner, "warn");
}

/**
 * Text of one line of the details: a muted label, then the value.
 *
 * @param label - Name of the field
 * @param value - Segments of the value
 * @returns The segments of the line
 */
function field(label: string, value: Segment[]): Segment[] {
    return [[fit(label, 10), { fg: "muted" }], ...value];
}

/**
 * State of a session in words, the strongest first.
 *
 * @param state - Frame state, for the marks
 * @param session - Session under the cursor
 * @param key - Its sessionKey
 * @returns The word and its color
 */
function stateOf(state: ViewState, session: Session, key: string): Segment {
    const { states } = messages(state.lang).details;
    if (session.open) return [states.open, { fg: "accent", bold: true }];
    if (state.marked.has(key)) return [states.marked, { fg: "pink", bold: true }];
    if (session.recent) return [states.recent, { fg: "ok" }];
    return [states.idle, { fg: "muted" }];
}

/**
 * Details of the session under the cursor: full title, folder, id, config folder, dates,
 * sizes by part, state and the command that resumes it.
 *
 * @param state - Frame state, read only
 * @param session - Session under the cursor
 * @param key - Its sessionKey
 * @param cols - Terminal width in cells
 * @returns The lines of the panel, DETAILS_ROWS of them
 */
export function detailsBox(
    state: ViewState,
    session: Session,
    key: string,
    cols: number,
): string[] {
    const { theme, lang, now } = state;
    const m = messages(lang).details;
    const dot: Segment = ["  /  ", { fg: "muted", dim: true }];
    const parts = session.parts
        .filter((part) => part.bytes > 0)
        .flatMap((part, i): Segment[] => [
            ...(i > 0 ? [[", ", { fg: "muted" }] as Segment] : []),
            [`${m.parts[part.kind]} `, { fg: "muted" }],
            [formatSize(part.bytes, lang), { fg: "text" }],
        ]);
    const dates: Segment[] = [];
    if (session.startedAt)
        dates.push([formatDate(session.startedAt, lang), { fg: "text" }], dot, [
            `${m.modified} `,
            { fg: "muted" },
        ]);
    dates.push(
        [formatDate(session.mtime, lang), { fg: "text" }],
        [` (${formatAge(now - session.mtime, lang)})`, { fg: "muted" }],
    );
    const command: Segment = [`claude --resume ${session.id}`, { fg: "accent" }];
    const hint: Segment[] = [
        ["  c ", { fg: "text", bold: true, dim: true }],
        [m.launch, { fg: "muted", dim: true }],
    ];

    // The hint is shown whole or not at all: the row is 4 cells of box and 10 of label
    const room = Math.max(20, cols - SPARE - 4) - 2 - 10;
    const hintFits = width(command[0]) + hint.reduce((sum, [text]) => sum + width(text), 0) <= room;
    const body: Segment[][] = [
        [[session.title || "-", { fg: "text", bold: true }]],
        field(m.folder, [
            [session.cwd ? tildify(session.cwd) : session.project, { fg: "text" }],
            dot,
            [`${m.config} `, { fg: "muted" }],
            [sanitize(tildify(session.configDir)), { fg: "text" }],
        ]),
        field(m.resume, [command, ...(hintFits ? hint : [])]),
        field(session.startedAt ? m.started : m.modified, dates),
        field(m.size, [
            [formatSize(session.bytes, lang), { fg: "text", bold: true }],
            ...(parts.length > 0 ? [[" ("] as Segment, ...parts, [")"] as Segment] : []),
        ]),
        field(m.state, [stateOf(state, session, key)]),
    ];
    return box(theme, m.title, body, Math.max(20, cols - SPARE - 4), "muted").lines.map(
        (row) => ` ${row}`,
    );
}

export const DETAILS_ROWS = 8;
