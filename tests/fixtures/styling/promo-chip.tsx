// Komponen xp dengan className Tailwind: varian layar, mode gelap, dan keadaan.
import "./styles/tw.css";
import { Pressable, Text, TextInput, View, useState } from "@xp/runtime";

export default function PromoChip({ label = "Promo" }: { label?: string }) {
  const [on, setOn] = useState(false);
  return (
    <View testID="root" className="p-4 md:p-8 lg:flex-row bg-white dark:bg-black tab:gap-3">
      <Pressable
        testID="chip"
        className={`px-4 py-2 rounded-full transition-colors ${on ? "bg-brand" : "bg-gray-200"} hover:bg-gray-300 active:bg-gray-400 disabled:opacity-50`}
        onPress={() => setOn(!on)}
      >
        <Text className="text-sm md:text-lg leading-tight">{label}</Text>
      </Pressable>
      <Pressable testID="manual" pressedStyle={{ opacity: 0.5 }} style={{ padding: 4 }} onPress={() => {}}>
        <Text>manual</Text>
      </Pressable>
      <TextInput testID="input" className="border border-gray-300 focus:border-brand" />
    </View>
  );
}
