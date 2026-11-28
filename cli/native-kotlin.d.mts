export class NativeCompileError extends Error {}
export function kotlinName(name: string): string;
export function compileKotlin(opts: { file: string; name: string; projectDir: string; plugins?: unknown[]; pkg?: string }): Promise<{ code: string; objectName: string; hash: string }>;
export function registryKotlin(entries: { name: string; objectName: string }[], pkg?: string): string;
