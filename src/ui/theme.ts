import type { WriteStream } from "node:tty";

import { BEL, ESC } from "../lib/text.ts";

/**
 * Semantic color tokens of the interface.
 */
export type Tone =
    | "text"
    | "muted"
    | "accent"
    | "pink"
    | "ok"
    | "warn"
    | "err"
    | "info"
    | "selFg"
    | "selBg"
    | "logoTopLeft"
    | "logoTopRight"
    | "logoBottomLeft"
    | "logoBottomRight"
    | "logoShadow"
    | "paper"
    | "glow"
    | "ember";

/**
 * Red, green and blue components, 0 to 255.
 */
export type Rgb = [number, number, number];

/**
 * Style of a piece of text: `fg` and `bg` take tokens, `rgb` and `bgRgb` exact colors for
 * gradients, degraded like the tokens on terminals with fewer colors.
 */
export interface Style {
    fg?: Tone;
    bg?: Tone;
    rgb?: Rgb;
    bgRgb?: Rgb;
    bold?: boolean;
    dim?: boolean;
    strike?: boolean;
    inverse?: boolean;
}

/**
 * The glyph set of the interface, its equivalent of an icon library: every status mark,
 * spinner frame and border comes from here, with an ASCII twin for limited terminals.
 */
export interface Glyphs {
    cursor: string;
    marked: string;
    unmarked: string;
    caret: string;
    ellipsis: string;
    ok: string;
    err: string;
    sortDown: string;
    sortUp: string;
    times: string;
    bar: string;
    track: string;
    spinner: string[];
    box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

/**
 * Rendering capabilities and helpers. `enabled` is false when the output is not a
 * terminal, so no escape code is ever written to a file or a pipe; `depth` is 1 (no
 * color), 4 (16 colors), 8 (256 colors) or 24 (true color).
 */
export interface Theme {
    enabled: boolean;
    depth: number;
    dark: boolean;
    unicode: boolean;
    glyphs: Glyphs;
    paint: (text: string, style?: Style) => string;
    rgb: (tone: Tone) => Rgb;
}

// Palette for dark backgrounds, around the Claude terracotta accent
const DARK: Record<Tone, Rgb> = {
    text: [232, 228, 238],
    muted: [139, 134, 151],
    accent: [217, 119, 87],
    pink: [236, 106, 156],
    ok: [74, 222, 128],
    warn: [251, 191, 36],
    err: [248, 113, 113],
    info: [103, 232, 249],
    selFg: [246, 232, 238],
    selBg: [58, 34, 48],
    logoTopLeft: [255, 192, 154],
    logoTopRight: [247, 168, 200],
    logoBottomLeft: [194, 85, 58],
    logoBottomRight: [184, 51, 106],
    logoShadow: [58, 30, 22],
    paper: [28, 25, 32],
    glow: [255, 224, 163],
    ember: [138, 59, 42],
};

// Palette for light backgrounds: darker hues so text keeps an AA contrast
const LIGHT: Record<Tone, Rgb> = {
    text: [42, 37, 48],
    muted: [107, 100, 117],
    accent: [180, 83, 47],
    pink: [192, 57, 122],
    ok: [21, 128, 61],
    warn: [161, 98, 7],
    err: [185, 28, 28],
    info: [14, 116, 144],
    selFg: [42, 21, 32],
    selBg: [246, 220, 228],
    logoTopLeft: [217, 119, 79],
    logoTopRight: [192, 80, 126],
    logoBottomLeft: [143, 58, 34],
    logoBottomRight: [126, 31, 74],
    logoShadow: [222, 204, 196],
    paper: [250, 247, 244],
    glow: [214, 110, 40],
    ember: [226, 190, 170],
};

// 16-color foreground codes; the background code is the same plus 10
const BASIC: Record<Tone, number> = {
    text: 39,
    muted: 90,
    accent: 33,
    pink: 35,
    ok: 32,
    warn: 33,
    err: 31,
    info: 36,
    selFg: 39,
    selBg: 49,
    logoTopLeft: 33,
    logoTopRight: 35,
    logoBottomLeft: 31,
    logoBottomRight: 35,
    logoShadow: 90,
    paper: 49,
    glow: 33,
    ember: 31,
};

/**
 * Builds a one-character string from a code point, for the glyph tables.
 *
 * @param code - Unicode code point
 * @returns The character
 */
function cp(code: number): string {
    return String.fromCodePoint(code);
}

// Unicode glyphs, built from code points so the source stays ASCII
const UNICODE_GLYPHS: Glyphs = {
    cursor: cp(0x276f),
    marked: cp(0x2726),
    unmarked: cp(0x00b7),
    caret: cp(0x258f),
    ellipsis: cp(0x2026),
    ok: cp(0x2713),
    err: cp(0x2717),
    sortDown: cp(0x2193),
    sortUp: cp(0x2191),
    times: cp(0x00d7),
    bar: cp(0x2501),
    track: cp(0x2501),
    spinner: [0x280b, 0x2819, 0x2839, 0x2838, 0x283c, 0x2834, 0x2826, 0x2827, 0x2807, 0x280f].map(
        cp,
    ),
    box: {
        tl: cp(0x256d),
        tr: cp(0x256e),
        bl: cp(0x2570),
        br: cp(0x256f),
        h: cp(0x2500),
        v: cp(0x2502),
    },
};

// ASCII twins, for the Linux console, non UTF-8 locales and CCLEANUP_ASCII=1
const ASCII_GLYPHS: Glyphs = {
    cursor: ">",
    marked: "x",
    unmarked: ".",
    caret: "_",
    ellipsis: "...",
    ok: "+",
    err: "!",
    sortDown: "v",
    sortUp: "^",
    times: "x",
    bar: "#",
    track: "-",
    spinner: ["|", "/", "-", "\\"],
    box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

/**
 * Mixes two colors.
 *
 * @param from - Color at ratio 0
 * @param to - Color at ratio 1
 * @param ratio - Position between the two, clamped to 0..1
 * @returns The interpolated color, components rounded
 */
export function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
    const t = Math.min(1, Math.max(0, ratio));
    return from.map((value, i) => Math.round(value + (to[i]! - value) * t)) as Rgb;
}

const OSC11_REPLY = new RegExp(
    String.raw`${ESC}\]11;rgb:([0-9a-f]{1,4})/([0-9a-f]{1,4})/([0-9a-f]{1,4})`,
    "i",
);
const DA1_REPLY = new RegExp(String.raw`${ESC}\[\?[\d;]*c`);

/**
 * Converts a color to the nearest entry of the 256-color palette.
 *
 * @param rgb - Color to convert
 * @returns An index in the 6x6x6 cube (16-231) or in the gray ramp (232-255)
 */
function to256([r, g, b]: Rgb): number {
    if (r === g && g === b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        return Math.round(((r - 8) / 247) * 24) + 232;
    }
    const step = (value: number) =>
        value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40);
    return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

/**
 * Number of colors the output supports.
 *
 * Node's heuristics are the base. An empty NO_COLOR counts as unset (no-color.org) and
 * FORCE_COLOR wins over NO_COLOR, which also avoids the warning Node prints when both are
 * set. A forced color never goes below 16 colors, a TERM ending in 256color gets at least
 * 256, and any TERM but dumb gets at least 16.
 *
 * @param stream - Output stream
 * @param env - Environment to read
 * @returns 1, 4, 8 or 24 bits; 1 when the stream is not a terminal or TERM is dumb
 */
function colorDepth(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): number {
    if (!stream.isTTY || env.TERM === "dumb") return 1;
    const copy = { ...env };
    const forced = copy.FORCE_COLOR !== undefined && copy.FORCE_COLOR !== "0";
    if (copy.NO_COLOR === "" || forced) delete copy.NO_COLOR;
    if (forced && ["", "1", "true"].includes(copy.FORCE_COLOR ?? "")) delete copy.FORCE_COLOR;
    let depth = (stream as unknown as WriteStream).getColorDepth?.(copy) ?? 1;
    if (copy.NO_COLOR !== undefined && !forced) return depth;
    if (/-256colou?r$/.test(env.TERM ?? "")) depth = Math.max(depth, 8);
    if (env.TERM || forced) depth = Math.max(depth, 4);
    return depth;
}

/**
 * Tells whether the terminal can draw the Unicode glyphs.
 *
 * @param env - Environment to read
 * @returns False on the Linux console, with CCLEANUP_ASCII set, or without a UTF-8 locale
 */
function supportsUnicode(env: NodeJS.ProcessEnv): boolean {
    if (env.CCLEANUP_ASCII || env.TERM === "linux") return false;
    if (process.platform === "win32") return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
    return /utf-?8/i.test(locale) || Boolean(env.TERM_PROGRAM);
}

/**
 * Reads the background of the terminal from COLORFGBG, set by rxvt, Konsole and others.
 *
 * @param env - Environment to read
 * @returns True for a dark background, false for a light one, undefined when unknown
 */
export function darkFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
    const parts = env.COLORFGBG?.split(";");
    const bg = Number(parts?.[parts.length - 1]);
    if (!parts || Number.isNaN(bg)) return undefined;
    return bg < 7 || bg === 8;
}

