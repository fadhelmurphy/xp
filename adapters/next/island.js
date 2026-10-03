"use client";
// Island client: tampilkan HTML hasil SSR, lalu muat bundle yang sama di browser
// dan ambil alih (state, event). Props harus serializable (tanpa function).
import { createElement, useEffect, useRef } from "react";

const loaded = new Map();

function load(src) {
  if (!loaded.has(src)) {
    loaded.set(
      src,
      fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`${src} → HTTP ${r.status}`);
          return r.text();
        })
        .then((code) => {
          const module = { exports: {} };
          new Function("module", "exports", code)(module, module.exports);
          return module.exports;
        })
        .catch((e) => {
          loaded.delete(src); // coba lagi di render berikutnya
          throw e;
        }),
    );
  }
  return loaded.get(src);
}

export function XPIsland({ src, html, props }) {
  const ref = useRef(null);
  const instance = useRef(null);
  const propsKey = JSON.stringify(props);

  useEffect(() => {
    let cancelled = false;
    load(src)
      .then((mod) => {
        if (cancelled || !ref.current) return;
        if (instance.current) instance.current.update(props);
        else instance.current = mod.render(ref.current, props);
        ref.current.dataset.xpReady = "true";
      })
      .catch((e) => console.error("[xp]", e)); // gagal: HTML SSR tetap tampil
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, propsKey]);

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
