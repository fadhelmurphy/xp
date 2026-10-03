/** @jsxImportSource react */
// Komponen React biasa (target web). Konsumen tidak perlu memuat React:
// runtime React ikut di dalam bundle hasil `xp build`.
import { useState } from "react";

type Props = { label?: string; initial?: number };

export default function LikeButton({ label = "Suka kelas ini?", initial = 12 }: Props) {
  const [liked, setLiked] = useState(false);
  const count = initial + (liked ? 1 : 0);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderRadius: 12,
        background: "#FFFFFF",
        border: "1px solid #D0D7DE",
      }}
    >
      <span style={{ flex: 1, fontSize: 14, color: "#1F2328" }}>{label}</span>
      <button
        data-testid="like"
        aria-pressed={liked}
        onClick={() => setLiked((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 999,
          border: "1px solid",
          borderColor: liked ? "#CF222E" : "#D0D7DE",
          background: liked ? "#FFEBE9" : "#FFFFFF",
          color: liked ? "#CF222E" : "#57606A",
          fontSize: 14,
          cursor: "pointer",
          transition: "all .2s",
        }}
      >
        <span aria-hidden>{liked ? "♥" : "♡"}</span>
        <span data-testid="likes">{count}</span>
      </button>
    </div>
  );
}
