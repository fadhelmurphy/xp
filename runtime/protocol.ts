// Protokol operasi UI: satu-satunya kontrak antara runtime JS dan renderer
// (native iOS/Android, DOM, SSR). Ubah dengan hati-hati dan naikkan versinya.
export const PROTOCOL_VERSION = 1;

/** Node root (tempat komponen di-mount). Tidak pernah di-create lewat op. */
export const ROOT_ID = 0;

/** Tipe node yang harus bisa dirender host. "#text" = teks mentah. */
export const PRIMITIVES = [
  "View",
  "Text",
  "Image",
  "Pressable",
  "ScrollView",
  "TextInput",
  "Modal",
  "#text",
] as const;
export type Primitive = (typeof PRIMITIVES)[number];

/** Nilai prop yang berupa function dikirim sebagai referensi handler. */
export type HandlerRef = { $fn: string };

export type Op =
  | ["create", id: number, type: Primitive]
  | ["props", id: number, props: Record<string, unknown>] // nilai null = prop dihapus
  | ["children", id: number, children: number[]] // urutan lengkap anak
  | ["delete", id: number];

/** Satu batch dari runtime ke host (dikirim sebagai JSON). */
export type Batch = { v: number; ops: Op[] };

// Arah sebaliknya (host → runtime):
//   XP.dispatch(handlerKey: string, argsJson: string)  → memanggil handler
//   XP.mount(propsJson, snapshotJson?) / XP.update(propsJson) / XP.unmount()
//   XP.nextTimer() → ms sampai timer berikutnya (-1 = tidak ada); XP.tick() → jalankan timer yang jatuh tempo
//   XP.snapshot() → JSON state useState, untuk XP.mount di bundle baru (reload saat development)
// Event bawaan: onPress(), onChangeText(text), onRequestClose(), onSwipe("left" | "right" | "up" | "down")
