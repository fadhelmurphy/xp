// Keadaan layar yang memengaruhi class Tailwind varian `dark:` dan breakpoint (`sm:`, `md:`, ...),
// juga satuan vh/vw (h-screen, w-screen) di device. Diisi host: DOM dari window, SDK native lewat
// XP.environment(json). SSR memakai nilai awal (lebar 0, mode terang), sama seperti Tailwind
// yang mobile-first.

export type Environment = { width: number; height: number; dark: boolean };

let env: Environment = { width: 0, height: 0, dark: false };
const breakpoints = new Set<number>();
let viewportUnits = false;
const listeners = new Set<() => void>();

export function environment(): Environment {
  return env;
}

/**
 * Dipanggil kode className komponen: lebar-lebar yang memengaruhi tampilannya, dan apakah ada
 * ukuran dalam vh/vw (perlu render ulang setiap ukuran layar berubah).
 */
export function registerBreakpoints(list: number[], viewport = false) {
  for (const w of list) breakpoints.add(w);
  if (viewport) viewportUnits = true;
}

/** Host memberi tahu perubahan ukuran layar / mode gelap. Komponen dirender ulang kalau perlu. */
export function setEnvironment(next: Partial<Environment>) {
  const prev = env;
  env = { ...env, ...next };
  const crossed = [...breakpoints].some((w) => prev.width >= w !== env.width >= w);
  const resized = viewportUnits && (prev.width !== env.width || prev.height !== env.height);
  if (crossed || resized || prev.dark !== env.dark) for (const l of [...listeners]) l();
}

export function onEnvironmentChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
