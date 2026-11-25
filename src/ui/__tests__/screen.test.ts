import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createScreen } from "../screen.ts";

/**
 * A terminal output that keeps what is written to it.
 *
 * @returns The stream and its written chunks
 */
function recorder(): { output: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const output = {
        columns: 80,
        rows: 24,
        write: (chunk: string) => written.push(chunk),
    } as unknown as NodeJS.WriteStream;
    return { output, written };
}

describe("Screen mouse", () => {
    it("asks for mouse reports only when told to, and gives them back on leave", () => {
        const plain = recorder();
        const screen = createScreen(plain.output);
        screen.enter();
        screen.leave();
        assert.ok(!plain.written.join("").includes("?1000"));

        const mouse = recorder();
        const withMouse = createScreen(mouse.output, { mouse: true });
        withMouse.enter();
        withMouse.leave();
        const [entered, left] = mouse.written;
        assert.ok(entered!.includes("\u001b[?1000h\u001b[?1006h"));
        assert.ok(left!.startsWith("\u001b[?1006l\u001b[?1000l"));
    });
});
