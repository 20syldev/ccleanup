import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Session, sessionKey } from "../src/core/scan.ts";
import { matches, searchMatches } from "../src/core/select.ts";
import { DAY, HOUR, MB } from "../src/lib/format.ts";
import { ESC, width } from "../src/lib/text.ts";
import { logo, LOGO_WIDTH } from "../src/ui/logo.ts";
import { createTheme, type Rgb, type Theme } from "../src/ui/theme.ts";
import { SCAN_SETTLE_MS, view, type ViewState } from "../src/ui/view.ts";

const ROOT = join(import.meta.dirname, "..");
const COLS = 100;
const ROWS = 23;
const CELL_W = 8.4;
const CELL_H = 19;
const FONT_SIZE = 14;
const PAD = 18;

// Same pace as the redraws of the app
const FRAME_MS = 80;

// Width in columns of the pieces an animation stores once
const BAND = 20;

// Shadow of the light logo: a brown that reads as beige on white, as a dim brown on black
const LIGHT_SHADOW = "#783c28";
const LIGHT_SHADOW_OPACITY = 0.26;

const NOW = Date.UTC(2026, 10, 24, 17, 30);
const HOME = "/home/you";
const OLDER_THAN = 14 * DAY;

const cp = (code: number) => String.fromCodePoint(code);
const UPPER = cp(0x2580);
const LOWER = cp(0x2584);
const FULL = cp(0x2588);
const HEAVY = cp(0x2501);
const CARET = cp(0x258f);
const LIGHT_H = cp(0x2500);
const LIGHT_V = cp(0x2502);
const CORNERS = [0x256d, 0x256e, 0x2570, 0x256f].map(cp);
const BRAILLE = 0x2800;

/**
 * Style of one terminal cell, as the escape codes left it.
 */
interface Pen {
    fg?: Rgb;
    bg?: Rgb;
    bold: boolean;
    dim: boolean;
    strike: boolean;
    inverse: boolean;
}

/**
 * One drawn cell: its character, how many columns it takes, and its style.
 */
interface Cell {
    char: string;
    span: number;
    pen: Pen;
}

// Made-up sessions: size in MB, age in hours, project, title, flags
const FIXTURE: [number, number, string, string, ("open" | "recent")?][] = [
    [2150, 26 * 24, "acme/web-shop", "Refactor the checkout flow"],
    [1340, 2, "acme/api", "Debug the memory leak in the workers", "open"],
    [905, 0.4, "side/pixel-game", "Pixel editor with undo and layers", "recent"],
    [640, 41 * 24, "work/infra", "Terraform modules for the staging cluster"],
    [312, 19 * 24, "acme/api", "Rate limiter for the public endpoints"],
    [188, 6 * 24, "notes/blog", "Write the launch post"],
    [96, 33 * 24, "acme/web-shop", "Dark mode for the dashboard"],
    [61, 3 * 24, "tools/dotfiles", "Zsh prompt that shows the Git state"],
    [42, 52 * 24, "acme/api", "Migrate the API to Fastify"],
    [27, 9 * 24, "side/pixel-game", "Export the sprites as a sheet"],
    [14, 27 * 24, "work/infra", "Rotate the TLS certificates"],
    [8, 12, "tools/dotfiles", "Clean up the home folder"],
    [3, 64 * 24, "notes/blog", "Fix the RSS feed dates"],
];

/**
 * Builds the made-up sessions, with parts that add up to their size.
 *
 * @returns The sessions, biggest first
 */
