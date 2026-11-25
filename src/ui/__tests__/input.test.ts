import assert from "node:assert/strict";
import type { Key } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { ESC } from "../../lib/text.ts";
import { createInput } from "../input.ts";
import type { MouseEvent } from "../mouse.ts";

/**
 * Sends raw bytes to a fresh input and collects the keys it reports.
 *
 * @param chunks - Chunks of terminal input, written one after the other
 * @param waitMs - Time to wait after the last chunk
 * @returns The names of the keys, and the time the first one took
 */
async function keys(chunks: string[], waitMs = 250): Promise<{ names: string[]; firstMs: number }> {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const names: string[] = [];
    const start = performance.now();
    let firstMs = Infinity;
    const input = createInput(stdin, (text: string | undefined, key: Key | undefined) => {
        firstMs = Math.min(firstMs, performance.now() - start);
        names.push(key?.name ?? text ?? "");
    });
    for (const chunk of chunks) stdin.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    input.close();
    return { names, firstMs };
}

describe("createInput", () => {
    it("reports a lone Esc after a short wait, not readline's half second", async () => {
        const { names, firstMs } = await keys([ESC]);
        assert.deepEqual(names, ["escape"]);
        assert.ok(firstMs < 250, `Esc took ${Math.round(firstMs)} ms`);
    });

    it("still reads arrows sent with their escape byte", async () => {
        const { names } = await keys([`${ESC}[A`, `${ESC}[B`]);
        assert.deepEqual(names, ["up", "down"]);
    });

    it("drops a background color reply instead of reading it as keys", async () => {
        const { names } = await keys([`${ESC}]11;rgb:2a2a/2a2a/2a2a${ESC}\\`, "q"]);
        assert.deepEqual(names, ["q"]);
    });

    it("reports clicks and the wheel, and never reads a report as keys", async () => {
        const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
        const names: string[] = [];
        const events: MouseEvent[] = [];
        const input = createInput(
            stdin,
            (text, key) => names.push(key?.name ?? text ?? ""),
            (event) => events.push(event),
        );
        stdin.write(`${ESC}[<0;10;5Mj${ESC}[<0;10;5m${ESC}[<65;3;3M${ESC}[<64;3;3M`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        input.close();
        assert.deepEqual(names, ["j"]);
        assert.deepEqual(events, [
            { kind: "click", button: "left", y: 4 },
            { kind: "wheel", direction: 1 },
            { kind: "wheel", direction: -1 },
        ]);
    });

    it("puts back together a report cut between two chunks", async () => {
        const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
        const names: string[] = [];
        const events: MouseEvent[] = [];
        const input = createInput(
            stdin,
            (text, key) => names.push(key?.name ?? text ?? ""),
            (event) => events.push(event),
        );
        stdin.write(`${ESC}[<0;1`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        stdin.write("2;7M");
        await new Promise((resolve) => setTimeout(resolve, 150));
        input.close();
        assert.deepEqual(names, []);
        assert.deepEqual(events, [{ kind: "click", button: "left", y: 6 }]);
    });

    it("drops the reports, without keys, when nobody listens", async () => {
        const { names } = await keys([`${ESC}[<0;10;5M${ESC}[<0;10;5m`, "q"]);
        assert.deepEqual(names, ["q"]);
    });

    it("holds a report cut right after the introducer", async () => {
        const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
        const names: string[] = [];
        const events: MouseEvent[] = [];
        const input = createInput(
            stdin,
            (text, key) => names.push(key?.name ?? text ?? ""),
            (event) => events.push(event),
        );
        stdin.write(`${ESC}[`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        stdin.write("<0;10;5M");
        await new Promise((resolve) => setTimeout(resolve, 150));
        input.close();
        assert.deepEqual(names, []);
        assert.deepEqual(events, [{ kind: "click", button: "left", y: 4 }]);
    });

    it("never types the digits of a report whose rest comes late", async () => {
        const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
        const names: string[] = [];
        const input = createInput(stdin, (text, key) => names.push(key?.name ?? text ?? ""));
        stdin.write(`${ESC}[<0;10`);

        // Longer than the wait for the rest of a cut sequence
        await new Promise((resolve) => setTimeout(resolve, 250));
        stdin.write(";5M");
        await new Promise((resolve) => setTimeout(resolve, 100));
        input.close();
        assert.deepEqual(names, []);
    });

    it("never types the digits of a report broken off by another key", async () => {
        const { names } = await keys([`${ESC}[<0;10`, "x"], 300);
        assert.deepEqual(names, ["x"]);
    });
});
