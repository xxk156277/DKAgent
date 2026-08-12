interface ReadlinePrompt {
    prompt(): void;
    once(event: "close", listener: () => void): unknown;
}

export function createSafePrompt(readline: ReadlinePrompt): () => void {
    let closed = false;
    readline.once("close", () => {
        closed = true;
    });

    // 异步模型请求返回时，stdin 可能已经 EOF 并关闭 readline。
    return () => {
        if (!closed) readline.prompt();
    };
}
