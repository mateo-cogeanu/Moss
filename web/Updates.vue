<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { api } from "./state";
const state = ref<any>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function refresh() {
  try {
    state.value = await api("/updates");
  } catch {
    /* The panel is briefly unreachable while restarting. */
  } finally {
    if (!disposed) timer = setTimeout(refresh, 15000);
  }
}
onMounted(refresh);
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <p v-if="state" role="status" class="mb-4 text-sm text-secondary">
    {{ state.message }}
    <span v-if="state.current"> Current version: {{ state.current }}.</span>
  </p>
</template>
