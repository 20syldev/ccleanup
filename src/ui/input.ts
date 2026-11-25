import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { BEL, ESC } from "../lib/text.ts";

import { MOUSE, type MouseEvent, parseMouse } from "./mouse.ts";

// Terminal replies that must never read as keys: OSC strings and device attributes
const REPLY = new RegExp(
    String.raw`${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)|${ESC}\[\?[\d;]*c`,
    "g",
);

// The start of a reply cut at the end of a chunk, kept until the next chunk
const PARTIAL = new RegExp(
    String.raw`${ESC}(?:\][^${BEL}${ESC}]*${ESC}?|\[(?:\?[\d;]*|<[\d;]*)?)?$`,
);

// The start of a mouse report that something else broke off
const STRAY = new RegExp(String.raw`${ESC}\[<[\d;]*`, "g");

// Wait for the rest of a cut sequence before a lone Esc, as long as Vim does
const CARRY_MS = 100;

// What readline reports for Esc, sent without its own half-second wait for a sequence
const ESCAPE: Key = { sequence: ESC, name: "escape", ctrl: false, meta: false, shift: false };

/**
 * Keyboard input of the interface; `close` detaches it from stdin.
 */
export interface Input {
    close: () => void;
}

/**
 * Decodes keys from stdin, after removing the replies the terminal sends on its own.
 *
 * Replies to the background probe can arrive late, on a slow link: without this filter,
 * readline would turn `rgb:2a2a/...` into the keys r, g, b and a, which mark sessions.
 *
 * @param stdin - Terminal input, already in raw mode
 * @param onKey - Called for each decoded key, as readline reports it
 * @param onMouse - Called for each click or turn of the wheel; reports are dropped without it
 * @returns The input, to close when the interface ends
 */
export function createInput(
    stdin: NodeJS.ReadStream,
    onKey: (text: string | undefined, key: Key | undefined) => void,
    onMouse?: (event: MouseEvent) => void,
): Input {
    const relay = new PassThrough();
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let timer: NodeJS.Timeout | undefined;

    // Set when the flush dropped half a report: its end is no key either
    let orphan = false;

    const flush = () => {
        timer = undefined;

        // Nothing followed the escape byte: a lone Esc
        if (carry === ESC) onKey(undefined, ESCAPE);

        // Half a mouse report is dropped: as keys it would type its digits
        else if (carry.startsWith(`${ESC}[<`)) orphan = true;
        else if (carry) relay.write(carry);
        carry = "";
    };

    const onData = (chunk: Buffer) => {
        clearTimeout(timer);
        let received = decoder.write(chunk);
        if (orphan) {
            received = received.replace(/^[\d;]*[Mm]/, "");
            orphan = false;
        }
        let text = (carry + received).replace(REPLY, "");
        text = text.replace(MOUSE, (_report, code, _x, y, final) => {
            const event = parseMouse(Number(code), Number(y), final);
            if (event) onMouse?.(event);
            return "";
        });
        carry = "";
        const partial = PARTIAL.exec(text);
        if (partial?.[0]) {
            carry = partial[0];
            text = text.slice(0, partial.index);
            timer = setTimeout(flush, CARRY_MS);
        }

        // What is left of a report broken off by other input is no key
        text = text.replace(STRAY, "");
        if (text) relay.write(text);
    };

    emitKeypressEvents(relay);
    relay.on("keypress", onKey);
    stdin.on("data", onData);
    stdin.resume();

    return {
        close() {
            clearTimeout(timer);
            stdin.removeListener("data", onData);
            relay.removeAllListeners("keypress");
            relay.end();
        },
    };
}
