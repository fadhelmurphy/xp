<!-- Komponen Svelte 5 biasa (target web). Runtime Svelte ikut di dalam bundle. -->
<script lang="ts">
  import { slide } from "svelte/transition";

  type Item = { q: string; a: string };

  let {
    items = [
      { q: "Berapa lama kelas IELTS?", a: "8 minggu, 3 sesi per minggu, masing-masing 90 menit." },
      { q: "Apakah ada tes penempatan?", a: "Ada, gratis dan bisa dikerjakan online sebelum kelas dimulai." },
      { q: "Bisa pindah jadwal?", a: "Bisa, maksimal 2 kali selama program berlangsung." },
    ],
  }: { items?: Item[] } = $props();

  let open = $state<number | null>(0);
</script>

<div class="faq">
  {#each items as item, i}
    <div class="item">
      <button
        class="q"
        data-testid={`faq-${i}`}
        aria-expanded={open === i}
        onclick={() => (open = open === i ? null : i)}
      >
        <span>{item.q}</span>
        <span class="chev" class:open={open === i}>›</span>
      </button>
      {#if open === i}
        <div class="a" data-testid={`faq-answer-${i}`} transition:slide={{ duration: 200 }}>{item.a}</div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .faq {
    border-radius: 12px;
    background: #fff;
    border: 1px solid #d0d7de;
    overflow: hidden;
  }
  .item + .item {
    border-top: 1px solid #d8dee4;
  }
  .q {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border: 0;
    background: none;
    font: inherit;
    font-size: 14px;
    color: #1f2328;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    color: #57606a;
    transition: transform 0.2s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .a {
    padding: 0 16px 12px;
    font-size: 13px;
    color: #57606a;
  }
</style>
