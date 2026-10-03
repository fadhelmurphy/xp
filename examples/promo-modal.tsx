// Komponen contoh: ditulis sekali, jalan di web (SSR + client) dan native (QuickJS → SwiftUI/Compose).
// Punya state & logika: modal buka/tutup, jumlah peserta, hitung total.
import { Modal, Pressable, Text, View, useState, type Style } from "@xp/runtime";

type Props = { title: string; price: number; seats?: number };

// Intl tidak tersedia di QuickJS, jadi format manual (logika ini jalan di device).
function rupiah(n: number) {
  return "Rp" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const button: Style = { backgroundColor: "#1F6FEB", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" };
const ghost: Style = { ...button, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#1F6FEB" };

export default function PromoModal({ title, price, seats = 10 }: Props) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(1);

  return (
    <View style={{ padding: 16, gap: 12, backgroundColor: "#FFFFFF", borderRadius: 12 }}>
      <Text testID="title" style={{ fontSize: 18, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: "#57606A" }}>{rupiah(price)} / orang</Text>
      <Pressable testID="open" style={button} onPress={() => setOpen(true)}>
        <Text style={{ color: "#FFFFFF", fontWeight: "600" }}>Lihat detail</Text>
      </Pressable>

      <Modal visible={open} onRequestClose={() => setOpen(false)}>
        <View style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 20, gap: 12, width: "100%", maxWidth: 360 }}>
          <Text style={{ fontSize: 16, fontWeight: "700" }}>Daftar {title}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable testID="minus" style={ghost} disabled={qty <= 1} onPress={() => setQty((q) => q - 1)}>
              <Text style={{ color: "#1F6FEB" }}>−</Text>
            </Pressable>
            <Text testID="qty">Peserta: {qty}</Text>
            <Pressable testID="plus" style={ghost} disabled={qty >= seats} onPress={() => setQty((q) => q + 1)}>
              <Text style={{ color: "#1F6FEB" }}>+</Text>
            </Pressable>
          </View>
          <Text testID="total" style={{ fontWeight: "600" }}>Total: {rupiah(price * qty)}</Text>
          {qty >= seats && <Text testID="full" style={{ color: "#CF222E" }}>Kuota penuh</Text>}
          <Pressable testID="close" style={button} onPress={() => setOpen(false)}>
            <Text style={{ color: "#FFFFFF" }}>Tutup</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
