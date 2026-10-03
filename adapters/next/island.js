"use client";
// Island client: tampilkan HTML hasil SSR, lalu muat bundle web di browser dan ambil alih
// elemen yang sama (state, event). Props harus serializable (tanpa function).
import { createElement, useEffect, useRef } from "react";
import { mountComponent, watchDev } from "./client.js";

export function XPIsland({ src, sha256, runtime, html, props, base, name, live }) {
  const ref = useRef(null);
  const instance = useRef(null);
  const current = useRef(src);
  const latestProps = useRef(props);
  latestProps.current = props;
  const propsKey = JSON.stringify(props);

  useEffect(() => {
    if (instance.current) {
      instance.current.update(props);
      return;
    }
    let cancelled = false;
    mountComponent(ref.current, { src, sha256, runtime }, props)
      .then((handle) => {
        if (cancelled) return handle.unmount();
        instance.current = handle;
        current.current = src;
        ref.current.dataset.xpReady = "true";
      })
      .catch((e) => console.error("[xp]", e)); // gagal: HTML SSR tetap tampil
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, propsKey]);

  // xp dev: build baru → ganti bundle di tempat, state komponen dibawa.
  useEffect(() => {
    if (!live) return;
    return watchDev(base, name, async (next) => {
      if (!ref.current || !instance.current || next.src === current.current) return;
      await instance.current.replace(next);
      current.current = next.src;
      ref.current.dataset.xpVersion = next.src;
    });
  }, [live, base, name]);

  useEffect(
    () => () => {
      instance.current?.unmount();
      instance.current = null;
    },
    [src],
  );

  return createElement("div", {
    ref,
    "data-xp": src,
    style: { display: "contents" },
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: html },
  });
}
