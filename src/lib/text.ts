export const ESC = String.fromCharCode(0x1b);
export const BEL = String.fromCharCode(0x07);

export const ELLIPSIS = String.fromCodePoint(0x2026);

// CSI sequences (colors, cursor moves) and OSC sequences ended by BEL or ST
const ANSI = new RegExp(
    String.raw`${ESC}\[[0-?]*[ -/]*[@-~]|${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`,
    "g",
);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL = /\p{Regional_Indicator}/u;
const MARK = /^\p{M}+$/u;

const VARIATION_SELECTOR = 0xfe0f;
const ZWJ = 0x200d;

// Code point ranges drawn on two cells: Hangul, CJK, fullwidth forms
const WIDE: [number, number][] = [
    [0x1100, 0x115f],
    [0x2329, 0x232a],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xa960, 0xa97f],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe4f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x16fe0, 0x18aff],
    [0x1b000, 0x1b2ff],
    [0x20000, 0x3fffd],
];

// Invisible code points: zero-width characters and variation selectors
const ZERO_WIDTH: [number, number][] = [
    [0x200b, 0x200f],
    [0x2060, 0x2060],
    [0xfe00, 0xfe0f],
];

// Bidirectional formatting code points, dropped from transcript text
const BIDI: [number, number][] = [
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
];

/**
 * Tells whether a code point falls in one of the given inclusive ranges.
 *
 * @param code - Unicode code point
 * @param ranges - Inclusive [from, to] pairs
 * @returns True when one range holds the code point
 */
function inRanges(code: number, ranges: [number, number][]): boolean {
    return ranges.some(([from, to]) => code >= from && code <= to);
}

/**
 * Tells whether a code point is a C0 or C1 control character.
 *
 * @param code - Unicode code point
 * @returns True for 0x00-0x1f and 0x7f-0x9f
 */
