import * as readline from 'readline';

/**
 * Read a secret without it touching argv. `modlens config set x.apiKey` with
 * no value lands here: on a terminal it prompts with the echo muted, and on a
 * pipe it reads the first line, so `pbpaste | modlens config set x.apiKey`
 * works too. Either way the key stays out of shell history and out of the
 * conversation with whatever agent is driving the terminal.
 *
 * The chat path cannot be blocked, only not led to: most users will paste a
 * key wherever is most convenient, and the docs accept that. This is the
 * clean path for the ones who care.
 */
export async function readSecret(
    promptText: string,
    stdin: NodeJS.ReadStream = process.stdin,
    stderr: NodeJS.WriteStream = process.stderr,
): Promise<string> {
    if (!stdin.isTTY) {
        let data = '';
        for await (const chunk of stdin) {
            data += chunk;
            // The first line is the key; nothing after it is wanted, and a
            // multi-megabyte accidental pipe should not be buffered whole.
            if (data.includes('\n')) {
                break;
            }
        }
        const value = data.split('\n')[0].trim();
        if (value === '') {
            throw new Error('no key arrived on stdin (pipe one line, or run on a terminal)');
        }
        return value;
    }

    // Terminal: prompt on stderr (stdout stays clean for scripts) with the
    // echo muted, the same trick every no-echo prompt uses with readline.
    const rl = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    const muted = rl as unknown as {
        _writeToOutput: (text: string) => void;
        output: NodeJS.WriteStream;
    };
    stderr.write(promptText);
    muted._writeToOutput = () => {};
    try {
        const value = await new Promise<string>((resolve) => {
            rl.question('', resolve);
        });
        stderr.write('\n');
        const trimmed = value.trim();
        if (trimmed === '') {
            throw new Error('no key entered');
        }
        return trimmed;
    } finally {
        rl.close();
    }
}
