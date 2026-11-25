import { ESC } from "../lib/text.ts";

// Alternate screen, hidden cursor, no autowrap, bracketed paste
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[?2004h${ESC}[2J`;
const LEAVE = `${ESC}[0m${ESC}[?2004l${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;

// Mouse reports: presses and wheel, in the SGR format
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

/**
 * Full-screen output. `draw` takes lines that already fit the terminal width;
 * `invalidate` forgets the previous frame so the next draw clears the screen and
 * rewrites everything, inside the same synchronized update.
 */
export interface Screen {
    readonly active: boolean;
    enter: () => void;
    leave: () => void;
    draw: (lines: string[]) => void;
    invalidate: () => void;
    size: () => { cols: number; rows: number };
}

/**
 * Creates the full-screen output: alternate screen, hidden cursor, and a renderer that
 * only rewrites the lines that changed, inside a synchronized update, so nothing flickers.
 *
 * @param output - Terminal output stream
 * @param options - `mouse` asks the terminal to report clicks and the wheel while active
 * @returns The screen, not entered yet
 */
export function createScreen(
    output: NodeJS.WriteStream,
    options: { mouse?: boolean } = {},
): Screen {
    let previous: string[] = [];
    let active = false;
    let clear = false;

    return {
        get active() {
            return active;
        },
        enter() {
            if (active) return;
            active = true;
            previous = [];
            output.write(ENTER + (options.mouse ? MOUSE_ON : ""));
        },
        leave() {
            if (!active) return;
            active = false;
            output.write((options.mouse ? MOUSE_OFF : "") + LEAVE);
        },
        draw(lines) {
            if (!active) return;
            let out = "";
            const count = Math.max(lines.length, previous.length);
            for (let i = 0; i < count; i++) {
                const line = lines[i] ?? "";
                if (line === previous[i]) continue;
                out += `${ESC}[${i + 1};1H${line}${ESC}[0m${ESC}[K`;
            }
            previous = lines;
            if (clear) out = `${ESC}[2J${out}`;
            clear = false;
            if (out) output.write(SYNC_START + out + SYNC_END);
        },
        invalidate() {
            previous = [];
            clear = true;
        },
        size() {
            return { cols: output.columns || 80, rows: output.rows || 24 };
        },
    };
}