function sessions(): Session[] {
    return FIXTURE.map(([mb, hours, project, title, flag], i) => {
        const bytes = Math.round(mb * MB);
        const id = `${(i + 1).toString(16).padStart(8, "0")}-4c1e-4a7f-9b2d-5e8f3a6c${(i + 10).toString(16).padStart(4, "0")}`;
        return {
            id,
            configDir: `${HOME}/.claude`,
            projectDir: `-home-you-code-${project.replace("/", "-")}`,
            project,
            title,
            bytes,
            mtime: NOW - hours * HOUR,
            startedAt: NOW - hours * HOUR - 3 * HOUR,
            recent: flag === "recent",
            open: flag === "open",
            cwd: `${HOME}/code/${project}`,
            paths: [],
            parts: [
                { kind: "transcript", bytes: Math.round(bytes * 0.71) },
                { kind: "folder", bytes: Math.round(bytes * 0.24) },
                {
                    kind: "history",
                    bytes: bytes - Math.round(bytes * 0.71) - Math.round(bytes * 0.24),
                },
            ],
        };
    });
}

const ALL = sessions();

// The big old sessions are marked, the way o would mark them
const MARKED = new Set([0, 3, 8].map((i) => sessionKey(ALL[i]!)));

/**
 * A theme as a true color terminal would get it.
 *
 * @param dark - Dark or light background
 * @returns The theme
 */
function theme(dark: boolean): Theme {
    const stream = { isTTY: true, getColorDepth: () => 24 } as unknown as NodeJS.WriteStream;
    return createTheme(stream, { dark, env: { LANG: "en_US.UTF-8", TERM: "xterm-256color" } });
}

/**
 * The state of one frame, with the parts a scene changes.
 *
 * @param dark - Dark or light background
 * @param scene - Fields that differ from a settled list
 * @returns The full view state
 */
function state(dark: boolean, scene: Partial<ViewState> = {}): ViewState {
    const list = scene.sessions ?? sessions();
    const marked = scene.marked ?? MARKED;
    const markable = (session: Session) => !session.open && !session.recent;

    // Like the app, the header counts every measured session
    const measured = scene.scan && scene.scan.endedAt === undefined ? list : ALL;
    const alive = measured.filter(markable);
    const total = (items: Session[]) => ({
        count: items.length,
        bytes: items.reduce((sum, session) => sum + session.bytes, 0),
    });
    const filter = { olderThan: OLDER_THAN, includeRecent: false, now: NOW };
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
    return {
        lang: "en",
        theme: theme(dark),
        version,
        now: NOW,
        clock: NOW + 60_000,
        sessions: list,
        sort: "size",
        reversed: false,
        step: 1,
        cursor: 1,
        top: 0,
        marked,
        states: new Map(),
        olderThan: OLDER_THAN,
        markable,
        stats: {
            sessions: total(measured),
            marked: total(measured.filter((session) => marked.has(sessionKey(session)))),
            releasable: total(alive.filter((session) => matches(session, filter))),
            freed: 0,
        },
        flashes: new Map(),
        scan: { total: list.length, done: list.length, startedAt: NOW, endedAt: NOW + 1200 },
        errors: [],
        errorsOpen: false,
        errorsScroll: 0,
        listHeight: 10,
        confirming: false,
        query: "",
        searching: false,
        total: list.length,
        helpOpen: false,
        helpScroll: 0,
        detailsOpen: false,
        targets: [],
        hiddenTargets: 0,
        oldShown: true,
        includeRecent: false,
        ...scene,
    };
}

/**
 * Applies the codes of one SGR escape sequence to a pen.
 *
 * @param pen - Current style, changed in place
 * @param params - Numbers between the brackets, such as "1;38;2;255;0;0"
 */
function applySgr(pen: Pen, params: string): void {
    const codes = (params || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0)
            Object.assign(pen, {
                fg: undefined,
                bg: undefined,
                bold: false,
                dim: false,
                strike: false,
                inverse: false,
            });
        else if (code === 1) pen.bold = true;
        else if (code === 2) pen.dim = true;
        else if (code === 7) pen.inverse = true;
        else if (code === 9) pen.strike = true;
        else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
            const rgb = codes.slice(i + 2, i + 5) as Rgb;
            if (code === 38) pen.fg = rgb;
            else pen.bg = rgb;
            i += 4;
        }
    }
}

/**
 * Splits a painted line into cells.
 *
 * @param text - One line of the frame, with escape codes
 * @returns Its cells, in order
 */
