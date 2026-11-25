import { ESC } from "../lib/text.ts";

// Rows a turn of the wheel moves the cursor by
export const WHEEL_ROWS = 3;

// A report in the SGR format: button, column and row from 1, then M for press or m for release
export const MOUSE = new RegExp(String.raw`${ESC}\[<(\d+);(\d+);(\d+)([Mm])`, "g");

/**
 * What the user did with the mouse; a click acts on its whole row, so only the row is kept.
 */
export type MouseEvent =
    { kind: "click"; button: "left" | "right"; y: number } | { kind: "wheel"; direction: 1 | -1 };

/**
 * Reads one report of the terminal.
 *
 * @param code - Button and modifier bits
 * @param y - Row, from 1
 * @param final - M for a press or a turn of the wheel, m for a release
 * @returns A plain left or right click, or a turn of the wheel; releases, drags, the middle button and clicks with a modifier key give nothing
 */
export function parseMouse(code: number, y: number, final: string): MouseEvent | undefined {
    if (final !== "M") return undefined;
    if (code === 0) return { kind: "click", button: "left", y: y - 1 };
    if (code === 2) return { kind: "click", button: "right", y: y - 1 };
    if (code === 64) return { kind: "wheel", direction: -1 };
    if (code === 65) return { kind: "wheel", direction: 1 };
    return undefined;
}

/**
 * Finds the session under a click.
 *
 * @param y - Row of the click, from 0
 * @param first - Screen row of the first session shown, or -1 when no list is drawn
 * @param shown - Rows of the list
 * @param top - Index of the first session shown
 * @param count - Number of sessions in the list
 * @returns The index of the session, or undefined for a click outside the rows
 */
export function rowAt(
    y: number,
    first: number,
    shown: number,
    top: number,
    count: number,
): number | undefined {
    if (first < 0 || y < first || y >= first + shown) return undefined;
    const index = top + y - first;
    return index < count ? index : undefined;
}
