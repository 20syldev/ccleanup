import { cut, width } from "../lib/text.ts";

import type { Style, Theme } from "./theme.ts";

/**
 * Text and optional style of one piece of a line, painted by line().
 */
export type Segment = [string, Style?];

/**
 * Joins styled segments into one line that never exceeds a width.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @param segments - Text and style pairs, in order
 * @param cols - Maximum width in cells; the segment that crosses it is cut with an ellipsis
 * @param base - Style applied over every segment, such as the selection background
 * @param pad - Fill the rest of the line with the base style, for a full-width bar
 * @returns The painted line
 */
export function line(
    theme: Theme,
    segments: Segment[],
    cols: number,
    base: Style = {},
    pad = false,
) {
    let out = "";
    let used = 0;
    for (const [text, style = {}] of segments) {
        if (used >= cols) break;
        const room = cols - used;
        const piece = width(text) > room ? cut(text, room, theme.glyphs.ellipsis) : text;
        const merged: Style = { ...style, ...base, fg: style.fg, bg: style.bg ?? base.bg };
        const plain = style.fg === undefined || style.fg === "text";
        if (base.bg && !style.bg && plain) merged.fg = "selFg";

        // Reverse video: a colored piece would break the bar.
        if (base.inverse) delete merged.fg;
        out += theme.paint(piece, merged);
        used += width(piece);
    }
    if (pad && used < cols) out += theme.paint(" ".repeat(cols - used), base);
    return out;
}

/**
 * Style of the selected row.
 *
 * @param theme - Theme of the output: colors, depth and glyph set
 * @returns A tinted background with 256 colors or more, reverse video below
 */
export function selectionStyle(theme: Theme): Style {
    if (!theme.enabled) return {};
    return theme.depth >= 8 ? { bg: "selBg" } : { inverse: true };
}
