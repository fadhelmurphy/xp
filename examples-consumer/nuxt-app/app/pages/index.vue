<script setup lang="ts">
// Import seperti modul biasa. Kodenya diambil dari URL saat runtime.
import PromoModal from "xp:ui/promo-modal";
</script>

<template>
  <main style="max-width: 420px; margin: 32px auto; padding: 16px; display: grid; gap: 16px; font-family: system-ui, sans-serif">
    <h1 style="font-size: 20px">App konsumen (Nuxt)</h1>
    <PromoModal title="Kelas IELTS" :price="150000" :seats="3" />
  </main>
</template>
