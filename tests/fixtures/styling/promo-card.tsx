// Komponen xp dengan class Tailwind yang lebih lengkap: posisi, grid, shadow, gradien, transform, teks.
import { Image, Pressable, Text, View } from "@xp/runtime";

export default function PromoCard() {
  return (
    <View testID="card" className="relative overflow-hidden rounded-2xl shadow-lg shadow-blue-500/40 bg-linear-to-r from-blue-500 to-pink-500 p-4 divide-y divide-white/40">
      <Text testID="title" className="uppercase tracking-wider font-mono italic underline text-white truncate">Promo akhir tahun</Text>
      <View testID="grid" className="grid grid-cols-2 gap-x-2 gap-y-1">
        <Text testID="wide" className="col-span-2 text-xs">a</Text>
        <Text>b</Text>
      </View>
      <Image testID="img" src="x.png" className="aspect-video w-full object-contain" />
      <Pressable testID="buy" className="ml-auto ring-2 ring-white/60 active:scale-95 transition-transform border-t-2 border-dashed rounded-t-lg">
        <Text className="line-clamp-2 animate-pulse">Beli</Text>
      </Pressable>
      <View testID="badge" className="absolute top-2 right-2 z-10 -rotate-12 -translate-y-1/2"><Text>!</Text></View>
      <View testID="tall" className="hidden md:flex min-h-screen" />
    </View>
  );
}
