// Slider promo: satu slide tampil, pindah lewat tombol ‹ ›, titik indikator, atau geser (swipe).
// Bisa berganti otomatis lewat prop `autoplay` (ms).
// Animasi: warna latar & titik aktif bertransisi, konten slide baru masuk dari arah navigasi.
// Hanya memakai primitive yang ada, jadi jalan sama di web, Android, dan iOS.
import { Pressable, Text, View, useEffect, useState, type Style } from "@xp/runtime";

type Slide = { title: string; subtitle: string; color: string };

type Props = {
  slides?: Slide[];
  /** Ganti slide otomatis setiap sekian ms. 0 = mati. */
  autoplay?: number;
};

const DEFAULT_SLIDES: Slide[] = [
  { title: "IELTS Intensif", subtitle: "8 minggu, target band 7", color: "#1F6FEB" },
  { title: "TOEFL Prep", subtitle: "Simulasi tes setiap minggu", color: "#8250DF" },
  { title: "Speaking Club", subtitle: "Latihan bicara bareng mentor", color: "#1A7F37" },
];

const navButton: Style = {
  width: 36,
  height: 36,
  borderRadius: 18,
  borderWidth: 1,
  borderColor: "#D0D7DE",
  backgroundColor: "#FFFFFF",
  alignItems: "center",
  justifyContent: "center",
};

export default function PromoSlider({ slides = DEFAULT_SLIDES, autoplay = 0 }: Props) {
  const [index, setIndex] = useState(0);
  // Arah perpindahan terakhir: 1 = maju (konten masuk dari kanan), -1 = mundur.
  const [direction, setDirection] = useState(1);
  const count = slides.length;

  // Timer diulang setiap slide berganti, jadi navigasi manual juga mereset hitungan autoplay.
  useEffect(() => {
    if (!autoplay || count < 2) return;
    const t = setTimeout(() => {
      setDirection(1);
      setIndex((i) => (Math.min(i, count - 1) + 1) % count);
    }, autoplay);
    return () => clearTimeout(t);
  }, [autoplay, index, count]);

  if (count === 0) return null;

  // Jumlah slide dari app host bisa berkurang; jaga index tetap di dalam rentang.
  const active = Math.min(index, count - 1);
  const current = slides[active];
  const go = (to: number, dir: number) => {
    setDirection(dir);
    setIndex(((to % count) + count) % count);
  };

  return (
    <View style={{ gap: 12 }}>
      <View
        testID="slide"
        onSwipe={(dir) => {
          if (dir === "left") go(active + 1, 1);
          if (dir === "right") go(active - 1, -1);
        }}
        style={{
          height: 160,
          padding: 20,
          borderRadius: 16,
          justifyContent: "flex-end",
          backgroundColor: current.color,
          transitionDuration: 350,
          transitionTimingFunction: "ease-in-out",
        }}
      >
        {/* key berganti → konten lama dilepas, konten baru dibuat dan menjalankan `entering`. */}
        <View key={active} style={{ gap: 4 }} entering={{ opacity: 0, translateX: 28 * direction, duration: 320 }}>
          <Text testID="slide-title" style={{ color: "#FFFFFF", fontSize: 22, fontWeight: "700" }}>
            {current.title}
          </Text>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 14 }}>{current.subtitle}</Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Pressable testID="prev" style={navButton} onPress={() => go(active - 1, -1)}>
          <Text style={{ fontSize: 18, color: "#1F2328" }}>‹</Text>
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {slides.map((_, i) => (
            <Pressable
              key={i}
              testID={`dot-${i}`}
              onPress={() => go(i, i >= active ? 1 : -1)}
              style={{
                width: i === active ? 18 : 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: i === active ? "#1F6FEB" : "#D0D7DE",
                transitionDuration: 250,
              }}
            />
          ))}
        </View>

        <Pressable testID="next" style={navButton} onPress={() => go(active + 1, 1)}>
          <Text style={{ fontSize: 18, color: "#1F2328" }}>›</Text>
        </Pressable>
      </View>

      <Text testID="counter" style={{ textAlign: "center", fontSize: 12, color: "#57606A" }}>
        {active + 1} / {count}
      </Text>
    </View>
  );
}
