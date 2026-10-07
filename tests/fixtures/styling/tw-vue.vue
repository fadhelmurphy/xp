<script setup lang="ts">
import "./styles/tw.css";
defineProps<{ label?: string }>();
</script>

<template>
  <button data-testid="btn" class="btn p-2 hover:bg-brand">{{ label ?? "Vue" }}</button>
</template>

<style scoped>
@reference "tailwindcss";
.btn {
  @apply rounded-md bg-blue-500 text-white;
}
</style>
