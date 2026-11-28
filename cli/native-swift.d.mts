export function swiftName(name: string): string;
export function compileSwift(opts: { file: string; name: string; projectDir: string; plugins?: unknown[] }): Promise<{ code: string; typeName: string; hash: string }>;
export function registrySwift(entries: { name: string; typeName: string }[]): string;
