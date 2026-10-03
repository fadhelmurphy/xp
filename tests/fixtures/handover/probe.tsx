// Komponen uji: state, ref, memo, dan effect dengan interval.
import { Text, View, useEffect, useMemo, useRef, useState } from "@xp/runtime";

export default function Probe() {
  const [n, setN] = useState(0);
  const ref = useRef({ id: Math.random() });
  const memo = useMemo(() => ({ made: Math.random() }), []);
  useEffect(() => {
    const g = globalThis as any;
    g.__effectRuns = (g.__effectRuns ?? 0) + 1;
    const t = setInterval(() => setN((x) => x + 1), 15);
    return () => {
      g.__cleanups = (g.__cleanups ?? 0) + 1;
      clearInterval(t);
    };
  }, []);
  return (
    <View>
      <Text testID="n">{n}</Text>
      <Text testID="ref">{String(ref.current.id)}</Text>
      <Text testID="memo">{String(memo.made)}</Text>
    </View>
  );
}