function cells(text: string): Cell[] {
    const out: Cell[] = [];
    const pen: Pen = { bold: false, dim: false, strike: false, inverse: false };
    const sgr = new RegExp(String.raw`^${ESC}\[([\d;]*)m`);
    let rest = text;
    while (rest.length > 0) {
        const match = sgr.exec(rest);
        if (match) {
            applySgr(pen, match[1]!);
            rest = rest.slice(match[0].length);
            continue;
        }
        const char = String.fromCodePoint(rest.codePointAt(0)!);
        rest = rest.slice(char.length);
        out.push({ char, span: Math.max(1, width(char)), pen: { ...pen } });
    }
    return out;
}

/**
 * Writes a color for SVG.
 *
 * @param rgb - Red, green and blue
 * @returns Such as "#ff8040"
 */
function hex(rgb: Rgb): string {
    return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Escapes text for an SVG text node.
 *
 * @param text - Raw text
 * @returns The text with &, < and > escaped
 */
function escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Draws a block, line, corner or braille character as shapes, so it looks the same in
 * any font; other characters are left to the text.
 *
 * @param char - Character of the cell
 * @param x - Left of the cell
 * @param y - Top of the cell
 * @param color - Foreground color
 * @returns SVG elements, or undefined for a plain character
 */
function shape(char: string, x: number, y: number, color: string): string | undefined {
    const w = CELL_W;
    const h = CELL_H;
    const code = char.codePointAt(0)!;
    const line = (d: string) => `<path d="${d}" stroke="${color}" stroke-width="1.2" fill="none"/>`;
    if (char === UPPER)
        return `<rect x="${x}" y="${y}" width="${w}" height="${h / 2}" fill="${color}"/>`;
    if (char === LOWER)
        return `<rect x="${x}" y="${y + h / 2}" width="${w}" height="${h / 2}" fill="${color}"/>`;
    if (char === FULL)
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
    if (char === HEAVY)
        return `<rect x="${x}" y="${y + h / 2 - 1.5}" width="${w}" height="3" fill="${color}"/>`;
    if (char === CARET)
        return `<rect x="${x}" y="${y + 2}" width="1.6" height="${h - 4}" fill="${color}"/>`;
    const cx = x + w / 2;
    const cy = y + h / 2;
    if (char === LIGHT_H) return line(`M${x} ${cy}H${x + w}`);
    if (char === LIGHT_V) return line(`M${cx} ${y}V${y + h}`);
    const r = w / 2;
    if (char === CORNERS[0])
        return line(`M${x + w} ${cy}H${cx + r}A${r} ${r} 0 0 0 ${cx} ${cy + r}V${y + h}`);
    if (char === CORNERS[1])
        return line(`M${x} ${cy}H${cx - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}V${y + h}`);
    if (char === CORNERS[2])
        return line(`M${x + w} ${cy}H${cx + r}A${r} ${r} 0 0 1 ${cx} ${cy - r}V${y}`);
    if (char === CORNERS[3])
        return line(`M${x} ${cy}H${cx - r}A${r} ${r} 0 0 0 ${cx} ${cy - r}V${y}`);
    if (code > BRAILLE && code <= BRAILLE + 0xff) {
        const bits = code - BRAILLE;
        const dots = [
            [0x01, 0, 0],
            [0x02, 0, 1],
            [0x04, 0, 2],
            [0x40, 0, 3],
            [0x08, 1, 0],
            [0x10, 1, 1],
            [0x20, 1, 2],
            [0x80, 1, 3],
        ];
        return dots
            .filter(([bit]) => bits & bit!)
            .map(
                ([, col, row]) =>
                    `<circle cx="${x + w * (0.3 + col! * 0.4)}" cy="${y + h * (0.17 + row! * 0.22)}" r="1.3" fill="${color}"/>`,
            )
            .join("");
    }
    return undefined;
}

/**
 * Draws painted rows as SVG elements, inside an optional window of columns.
 *
 * @param lines - Rows to draw, one painted string each
 * @param paint - Theme of the frame, for the default colors
 * @param fromCol - First column drawn; the ones before are dropped
 * @param cols - Number of columns drawn
 * @param firstRow - Row of the picture where the first line goes
 * @returns The SVG elements
 */
function draw(lines: string[], paint: Theme, fromCol = 0, cols = COLS, firstRow = 0): string {
    const background = hex(paint.rgb("paper"));
    const text = hex(paint.rgb("text"));
    const parts: string[] = [];
    lines.forEach((row, r) => {
        const y = PAD + (firstRow + r) * CELL_H;
        let col = -fromCol;
        let run: { x: number; cells: number; text: string; key: string; attrs: string } | undefined;
        const flush = () => {
            if (run && run.text.trim()) {
                parts.push(
                    `<text x="${run.x}" y="${y + CELL_H * 0.74}" textLength="${run.cells * CELL_W}" lengthAdjust="spacingAndGlyphs"${run.attrs}>${escapeXml(run.text)}</text>`,
                );
            }
            run = undefined;
        };
        for (const cell of cells(row)) {
            if (col < 0 || col + cell.span > cols) {
                flush();
                col += cell.span;
                continue;
            }
            const x = PAD + col * CELL_W;
            let fg = cell.pen.fg ? hex(cell.pen.fg) : text;
            let bg = cell.pen.bg ? hex(cell.pen.bg) : undefined;
            if (cell.pen.inverse) [fg, bg] = [bg ?? background, fg];
            if (bg)
                parts.push(
                    `<rect x="${x}" y="${y}" width="${cell.span * CELL_W + 0.4}" height="${CELL_H}" fill="${bg}"/>`,
                );

            // Spaces only move the column, so no viewer can collapse them
            if (cell.char === " ") {
                flush();
                col += cell.span;
                continue;
            }
            const drawn = shape(cell.char, x, y, fg);
            const opacity = cell.pen.dim ? ' fill-opacity="0.6"' : "";
            if (drawn) {
                flush();
                parts.push(cell.pen.dim ? `<g opacity="0.6">${drawn}</g>` : drawn);
            } else {
                const weight = cell.pen.bold ? ' font-weight="bold"' : "";
                const strike = cell.pen.strike ? ' text-decoration="line-through"' : "";
                const attrs = ` fill="${fg}"${weight}${opacity}${strike}`;
                if (!run || run.key !== attrs) {
                    flush();
                    run = { x, cells: 0, text: "", key: attrs, attrs };
                }
                run.text += cell.char;
                run.cells += cell.span;
            }
            col += cell.span;
        }
        flush();
    });
    return parts.join("\n");
}

/**
 * Wraps drawn elements in an SVG picture of a terminal window.
 *
 * @param picture - Size of the window in cells, and what it shows
 * @param picture.rows - Height in rows
 * @param picture.cols - Width in columns
 * @param picture.label - Text for screen readers
 * @param picture.inner - SVG elements, from draw or animate
 * @param paint - Theme of the frame, for the background
 * @returns The SVG document
 */
function svg(
    picture: { rows: number; cols: number; label: string; inner: string },
    paint: Theme,
): string {
    const outW = Math.round(picture.cols * CELL_W + PAD * 2);
    const outH = Math.round(picture.rows * CELL_H + PAD * 2);
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outW} ${outH}" width="${outW}" height="${outH}" role="img" aria-label="${escapeXml(picture.label)}">`,
        `<rect width="${outW}" height="${outH}" rx="10" fill="${hex(paint.rgb("paper"))}"/>`,
        `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}" xml:space="preserve">`,
        picture.inner,
        "</g>",
        "</svg>",
        "",
    ].join("\n");
}

