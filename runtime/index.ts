// API publik untuk penulis komponen.
//   import { View, Text, Pressable, Modal, useState } from "@xp/runtime";
import type { VNode } from "./jsx-runtime";

export { useState, useEffect, useMemo, useCallback, useRef } from "./reconciler";
export { Fragment, createElement } from "./jsx-runtime";
export { environment, registerBreakpoints, type Environment } from "./environment";
export type { VNode } from "./jsx-runtime";

type Length = number | `${number}%`;
/** Panjang yang boleh memakai satuan layar: "100vh" (tinggi layar), "100vw" (lebar layar). */
type ScreenLength = Length | `${number}vh` | `${number}vw`;

// Subset style ala flexbox (seperti React Native). Web → CSS; native → Compose / SwiftUI.
export type Style = {
  // --- tata letak ---
  /** "none" menyembunyikan elemen. "grid" memakai `gridColumns`. Selain itu elemen selalu flex. */
  display?: "flex" | "none" | "grid";
  flex?: number;
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexGrow?: number;
  flexShrink?: number;
  flexWrap?: "wrap" | "nowrap";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  alignSelf?: "auto" | "flex-start" | "center" | "flex-end" | "stretch";
  gap?: number;
  /** Jarak antar kolom / baris (mis. gap-x-4, gap-y-2). Default: `gap`. */
  columnGap?: number;
  rowGap?: number;
  /** display: "grid": jumlah kolom (lebar sama). Anak boleh memakai `gridColumnSpan`. */
  gridColumns?: number;
  /** Lebar anak grid dalam kolom; -1 = satu baris penuh. */
  gridColumnSpan?: number;
  width?: ScreenLength;
  height?: ScreenLength;
  minWidth?: ScreenLength;
  maxWidth?: ScreenLength;
  minHeight?: ScreenLength;
  maxHeight?: ScreenLength;
  aspectRatio?: number;
  /** Posisi absolut relatif terhadap parent langsung (seperti React Native). */
  position?: "relative" | "absolute";
  top?: Length;
  right?: Length;
  bottom?: Length;
  left?: Length;
  zIndex?: number;
  /** "hidden" memotong isi yang keluar dari kotak (termasuk sudut membulat). */
  overflow?: "visible" | "hidden";
  padding?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** "auto" mendorong elemen ke sisi lain (ml-auto) atau ke tengah (mx-auto), seperti flexbox web. */
  margin?: number | "auto";
  marginHorizontal?: number | "auto";
  marginVertical?: number | "auto";
  marginTop?: number | "auto";
  marginRight?: number | "auto";
  marginBottom?: number | "auto";
  marginLeft?: number | "auto";

  // --- kotak ---
  backgroundColor?: string;
  /** Gradien linear: "linear-gradient(to right, #2b7fff, #f6339a)" (arah: to top/right/bottom/left, to top right, ..., atau 45deg). */
  backgroundImage?: string;
  borderRadius?: number;
  borderTopLeftRadius?: number;
  borderTopRightRadius?: number;
  borderBottomRightRadius?: number;
  borderBottomLeftRadius?: number;
  borderWidth?: number;
  borderTopWidth?: number;
  borderRightWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderColor?: string;
  borderStyle?: "solid" | "dashed" | "dotted";
  /** Seperti CSS: "0px 4px 6px -1px #0000001a, ...". Lapisan tanpa blur dengan spread = garis luar (ring). */
  boxShadow?: string;
  /** Garis pemisah di antara anak (divide-x / divide-y), mengikuti arah flexDirection. */
  dividerWidth?: number;
  dividerColor?: string;
  opacity?: number;
  scaleX?: number;
  scaleY?: number;
  /** px, atau persen dari ukuran elemen sendiri ("-50%"). */
  translateX?: Length;
  translateY?: Length;
  /** derajat */
  rotate?: number;
  /** Animasi berulang bawaan Tailwind (animate-spin, animate-pulse, animate-bounce, animate-ping). */
  animation?: "none" | "spin" | "pulse" | "bounce" | "ping";

  // --- teks ---
  color?: string;
  fontSize?: number;
  fontWeight?: "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";
  fontStyle?: "normal" | "italic";
  /** "sans-serif", "serif", "monospace", atau nama font yang terpasang di perangkat/halaman. */
  fontFamily?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right";
  textDecorationLine?: "none" | "underline" | "line-through";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** "nowrap": satu baris. */
  whiteSpace?: "normal" | "nowrap";
  textOverflow?: "clip" | "ellipsis";
  /** Batasi jumlah baris (line-clamp-*), diakhiri "…". */
  lineClamp?: number;

  // --- gambar ---
  objectFit?: "cover" | "contain" | "fill";

  // --- hanya web (di device tidak berpengaruh) ---
  cursor?: string;
  userSelect?: "auto" | "none" | "text";
  outlineStyle?: "none";
  /** "none": sentuhan/klik tembus ke elemen di bawahnya (web dan iOS). */
  pointerEvents?: "auto" | "none";

  /**
   * Animasi perubahan style (ms). Yang dianimasikan: backgroundColor, opacity, width, height,
   * borderColor, color, transform (scale/translate/rotate). Web → CSS transition,
   * Android → animate*AsState, iOS → .animation.
   */
  transitionDuration?: number;
  transitionTimingFunction?: "ease" | "linear" | "ease-in" | "ease-out" | "ease-in-out";
};

