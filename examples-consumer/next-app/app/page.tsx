// Import seperti modul biasa. Kodenya diambil dari URL saat runtime.
import PromoModal from "xp:ui/promo-modal";
import PromoSlider from "xp:ui/promo-slider";
// Komponen web dari framework lain. App ini tidak perlu memasang Vue atau Svelte.
import LikeButton from "xp:ui/like-button";
import RatingStars from "xp:ui/rating-stars";
import FaqList from "xp:ui/faq-list";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main style={{ maxWidth: 420, margin: "32px auto", padding: 16, display: "grid", gap: 16 }}>
      <h1 style={{ fontSize: 20 }}>App konsumen (Next.js)</h1>
      <PromoSlider />
      <PromoModal title="Kelas IELTS" price={150000} seats={3} />
      <LikeButton label="Suka kelas ini?" initial={12} />
      <RatingStars title="Beri rating kelas ini" />
      <FaqList />
    </main>
  );
}