/**
 * Plays frames in a loop with CSS animations. Each row is cut in bands of columns, on
 * columns blank in every frame so no word is split, and a band that stays the same over
 * several frames is drawn once and shown for that stretch only, which keeps the file small.
 *
 * @param frames - Rows of each frame and how long it stays, in ms
 * @param paint - Theme of the frames, for the default colors
 * @returns The SVG elements, with their style sheet
 */
function animate(frames: { lines: string[]; ms: number }[], paint: Theme): string {
    const totalMs = frames.reduce((sum, frame) => sum + frame.ms, 0);
    const starts: number[] = [];
    frames.reduce((at, frame) => {
        starts.push(at);
        return at + frame.ms;
    }, 0);
    const percent = (ms: number) => Number(((ms / totalMs) * 100).toFixed(3));
    const classes = new Map<string, string>();
    const styles: string[] = [];
    const groups: string[] = [];

    // Shows elements from frame i to frame j, one class per stretch
    const show = (elements: string, i: number, j: number) => {
        if (i === 0 && j === frames.length) return elements;
        const from = percent(starts[i]!);
        const to = j === frames.length ? 100 : percent(starts[j]!);
        const key = `${from}-${to}`;
        let name = classes.get(key);
        if (!name) {
            name = `f${classes.size}`;
            classes.set(key, name);
            const shown = from === 0 ? "0%{opacity:1}" : `0%{opacity:0}${from}%{opacity:1}`;
            const hidden = to === 100 ? "" : `${to}%{opacity:0}`;
            styles.push(
                `@keyframes ${name}{${shown}${hidden}}`,
                `.${name}{opacity:0;animation:${name} ${totalMs}ms step-end infinite}`,
            );
        }
        return `<g class="${name}">${elements}</g>`;
    };
    const rows = Math.max(...frames.map((frame) => frame.lines.length));
    for (let r = 0; r < rows; r++) {
        const blank = Array.from({ length: COLS }, () => true);
        for (const frame of frames) {
            let col = 0;
            for (const cell of cells(frame.lines[r] ?? "")) {
                for (let c = col; c < col + cell.span && c < COLS; c++)
                    blank[c] &&= cell.char === " ";
                col += cell.span;
            }
        }
        const cuts = [0];
        for (let at = BAND; at < COLS; at += BAND) {
            const near = [...Array(BAND / 2).keys()]
                .flatMap((d) => [at + d, at - d])
                .find((c) => c > cuts.at(-1)! && c < COLS && blank[c]);
            if (near !== undefined && !cuts.includes(near)) cuts.push(near);
        }
        cuts.push(COLS);
        for (let k = 0; k + 1 < cuts.length; k++) {
            const left = cuts[k]!;
            const cols = cuts[k + 1]! - left;
            const bands = frames.map((frame) => draw([frame.lines[r] ?? ""], paint, left, cols, r));
            const moved = (drawn: string) =>
                left === 0 ? drawn : `<g transform="translate(${left * CELL_W} 0)">${drawn}</g>`;
            let i = 0;
            while (i < frames.length) {
                const drawn = bands[i]!;
                let j = i + 1;
                while (j < frames.length && bands[j] === drawn) j++;
                if (drawn) groups.push(show(moved(drawn), i, j));
                i = j;
            }
        }
    }
    return [`<style>${styles.join("")}</style>`, ...groups].join("\n");
}

