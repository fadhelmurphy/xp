export class TypedCompileError extends Error {}
export function typedName(name: string): string;
export function compileTypedKotlin(opts: { file: string; name: string; projectDir: string; classes?: unknown }): { code: string; typeName: string; hash: string };
