export function assert(value: unknown, message: string): asserts value {
    if (!value) {
        throw new Error(message);
    }
}

export function equal(actual: unknown, expected: unknown, message: string): void {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
}