function isControl(code: number): boolean {
    return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/**
 * Lists the code points of a string.
 *
 * @param text - Any string
 * @returns One number per code point, surrogate pairs combined
 */
function codePoints(text: string): number[] {
    return Array.from(text, (char) => char.codePointAt(0) ?? 0);
}

// Code point ranges always one cell wide, the interface glyphs included
const NARROW: [number, number][] = [
    [0x20, 0x7e],
    [0xa0, 0x2ff],
    [0x2010, 0x2027],
    [0x2303, 0x2304],
    [0x2500, 0x25fc],
    [0x2713, 0x2713],
    [0x2717, 0x2717],
    [0x276f, 0x276f],
    [0x2800, 0x28ff],
];

const CACHE_LIMIT = 4096;
const widthCache = new Map<string, number>();

/**
 * Width of a string made only of single-cell code units, without segmentation.
 *
 * @param text - Plain text, without escape sequences
 * @returns The number of code units, or undefined when one of them needs the full rules
 */
function simpleWidth(text: string): number | undefined {
    for (let i = 0; i < text.length; i++) {
        if (!inRanges(text.charCodeAt(i), NARROW)) return undefined;
    }
    return text.length;
}

/**
 * Removes the escape sequences of a styled string.
 *
 * @param text - String that may hold CSI and OSC sequences
 * @returns The visible text only
 */
export function stripAnsi(text: string): string {
    return text.includes(ESC) ? text.replace(ANSI, "") : text;
}

/**
 * Number of terminal cells a single grapheme takes.
 *
 * Emoji with a default emoji presentation, flags, pictographs followed by a variation
 * selector and East Asian wide characters take two cells; marks and joiners take none.
 *
 * @param grapheme - One user-perceived character, as split by Intl.Segmenter
 * @returns 0, 1 or 2
 */
function graphemeWidth(grapheme: string): number {
    const points = codePoints(grapheme);
    const first = points[0] ?? 0;
    if (isControl(first)) return 0;
    if (MARK.test(grapheme) || points.every((code) => inRanges(code, ZERO_WIDTH))) return 0;
    if (EMOJI.test(grapheme) || REGIONAL.test(grapheme)) return 2;
    if (points.includes(VARIATION_SELECTOR) && PICTOGRAPHIC.test(grapheme)) return 2;
    return inRanges(first, WIDE) ? 2 : 1;
}

/**
 * Splits a string into graphemes.
 *
 * @param text - Plain text, without escape sequences
 * @returns The user-perceived characters, in order
 */
function graphemes(text: string): string[] {
    return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * Measures a string as the terminal draws it.
 *
 * @param text - Text that may hold escape sequences, which take no cell
 * @returns The width in terminal cells
 */
export function width(text: string): number {
    const plain = stripAnsi(text);
    const simple = simpleWidth(plain);
    if (simple !== undefined) return simple;

    const cached = widthCache.get(plain);
    if (cached !== undefined) return cached;
    let cells = 0;
    for (const grapheme of graphemes(plain)) cells += graphemeWidth(grapheme);
    if (widthCache.size >= CACHE_LIMIT) widthCache.clear();
    widthCache.set(plain, cells);
    return cells;
}

/**
 * Shortens plain text to a number of cells, on grapheme boundaries.
 *
 * @param text - Plain text, without escape sequences
 * @param cells - Maximum width in terminal cells
 * @param ellipsis - Ending added when something was cut
 * @returns The text itself when it fits, else its start followed by the ellipsis
 */
export function cut(text: string, cells: number, ellipsis = ELLIPSIS): string {
    if (cells <= 0) return "";
    if (width(text) <= cells) return text;

    // Too narrow for the ellipsis: cut bare, so the width holds.
    if (width(ellipsis) >= cells) return cut(text, cells, "");
    const limit = cells - width(ellipsis);
    if (simpleWidth(text) !== undefined) return text.slice(0, Math.max(0, limit)) + ellipsis;
    let out = "";
    let used = 0;
    for (const grapheme of graphemes(text)) {
        const cell = graphemeWidth(grapheme);
        if (used + cell > limit) break;
        out += grapheme;
        used += cell;
    }
    return out + ellipsis;
}

/**
 * Cuts or pads plain text to an exact number of cells, for table columns.
 *
 * @param text - Plain text, without escape sequences
 * @param cells - Width of the column in terminal cells
 * @param align - Side the text sticks to; the padding goes on the other side
 * @param ellipsis - Ending of a cut, the glyph of the theme in the interface
 * @returns A string exactly `cells` cells wide
 */
export function fit(
    text: string,
    cells: number,
    align: "left" | "right" = "left",
    ellipsis = ELLIPSIS,
): string {
    const short = cut(text, cells, ellipsis);
    const pad = " ".repeat(Math.max(0, cells - width(short)));
    return align === "left" ? short + pad : pad + short;
}

/**
 * Makes text read from a transcript safe and stable to print.
 *
 * Control characters become spaces and bidirectional controls are dropped. Emoji
 * sequences whose width depends on the terminal (joined families, skin tones) are
 * reduced to their first emoji, so every terminal draws them on the same cells.
 *
 * @param text - Untrusted text, such as a prompt or a title
 * @returns Text without control characters, safe for a single terminal line
 */
export function sanitize(text: string): string {
    return graphemes(text)
        .map((grapheme) => {
            const points = codePoints(grapheme).filter((code) => !inRanges(code, BIDI));
            if (points.length === 0) return "";
            if (points.every(isControl)) return " ";
            const skinTone = points.some((code) => code >= 0x1f3fb && code <= 0x1f3ff);
            if (!points.includes(ZWJ) && !skinTone) return String.fromCodePoint(...points);
            const head = String.fromCodePoint(points[0]!);
            return points.includes(VARIATION_SELECTOR)
                ? head + String.fromCodePoint(VARIATION_SELECTOR)
                : head;
        })
        .join("");
}

/**
 * Drops the first cells of a plain text, the counterpart of cut.
 *
 * @param text - Text without escape codes
 * @param cells - Cells to drop; a wide character cut in half leaves a space
 * @returns What lies after those cells
 */
export function skip(text: string, cells: number): string {
    if (cells <= 0) return text;
    let used = 0;
    let out = "";
    for (const grapheme of graphemes(text)) {
        const cell = graphemeWidth(grapheme);
        if (used >= cells) out += grapheme;
        else if (used + cell > cells) out += " ".repeat(used + cell - cells);
        used += cell;
    }
    return out;
}

/**
 * Folds a text for searching: lowercase, accents removed.
 *
 * @param text - Any text
 * @returns The folded text, so "Été" matches "ete"
 */
export function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
