import { messages } from "../i18n/messages.ts";
import type { Lang } from "../lib/format.ts";
import { cut, width } from "../lib/text.ts";

import { mascot, wordmark } from "./logo.ts";
import type { Theme } from "./theme.ts";

// Smallest terminal that gets a brand, the message, the size and the hint
const FULL_COLS = 20;
const FULL_ROWS = 6;

// Smallest terminal that gets the size under the message
const MID_COLS = 12;
const MID_ROWS = 3;

/**
 * Draws the screen that asks for a bigger terminal, centered and cut down to what fits:
 * the pixel mascot or else the marked name, the message, the size against the size needed
 * and the hint; then the message and the size; then the message alone.
 *
 * @param theme - Theme of the output
 * @param lang - Language of the texts
 * @param cols - Terminal width in cells
 * @param rows - Terminal height
 * @param need - Smallest width and height of the interface
 * @param need.cols - Smallest width in cells
 * @param need.rows - Smallest height in rows
 * @returns At most rows lines, none wider than cols
 */
export function tooSmallView(
    theme: Theme,
    lang: Lang,
    cols: number,
    rows: number,
    need: { cols: number; rows: number },
): string[] {
    const text = messages(lang).tooSmall;
    const title = theme.paint(cut(text.title, cols, theme.glyphs.ellipsis), {
        fg: "warn",
        bold: true,
    });
    if (rows < MID_ROWS || cols < MID_COLS) return [title];
    const size = sizeLine(theme, text.needs, cols, rows, need);
    if (rows < FULL_ROWS || cols < FULL_COLS) return centered([title, size], cols, rows);

    const name = theme.unicode
        ? `${theme.paint(theme.glyphs.marked, { fg: "accent" })} ${wordmark(theme)}`
        : wordmark(theme);
    const hint = wrap(text.hint, cols).map((part) => theme.paint(part, { fg: "muted" }));

    // The mascot when there is room for it, else the name; the blank before the hint goes first
    for (const brand of [mascot(theme), [name]]) {
        if (brand.length === 0) continue;
        const block = [...brand, "", title, size];
        if (block.length + 1 + hint.length <= rows)
            return centered([...block, "", ...hint], cols, rows);
        if (block.length + hint.length <= rows) return centered([...block, ...hint], cols, rows);
    }
    const short = theme.paint(cut(text.hint, cols, theme.glyphs.ellipsis), { fg: "muted" });
    return centered([name, "", title, size, "", short], cols, rows);
}

/**
 * Writes the size of the terminal against the size it needs, the dimension that is too
 * small flagged; the needed size goes first when the line is too wide.
 *
 * @param theme - Theme of the output
 * @param needs - Word before the needed size
 * @param cols - Terminal width in cells
 * @param rows - Terminal height
 * @param need - Smallest width and height of the interface
 * @param need.cols - Smallest width in cells
 * @param need.rows - Smallest height in rows
 * @returns The painted line
 */
function sizeLine(
    theme: Theme,
    needs: string,
    cols: number,
    rows: number,
    need: { cols: number; rows: number },
): string {
    const times = theme.glyphs.times;
    const dim = (value: number, short: boolean) =>
        theme.paint(String(value), short ? { fg: "err", bold: true } : { fg: "text" });
    const now = `${dim(cols, cols < need.cols)} ${times} ${dim(rows, rows < need.rows)}`;
    const wanted = theme.paint(`${needs} ${need.cols} ${times} ${need.rows}`, { fg: "muted" });
    const line = `${now}  ${wanted}`;
    return width(line) <= cols ? line : now;
}

/**
 * Breaks a text at its spaces into lines of about the same length.
 *
 * @param text - Plain text
 * @param cells - Widest line
 * @returns The lines, the narrowest set that keeps the fewest lines
 */
function wrap(text: string, cells: number): string[] {
    const greedy = (limit: number) => {
        const lines: string[] = [];
        for (const word of text.split(" ")) {
            const last = lines.at(-1);
            if (last !== undefined && width(last) + 1 + width(word) <= limit)
                lines[lines.length - 1] = `${last} ${word}`;
            else lines.push(cut(word, limit));
        }
        return lines;
    };
    let best = greedy(cells);
    for (let limit = cells - 1; limit > 0 && greedy(limit).length === best.length; limit--)
        best = greedy(limit);
    return best;
}

/**
 * Centers a block of lines in the terminal.
 *
 * @param lines - Painted lines, each at most cols cells wide; an empty line stays empty
 * @param cols - Terminal width in cells
 * @param rows - Terminal height
 * @returns The block with blank lines above it and each line indented on its own
 */
function centered(lines: string[], cols: number, rows: number): string[] {
    const above = Array<string>(Math.max(0, Math.floor((rows - lines.length) / 2))).fill("");
    const indent = (line: string) =>
        line ? " ".repeat(Math.max(0, Math.floor((cols - width(line)) / 2))) + line : line;
    return [...above, ...lines.map(indent)];
}
