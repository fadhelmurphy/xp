// setTimeout / setInterval untuk QuickJS dan JavaScriptCore di device.
//
// Engine JS di SDK tidak punya event loop, jadi timer disimpan di sini dan dijalankan
// oleh SDK: setelah setiap panggilan XP.*, SDK membaca XP.nextTimer() (ms, -1 = tidak ada),
// menunggu selama itu, lalu memanggil XP.tick().
//
// Kalau host sudah punya setTimeout (mis. di browser), modul ini tidak memasang apa pun.

type Timer = { at: number; fn: (...args: unknown[]) => void; args: unknown[]; every: number | null };

const timers = new Map<number, Timer>();
let lastId = 0;
let installed = false;

function add(fn: unknown, ms: unknown, args: unknown[], repeat: boolean) {
  if (typeof fn !== "function") throw new TypeError("setTimeout/setInterval butuh function");
  const delay = Math.max(0, Number(ms) || 0);
  const id = ++lastId;
  timers.set(id, { at: Date.now() + delay, fn: fn as Timer["fn"], args, every: repeat ? Math.max(1, delay) : null });
  return id;
}

const clear = (id: unknown) => {
  timers.delete(Number(id));
};

const g = globalThis as any;
if (typeof g.setTimeout !== "function") {
  installed = true;
  g.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, false);
  g.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, true);
  g.clearTimeout = clear;
  g.clearInterval = clear;
}

/** Jalankan semua timer yang sudah jatuh tempo, urut dari yang paling awal. */
export function runDueTimers(now = Date.now()) {
  if (!installed) return;
  let error: unknown = null;
  // Batas supaya interval 1 ms yang tertinggal jauh tidak mengunci engine.
  for (let i = 0; i < 1000; i++) {
    let dueId = -1;
    let due: Timer | null = null;
    for (const [id, t] of timers) {
      if (t.at <= now && (!due || t.at < due.at)) {
        dueId = id;
        due = t;
      }
    }
    if (!due) break;
    if (due.every === null) timers.delete(dueId);
    else {
      // Interval yang tertinggal tidak dikejar (sama seperti browser).
      due.at += due.every;
      if (due.at <= now) due.at = now + due.every;
    }
    try {
      due.fn(...due.args);
    } catch (e) {
      error ??= e;
    }
  }
  if (error) throw error;
}

/** Waktu (ms) sampai timer berikutnya, atau -1 kalau tidak ada. */
export function nextTimerDelay(now = Date.now()) {
  if (!installed || !timers.size) return -1;
  let min = Infinity;
  for (const t of timers.values()) min = Math.min(min, t.at);
  return Math.max(0, Math.ceil(min - now));
}

/** Untuk tes: hapus semua timer. */
export function resetTimers() {
  timers.clear();
}
