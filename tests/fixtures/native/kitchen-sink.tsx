// Fitur JS yang dipakai komponen sehari-hari. Hasilnya ditampilkan sebagai teks supaya tes
// diferensial (JS vs Kotlin) membandingkan semantiknya, bukan hanya strukturnya.
import { Pressable, Text, View, useEffect, useMemo, useRef, useState } from "@xp/runtime";
import { format, Kind, summarize } from "./helpers";

type Item = { id: number; name: string; price: number; tags?: string[] };

const ITEMS: Item[] = [
  { id: 3, name: "Kopi Susu", price: 18000, tags: ["kopi", "dingin"] },
  { id: 1, name: "Teh Tarik", price: 12500.5 },
  { id: 2, name: "Air Mineral", price: 5000, tags: [] },
];

function classify(n: number): string {
  switch (true) {
    case n < 0:
      return "negatif";
    case n === 0:
      return "nol";
    case n < 10:
    case n < 100:
      return "kecil";
    default:
      return "besar";
  }
}

function weekday(i: number) {
  let out = "";
  switch (i % 7) {
    case 0:
      out = "Min";
      break;
    case 6:
      out = "Sab";
      break;
    default:
      out = "Hari kerja";
  }
  return out;
}

export default function KitchenSink({ start = 2, label }: { start?: number; label?: string }) {
  const [count, setCount] = useState(start);
  const [log, setLog] = useState<string[]>([]);
  const renders = useRef(0);
  renders.current++;

  const sorted = useMemo(() => [...ITEMS].sort((a, b) => a.price - b.price), []);
  const total = sorted.reduce((sum, { price }) => sum + price, 0);
  const names = sorted.map((it, i) => `${i + 1}. ${it.name.toUpperCase()}`).join(" | ");
  const tags = new Set(ITEMS.flatMap((it) => it.tags ?? []));
  const byId = new Map(ITEMS.map((it) => [it.id, it] as const));
  const { name: first, ...rest } = ITEMS[0];
  const [a, , c = "default", ...others] = ["x", "y", undefined, "p", "q"];

  // loop, continue, break, label
  let odd = 0;
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) continue;
    if (i > 7) break;
    odd += i;
  }
  let pairs = 0;
  outer: for (const x of [1, 2, 3]) {
    for (const y of [1, 2, 3]) {
      if (y > x) continue outer;
      if (x === 3) break outer;
      pairs++;
    }
  }
  const keys: string[] = [];
  for (const k in rest) keys.push(k);
  let w = 0;
  do {
    w += 3;
  } while (w < 10);
  let n = count;
  while (n > 0) n -= 4;

  let caught = "tidak ada";
  try {
    if (count > 3) throw new Error("terlalu banyak");
    JSON.parse("{rusak");
  } catch (e: any) {
    caught = e.name === "Error" ? e.message : e.name; // pesan error JSON beda-beda antar engine
  } finally {
    caught += "!";
  }

  const maybe = count > 4 ? { deep: { value: count } } : null;
  const optional = maybe?.deep?.value ?? "kosong";
  const words = "  satu dua   tiga ".trim().split(/\s+/);
  const csv = "a,b,,c".split(",");
  const padded = String(count).padStart(3, "0");
  const replaced = "2026-11-28".replace(/(\d+)-(\d+)-(\d+)/, "$3/$2/$1");
  const fns = [1, 2, 3].map((k) => () => k * count);
  const json = JSON.stringify({ count, list: [1, "dua", true, null], nested: { ok: !!label } });
  const math = [Math.round(2.5), Math.round(-2.5), Math.floor(-1.5), Math.max(3, 7, 1), Math.min(), 0.1 + 0.2, 7 / 2, -7 % 3, 2 ** 10].join(",");
  const numbers = [(1234.5678).toFixed(2), (0.000001234).toString(), String(1e21), String(-0), parseInt("42px"), parseFloat("3.14abc"), Number("12"), Number("x"), (255).toString(16)].join(",");
  const typeofs = [typeof count, typeof label, typeof format, typeof ITEMS, typeof null].join(",");
  const v = (x: unknown): any => x; // supaya TypeScript tidak menganggap hasilnya sudah pasti
  const truthy = [!!v(""), !!v("0"), !!v([]), !!v(0), !!v(NaN), v(null) ?? "n", v(0) || "falsy", v(0) ?? "nullish", v("") && "skip"].map(String).join(",");
  const compare = ["10" < "9", 10 < 9, "a" < "b", null == undefined, (0 as any) == "", (1 as any) === "1"].join(",");

  useEffect(() => {
    setLog((l) => [...l, `effect ${count}`].slice(-3));
    return () => {};
  }, [count]);

  useEffect(() => {
    const t = setInterval(() => setCount((x) => x + 10), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <View testID="root" style={{ gap: 4 }}>
      <Text testID="count">{label ? `${label}: ` : ""}{count} ({classify(count)}, {weekday(count)})</Text>
      <Text>{names}</Text>
      <Text>total {format(total)} · {summarize(sorted, Kind.Short)}</Text>
      <Text>tags {[...tags].join("/")} · byId {byId.get(1)?.name} · {byId.has(9) ? "ada" : "tidak"}</Text>
      <Text>{first} {JSON.stringify(rest)} {a}{c}{others.length}</Text>
      <Text>loop {odd} {pairs} {keys.join(",")} {w} {n}</Text>
      <Text>error {caught}</Text>
      <Text>opt {optional} words {words.length} csv {csv.length} {padded} {replaced}</Text>
      <Text>fns {fns.map((f) => f()).join(",")}</Text>
      <Text>{json}</Text>
      <Text>{math}</Text>
      <Text>{numbers}</Text>
      <Text>{typeofs}</Text>
      <Text>{truthy}</Text>
      <Text>{compare}</Text>
      <Text testID="log">{log.join(";")}</Text>
      {count % 2 === 0 ? <Text testID="even">genap</Text> : null}
      {[...Array(Math.min(count, 4))].map((_, i) => (
        <Text key={`k${i}`}>baris {i}</Text>
      ))}
      <Pressable testID="inc" onPress={() => setCount(count + 1)}>
        <Text>+</Text>
      </Pressable>
      <Pressable testID="dec" onPress={() => setCount((x) => x - 1)}>
        <Text>-</Text>
      </Pressable>
    </View>
  );
}
