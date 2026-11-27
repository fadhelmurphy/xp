// Komponen contoh dengan view native milik app: kalender bawaan Android (CalendarView) atau iOS
// (UIDatePicker), didaftarkan app lewat `nativeViews` di XPView. Tanggal yang dipilih dikirim
// balik ke komponen lewat onEvent. Di web, atau kalau app tidak mendaftarkan "calendar",
// children NativeView yang tampil.
import { NativeView, Pressable, Text, View, useState } from "@xp/runtime";

type Props = { title?: string };

export default function JadwalKelas({ title = "Pilih jadwal kelas" }: Props) {
  const [date, setDate] = useState<string | null>(null);

  return (
    <View style={{ padding: 16, gap: 12, backgroundColor: "#FFFFFF", borderRadius: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>{title}</Text>
      <NativeView
        testID="calendar"
        name="calendar"
        props={{ minDate: Date.now() }}
        onEvent={(event, data) => event === "select" && setDate(String(data))}
        style={{ height: 320, borderRadius: 8, overflow: "hidden" }}
      >
        <View style={{ padding: 16, backgroundColor: "#F6F8FA", borderRadius: 8, gap: 4 }}>
          <Text style={{ color: "#57606A" }}>Kalender tersedia di aplikasi.</Text>
          <Text style={{ color: "#57606A", fontSize: 12 }}>Di web, pilih jadwal lewat admin kelas.</Text>
        </View>
      </NativeView>
      <Text testID="picked" style={{ color: date ? "#1A7F37" : "#57606A" }}>
        {date ? `Jadwal: ${date}` : "Belum memilih tanggal"}
      </Text>
      {date ? (
        <Pressable testID="reset" onPress={() => setDate(null)} style={{ alignSelf: "flex-start" }}>
          <Text style={{ color: "#1F6FEB" }}>Ganti tanggal</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
