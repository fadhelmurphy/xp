<script lang="ts">
  import "./styles/tw.css";
  let { label = "Svelte" }: { label?: string } = $props();
</script>

<button data-testid="btn" class="btn p-2 hover:bg-brand">{label}</button>

<style>
  @reference "tailwindcss";
  .btn {
    @apply rounded-md bg-emerald-500 text-white;
  }
</style>
