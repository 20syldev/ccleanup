import { mix, type Rgb, type Theme } from "./theme.ts";

const WORD = "ccleanup";

// Block font: "#" full, "^" upper half, "_" lower half, two pixels per cell
const LETTERS: Record<string, string[]> = {
    c: ["#^^", "#  ", "^^^"],
    l: ["#  ", "#  ", "^^^"],
    e: ["#^^", "#^ ", "^^^"],
    a: ["#^#", "#^#", "^ ^"],
    n: ["#_ #", "# ^#", "^  ^"],
    u: ["# #", "# #", "^^^"],
    p: ["#^#", "#^^", "^  "],
};

// The spark mascot; its blank sixth row lines it up with the word
const MASCOT = ["..#..", "#.#.#", ".###.", "#.#.#", "..#..", "....."];
const MASCOT_GAP = 2;

const SHAPE_ROWS = 6;

// Pixel rows that hold ink; the blank row under them takes the shadow
const INK_ROWS = SHAPE_ROWS - 1;

// Bitmap of the mascot and the word, one string per pixel row
const SHAPE: string[] = Array.from(
    { length: SHAPE_ROWS },
    (_, pixelRow) =>
        MASCOT[pixelRow]! +
        ".".repeat(MASCOT_GAP) +
        [...WORD]
            .map((letter) => LETTERS[letter]![Math.floor(pixelRow / 2)]!)
            .join(" ")
            .replace(/./g, (char) => {
                const upper = pixelRow % 2 === 0;
                const on = char === "#" || (char === "^" && upper) || (char === "_" && !upper);
                return on ? "#" : ".";
            }),
);

// The shadow falls one pixel down and right
const TERMINAL_ROWS = SHAPE_ROWS / 2;

export const LOGO_WIDTH = SHAPE[0]!.length + 1;

const FULL = String.fromCodePoint(0x2588);
const UPPER = String.fromCodePoint(0x2580);
const LOWER = String.fromCodePoint(0x2584);

// Painted logo per theme: it never changes while the interface runs
const logoCache = new WeakMap<Theme, string[]>();

/**
 * Tells whether a pixel of the mascot or the word is on.
 *
 * @param row - Pixel row, 0 at the top; rows outside the bitmap are off
 * @param col - Pixel column, 0 at the left
 * @returns True for an on pixel
 */
function pixel(row: number, col: number): boolean {
    return SHAPE[row]?.[col] === "#";
}

/**
 * Tells whether a pixel lies in the shadow: off itself, with an on pixel up and left.
 *
 * @param row - Pixel row, 0 at the top
 * @param col - Pixel column, 0 at the left
 * @returns True for a shadow pixel
 */
function shadowed(row: number, col: number): boolean {
    return !pixel(row, col) && pixel(row - 1, col - 1);
}

/**
 * Color of one pixel of the logo, on a gradient from left to right and from top to
 * bottom between the four corner tokens of the theme.
 *
 * @param theme - Theme of the output
 * @param row - Pixel row, 0 at the top
 * @param col - Pixel column, 0 at the left
 * @returns The bilinear mix of the corner colors at that pixel
 */
function shade(theme: Theme, row: number, col: number): Rgb {
    const x = col / (LOGO_WIDTH - 1);
    const y = row / (INK_ROWS - 1);
    const top = mix(theme.rgb("logoTopLeft"), theme.rgb("logoTopRight"), x);
    const bottom = mix(theme.rgb("logoBottomLeft"), theme.rgb("logoBottomRight"), x);
    return mix(top, bottom, y);
}

/**
 * Color of a pixel with its shadow.
 *
 * @param theme - Theme of the output
 * @param row - Pixel row, 0 at the top
 * @param col - Pixel column, 0 at the left
 * @returns The gradient color of an on pixel, the shadow color, or undefined for an empty pixel
 */
function colorAt(theme: Theme, row: number, col: number): Rgb | undefined {
    if (pixel(row, col)) return shade(theme, row, col);
    if (shadowed(row, col)) return theme.rgb("logoShadow");
    return undefined;
}

/**
 * Draws one terminal row of the logo with its 2D gradient and its drop shadow.
 *
 * A terminal row holds two pixel rows: the upper half block takes the color of the upper
 * pixel as foreground and, when both pixels are filled, the lower one as background.
 *
 * @param theme - Theme of the output, with at least 256 colors
 * @param row - Terminal row, 0 at the top
 * @returns The painted row, LOGO_WIDTH cells wide
 */
function gradientRow(theme: Theme, row: number): string {
    let out = "";
    for (let col = 0; col < LOGO_WIDTH; col++) {
        const upper = colorAt(theme, row * 2, col);
        const lower = colorAt(theme, row * 2 + 1, col);
        if (upper && lower) out += theme.paint(UPPER, { rgb: upper, bgRgb: lower });
        else if (upper) out += theme.paint(UPPER, { rgb: upper });
        else if (lower) out += theme.paint(LOWER, { rgb: lower });
        else out += " ";
    }
    return out;
}

/**
 * Draws one terminal row of the logo in a single color and without shadow, for 16-color
 * terminals.
 *
 * @param theme - Theme of the output
 * @param row - Terminal row, 0 at the top
 * @returns The painted row, LOGO_WIDTH cells wide
 */
function flatRow(theme: Theme, row: number): string {
    let out = "";
    for (let col = 0; col < LOGO_WIDTH; col++) {
        const high = pixel(row * 2, col);
        const low = pixel(row * 2 + 1, col);
        out += high && low ? FULL : high ? UPPER : low ? LOWER : " ";
    }
    return theme.paint(out, { fg: "accent", bold: true });
}

/**
 * Draws the pixel logo, painted once per theme.
 *
 * @param theme - Theme of the output: a 2D gradient from 256 colors up, one color below
 * @returns Three rows of LOGO_WIDTH cells, or the bold word alone without Unicode
 */
export function logo(theme: Theme): string[] {
    const cached = logoCache.get(theme);
    if (cached) return cached;
    const draw = (row: number) =>
        theme.depth >= 8 ? gradientRow(theme, row) : flatRow(theme, row);
    const rows = theme.unicode
        ? Array.from({ length: TERMINAL_ROWS }, (_, row) => draw(row))
        : [theme.paint(WORD, { fg: "accent", bold: true })];
    logoCache.set(theme, rows);
    return rows;
}

/**
 * Writes the word "ccleanup" across the logo colors, for one-line headers and the exit
 * summary.
 *
 * @param theme - Theme of the output; below 256 colors the word takes the accent
 * @returns The painted word, plain when the output is not a terminal
 */
export function wordmark(theme: Theme): string {
    if (!theme.enabled) return WORD;
    if (theme.depth < 8) return theme.paint(WORD, { fg: "accent", bold: true });
    return [...WORD]
        .map((char, i) =>
            theme.paint(char, {
                rgb: shade(theme, 1, (i / (WORD.length - 1)) * (LOGO_WIDTH - 1)),
                bold: true,
            }),
        )
        .join("");
}
