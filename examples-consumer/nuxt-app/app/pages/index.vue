<script setup lang="ts">
// Import seperti modul biasa. Kodenya diambil dari URL saat runtime.
import PromoModal from "xp:ui/promo-modal";
import PromoSlider from "xp:ui/promo-slider";
// Komponen web dari framework lain. App ini tidak perlu memasang React atau Svelte.
import LikeButton from "xp:ui/like-button";
import RatingStars from "xp:ui/rating-stars";
import FaqList from "xp:ui/faq-list";
</script>

<template>
  <main style="max-width: 420px; margin: 32px auto; padding: 16px; display: grid; gap: 16px; font-family: system-ui, sans-serif">
    <h1 style="font-size: 20px">App konsumen (Nuxt)</h1>
    <PromoSlider />
    <PromoModal title="Kelas IELTS" :price="150000" :seats="3" />
    <LikeButton label="Suka kelas ini?" :initial="12" />
    <RatingStars title="Beri rating kelas ini" />
    <FaqList />
  </main>
</template>