/**
 * Writes one picture to assets/.
 *
 * @param name - File name, without the extension
 * @param picture - The SVG document
 */
function save(name: string, picture: string): void {
    writeFileSync(join(ROOT, "assets", `${name}.svg`), picture);
    console.log(`assets/${name}.svg ${Math.round(picture.length / 1024)} kB`);
}

/**
 * Removes the escape codes of a painted row.
 *
 * @param line - Painted row
 * @returns Its plain text
 */
function plain(line: string): string {
    return line.replace(new RegExp(String.raw`${ESC}\[[\d;]*m`, "g"), "");
}

/**
 * Finds the first rounded box of a frame.
 *
 * @param lines - The frame
 * @returns Its first and last rows, and its first and last columns
 */
function boxOf(lines: string[]): { top: number; bottom: number; left: number; right: number } {
    const top = lines.findIndex((line) => plain(line).includes(CORNERS[0]!));
    const bottom = lines.findIndex((line, i) => i > top && plain(line).includes(CORNERS[2]!));
    const row = [...plain(lines[top]!)];
    return { top, bottom, left: row.indexOf(CORNERS[0]!), right: row.indexOf(CORNERS[1]!) };
}

/**
 * Renders the animation of the README: the scan fills the list at the pace of the app,
 * then three sessions are marked, a search narrows the list, the details of a session
 * open, and the confirmation box asks. The keys are slowed down to be followed.
 *
 * @param dark - Dark or light background
 */
