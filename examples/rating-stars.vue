<!-- Komponen Vue biasa (target web). Runtime Vue ikut di dalam bundle. -->
<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(defineProps<{ title?: string; max?: number }>(), {
  title: "Beri rating kelas ini",
  max: 5,
});

const value = ref(0);
const hover = ref(0);
const label = computed(() => (value.value ? `${value.value} dari ${props.max}` : "Belum dinilai"));
</script>

<template>
  <div class="rating">
    <p class="title">{{ title }}</p>
    <div class="stars" @mouseleave="hover = 0">
      <button
        v-for="i in max"
        :key="i"
        class="star"
        :class="{ on: i <= (hover || value) }"
        :data-testid="`star-${i}`"
        :aria-label="`${i} bintang`"
        @click="value = i"
        @mouseenter="hover = i"
      >
        ★
      </button>
    </div>
    <p class="label" data-testid="rating-label">{{ label }}</p>
  </div>
</template>

<style scoped>
.rating {
  padding: 12px 16px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid #d0d7de;
}
.title {
  margin: 0 0 6px;
  font-size: 14px;
  color: #1f2328;
}
.stars {
  display: flex;
  gap: 2px;
}
.star {
  border: 0;
  background: none;
  padding: 0 2px;
  font-size: 26px;
  line-height: 1;
  color: #d0d7de;
  cursor: pointer;
  transition: color 0.15s, transform 0.15s;
}
.star.on {
  color: #bf8700;
}
.star:hover {
  transform: scale(1.15);
}
.label {
  margin: 6px 0 0;
  font-size: 12px;
  color: #57606a;
}
</style>
