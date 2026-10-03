// API publik untuk penulis komponen.
//   import { View, Text, Pressable, Modal, useState } from "@xp/runtime";
import type { VNode } from "./jsx-runtime";

export { useState, useEffect, useMemo, useCallback, useRef } from "./reconciler";
export { Fragment, createElement } from "./jsx-runtime";
export type { VNode } from "./jsx-runtime";

// Subset style ala flexbox. Web → CSS; native → Yoga + SwiftUI/Compose.
export type Style = {
  flex?: number;
  flexDirection?: "row" | "column";
  flexGrow?: number;
  flexShrink?: number;
  flexWrap?: "wrap" | "nowrap";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  alignSelf?: "auto" | "flex-start" | "center" | "flex-end" | "stretch";
  gap?: number;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  padding?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  margin?: number;
  marginHorizontal?: number;
  marginVertical?: number;
  backgroundColor?: string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  opacity?: number;
  color?: string;
  fontSize?: number;
  fontWeight?: "400" | "500" | "600" | "700";
  lineHeight?: number;
  textAlign?: "left" | "center" | "right";
  /**
   * Animasi perubahan style (ms). Yang dianimasikan: backgroundColor, opacity, width, height,
   * borderColor, color. Web → CSS transition, Android → animate*AsState, iOS → .animation.
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
type Base = { style?: Style; testID?: string; entering?: Entering };

/** Arah geser jari (atau mouse di web) yang cukup jauh, lihat `onSwipe`. */
export type SwipeDirection = "left" | "right" | "up" | "down";
/** Dipanggil saat pengguna menggeser elemen minimal 40 px ke satu arah. */
type Swipe = { onSwipe?: (direction: SwipeDirection) => void };

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