function hero(dark: boolean): void {
    const scenes: [Partial<ViewState>, number][] = [];
    const settle = (scene: Partial<ViewState>, ms: number) => {
        scenes.push([{ clock, scan: { ...scan, endedAt }, ...scene }, ms]);
    };
    const scan = { total: ALL.length, done: 0, startedAt: NOW };
    let clock = NOW + 200;
    for (let k = 0, done = 1; done < ALL.length; k++, done = 1 + Math.floor(k * 0.75)) {
        scenes.push([
            {
                sessions: ALL.slice(0, done),
                marked: new Set(),
                cursor: 0,
                clock,
                scan: { ...scan, done },
            },
            FRAME_MS,
        ]);
        clock += FRAME_MS;
    }
    const endedAt = clock;
    scan.done = ALL.length;

    // Check mark, last embers, then the bar folds, at the app's pace
    for (; clock < endedAt + SCAN_SETTLE_MS; clock += FRAME_MS)
        settle({ marked: new Set(), cursor: 0 }, FRAME_MS);

    // Arrows down to each old session, space marks it and moves on
    const marked = new Set<string>();
    let cursor = 0;
    for (const target of [0, 3, 8]) {
        while (cursor < target) settle({ marked: new Set(marked), cursor: ++cursor }, 130);
        settle({ marked: new Set(marked), cursor }, 300);
        marked.add(sessionKey(ALL[target]!));
        settle({ marked: new Set(marked), cursor: ++cursor }, 450);
    }

    // Like the app, the cursor follows its session through the search
    let list = ALL;
    const follow = (next: Session[]) => {
        const focused = list[cursor];
        cursor = Math.max(0, next.indexOf(focused!));
        list = next;
        return { sessions: list, cursor };
    };
    const found = (query: string) => ALL.filter((session) => searchMatches(session, query));
    const query = "acme";
    for (let k = 0; k <= query.length; k++) {
        const typed = query.slice(0, k);
        settle(
            { ...follow(found(typed)), query: typed, searching: true },
            k === query.length ? 700 : 220,
        );
    }
    while (cursor < 2) settle({ sessions: list, query, cursor: ++cursor }, 300);
    settle({ sessions: list, query, cursor, detailsOpen: true }, 2600);
    settle({ sessions: list, query, cursor }, 300);
    settle(follow(ALL), 700);
    settle({ cursor, confirming: true, targets }, 3200);
    let paint = theme(dark);
    const frames = scenes.map(([scene, ms]) => {
        const frame = state(dark, { total: ALL.length, ...scene });

        // Like the app, space turns back at the end of the list
        if (frame.cursor + 1 >= frame.sessions.length) frame.step = -1;
        paint = frame.theme;
        return { lines: view(frame, COLS, ROWS), ms };
    });
    const label =
        "ccleanup: the scan fills the list, three sessions are marked, a search, the details of a session, then the confirmation box";
    save(
        `hero-${dark ? "dark" : "light"}`,
        svg({ rows: ROWS, cols: COLS, label, inner: animate(frames, paint) }, paint),
    );
}

/**
 * Renders a still part of one scene.
 *
 * @param name - File name, without the extension
 * @param label - Text for screen readers
 * @param scene - Fields that differ from a settled list
 * @param crop - Picks the rows, and the columns if given, from the frame
 * @param rows - Height of the frame before cropping
 */