/**
 * Animasi saat elemen muncul (setelah komponen ter-mount): dari nilai ini ke style normal.
 * Cocok dipakai bersama `key` yang berganti, mis. konten slide baru.
 */
export type Entering = {
  opacity?: number;
  translateX?: number;
  translateY?: number;
  /** ms, default 250 */
  duration?: number;
};

type Children = { children?: unknown };
type Base = {
  style?: Style;
  /** Diisi otomatis dari varian className (`active:`, `hover:`, `focus:`). */
  pressedStyle?: Style;
  hoverStyle?: Style;
  focusStyle?: Style;
  /** Class Tailwind, diterjemahkan ke `style` saat build. `style` menang kalau keduanya mengatur hal yang sama. */
  className?: string;
  testID?: string;
  entering?: Entering;
};

/** Arah geser jari (atau mouse di web) yang cukup jauh, lihat `onSwipe`. */
export type SwipeDirection = "left" | "right" | "up" | "down";
type Swipe = {
  /** Dipanggil saat pengguna menggeser elemen minimal 40 px ke satu arah. */
  onSwipe?: (direction: SwipeDirection) => void;
  /** Selama digeser, elemen ikut jari di sumbu ini, lalu kembali ke tempatnya saat dilepas. */
  dragAxis?: "x" | "y";
};

export type ViewProps = Base & Children & Swipe;
export type TextProps = Base & Children & { numberOfLines?: number };
export type ImageProps = Base & { src: string; alt?: string };
export type PressableProps = Base & Children & Swipe & { onPress?: () => void; disabled?: boolean };
export type ScrollViewProps = Base & Children & { horizontal?: boolean };
export type TextInputProps = Base & {
  value?: string;
  placeholder?: string;
  onChangeText?: (text: string) => void;
  secure?: boolean;
};
export type ModalProps = Base & Children & { visible: boolean; onRequestClose?: () => void };

// Primitive = string di runtime (dirender host), tapi bertipe komponen supaya props dicek TypeScript.
const primitive = <P,>(name: string) => name as unknown as (props: P) => VNode;

export const View = primitive<ViewProps>("View");
export const Text = primitive<TextProps>("Text");
export const Image = primitive<ImageProps>("Image");
export const Pressable = primitive<PressableProps>("Pressable");
export const ScrollView = primitive<ScrollViewProps>("ScrollView");
export const TextInput = primitive<TextInputProps>("TextInput");
export const Modal = primitive<ModalProps>("Modal");