/**
 * Reads a background color reply (OSC 11).
 *
 * @param reply - Raw bytes received from the terminal
 * @returns True when the luminance of the color is under one half, undefined without a reply
 */
function parseOsc11(reply: string): boolean | undefined {
    const match = OSC11_REPLY.exec(reply);
    if (!match) return undefined;
    const [r, g, b] = match.slice(1, 4).map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

/**
 * Asks the terminal for its background color.
 *
 * The OSC 11 query is followed by a device attributes query, which every terminal
 * answers in order: its reply marks the end, so a terminal without OSC 11 costs no wait.
 *
 * @param input - Terminal input, switched to raw mode for the exchange then restored
 * @param output - Terminal output
 * @param timeoutMs - Longest wait for a silent terminal
 * @returns True for a dark background, false for a light one, undefined when unknown
 */
export function probeDark(
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
    timeoutMs = 250,
): Promise<boolean | undefined> {
    const term = process.env.TERM ?? "";
    if (!input.isTTY || !output.isTTY || term === "dumb" || term === "linux") {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        let reply = "";
        const wasRaw = input.isRaw;
        const done = (value: boolean | undefined) => {
            clearTimeout(timer);
            input.removeListener("data", onData);
            input.setRawMode(wasRaw);
            input.pause();
            resolve(value);
        };
        const onData = (chunk: Buffer) => {
            reply += chunk.toString("latin1");
            if (DA1_REPLY.test(reply)) done(parseOsc11(reply));
        };
        const timer = setTimeout(() => done(parseOsc11(reply)), timeoutMs);
        input.setRawMode(true);
        input.on("data", onData);
        input.resume();
        output.write(`${ESC}]11;?${BEL}${ESC}[c`);
    });
}