function still(
    name: string,
    label: string,
    scene: Partial<ViewState>,
    crop: (lines: string[]) => { from: number; to: number; left?: number; right?: number },
    rows = ROWS,
): void {
    const frame = state(true, scene);
    const lines = view(frame, COLS, rows);
    const { from, to, left = 0, right = COLS - 1 } = crop(lines);
    const cols = right - left + 1;
    const inner = draw(lines.slice(from, to + 1), frame.theme, left, cols);
    save(name, svg({ rows: to - from + 1, cols, label, inner }, frame.theme));
}

/**
 * Renders the logo at the top of the README from src/ui/logo.ts, one rect per pixel, on a
 * transparent background so it sits on the page. The light logo is also the fallback of
 * pages that ignore its picture element, such as npm in dark mode, so its shadow is
 * translucent and fits any background.
 *
 * @param dark - Dark or light background
 */
function readmeLogo(dark: boolean): void {
    const paint = theme(dark);
    const shadow = hex(paint.rgb("logoShadow"));
    const ink: string[] = [];
    const shade: string[] = [];
    const num = (value: number) => Number(value.toFixed(2));
    logo(paint).forEach((row, r) => {
        let col = 0;
        for (const cell of cells(row)) {
            const fg = cell.pen.fg ? hex(cell.pen.fg) : undefined;
            const bg = cell.pen.bg ? hex(cell.pen.bg) : undefined;
            const top = cell.char === LOWER || cell.char === " " ? bg : fg;
            const bottom = cell.char === UPPER || cell.char === " " ? bg : fg;
            [top, bottom].forEach((color, half) => {
                if (!color) return;
                const x = num((col + 1) * CELL_W);
                const y = num(((r * 2 + half + 1) * CELL_H) / 2);
                const fill = color === shadow && !dark ? LIGHT_SHADOW : color;
                const rect = `<rect x="${x}" y="${y}" width="${num(CELL_W + 0.4)}" height="${num(CELL_H / 2 + 0.4)}" fill="${fill}"/>`;
                (color === shadow ? shade : ink).push(rect);
            });
            col += cell.span;
        }
    });
    const outW = Math.round((LOGO_WIDTH + 2) * CELL_W);
    const outH = Math.round((logo(paint).length + 1) * CELL_H);

    // One group, so the overlapping shadow pixels never darken where they meet
    const opacity = dark ? "" : ` opacity="${LIGHT_SHADOW_OPACITY}"`;
    save(
        `logo-${dark ? "dark" : "light"}`,
        [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outW} ${outH}" width="${outW}" height="${outH}" shape-rendering="crispEdges" role="img" aria-label="ccleanup">`,
            `<g${opacity}>`,
            ...shade,
            "</g>",
            ...ink,
            "</svg>",
            "",
        ].join("\n"),
    );
}

const targets = ALL.filter((session) => MARKED.has(sessionKey(session)));

readmeLogo(true);
readmeLogo(false);

hero(true);
hero(false);

// The scan line, the column header, the first rows and the embers under them
still(
    "scan",
    "The scan in progress",
    {
        sessions: ALL.slice(0, 4),
        marked: new Set(),
        cursor: 0,
        clock: NOW + 1800,
        scan: { total: ALL.length, done: 4, startedAt: NOW },
    },
    (lines) => {
        const from = lines.findIndex((line) => plain(line).includes("Scanning"));
        return { from, to: from + 6 };
    },
);
still("confirm", "The confirmation box", { confirming: true, targets }, (lines) => {
    const box = boxOf(lines);
    return { from: box.top, to: box.bottom, left: box.left, right: box.right };
});

// The details box and the search line; three more rows keep the list
still(
    "details",
    "A search with the details of a session",
    {
        sessions: ALL.filter((session) => searchMatches(session, "acme")),
        query: "acme",
        total: ALL.length,
        detailsOpen: true,
        cursor: 2,
    },
    (lines) => {
        const box = boxOf(lines);
        return { from: box.top, to: box.bottom + 1 };
    },
    ROWS + 3,
);
