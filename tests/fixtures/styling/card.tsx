/** @jsxImportSource react */
// React + CSS biasa, CSS modules, aset url(), dan Tailwind.
import "./card.css";
import "./styles/tw.css";
import s from "./card.module.css";
import { useState } from "react";

export default function Card() {
  const [n, setN] = useState(0);
  return (
    <div data-testid="card" className="card p-4 bg-brand rounded-lg hover:bg-blue-500" onClick={() => setN(n + 1)}>
      <h2 className={s.title}>Halo</h2>
      <span data-testid="count">{n}</span>
    </div>
  );
}