/**
 * Builds the theme of an output stream.
 *
 * @param stream - Where the interface is written; a non-terminal output gets plain text
 * @param options - Known background (else COLORFGBG, else dark) and environment to read
 * @returns Capabilities, glyph set and a painter that degrades colors to what the terminal supports
 */
export function createTheme(
    stream: NodeJS.WriteStream,
    options: { dark?: boolean; env?: NodeJS.ProcessEnv } = {},
): Theme {
    const env = options.env ?? process.env;
    const enabled = Boolean(stream.isTTY);
    const depth = colorDepth(stream, env);
    const dark = options.dark ?? darkFromEnv(env) ?? true;
    const unicode = supportsUnicode(env);
    const palette = dark ? DARK : LIGHT;

    const color = (rgb: Rgb, basic: number, layer: 38 | 48): string => {
        if (depth >= 24) return `${layer};2;${rgb.join(";")}`;
        if (depth >= 8) return `${layer};5;${to256(rgb)}`;
        if (depth >= 4) return String(layer === 48 ? basic + 10 : basic);
        return "";
    };

    const paint = (text: string, style: Style = {}): string => {
        if (!enabled || text === "") return text;
        const codes: string[] = [];
        if (style.bold) codes.push("1");
        if (style.dim) codes.push("2");
        if (style.strike) codes.push("9");
        if (style.inverse) codes.push("7");
        if (style.rgb) codes.push(color(style.rgb, BASIC.accent, 38));
        else if (style.fg) codes.push(color(palette[style.fg], BASIC[style.fg], 38));
        if (style.bgRgb) codes.push(color(style.bgRgb, BASIC.accent, 48));
        else if (style.bg) codes.push(color(palette[style.bg], BASIC[style.bg], 48));
        const open = codes.filter(Boolean).join(";");
        return open ? `${ESC}[${open}m${text}${ESC}[0m` : text;
    };

    return {
        enabled,
        depth,
        dark,
        unicode,
        glyphs: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS,
        paint,
        rgb: (tone) => palette[tone],
    };
}
