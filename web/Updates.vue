<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import Button from "#ui/components/base/buttons/Button.vue";
import { RotateClockwiseIcon } from "@modrinth/assets";
import { api, notice } from "./state";
const state = ref<any>(null),
  submitting = ref(false);
const busy = computed(
  () =>
    submitting.value ||
    ["checking", "stopping", "installing"].includes(state.value?.status),
);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
function schedule() {
  clearTimeout(timer);
  if (!disposed) timer = setTimeout(refresh, busy.value ? 2000 : 15000);
}
async function refresh() {
  clearTimeout(timer);
  try {
    state.value = await api("/updates");
  } catch {
    if (state.value?.status === "installing")
      state.value.message =
        "Moss is restarting. Waiting for it to return; sign in again when prompted.";
  } finally {
    schedule();
  }
}
async function update() {
  if (
    busy.value ||
    !confirm(
      "Check for a Moss update now? If one is available, Moss will finish active changes, save and stop all Minecraft servers, then update and restart. You will need to sign in again and start your Minecraft servers afterward.",
    )
  )
    return;
  submitting.value = true;
  try {
    state.value = await api("/updates", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
  } catch (error) {
    notice.value = (error as Error).message;
  } finally {
    submitting.value = false;
    schedule();
  }
}
onMounted(refresh);
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <div
    v-if="state"
    class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 p-4"
  >
    <div
      role="status"
      class="text-sm text-secondary"
      :class="{ 'text-orange': state.status === 'error' }"
    >
      {{ state.message }}
      <span v-if="state.current"> Current version: {{ state.current }}.</span>
      <span v-if="state.checkedAt" class="block text-xs"
        >Last checked: {{ new Date(state.checkedAt).toLocaleString() }}</span
      >
    </div>
    <Button
      v-if="state.manualAvailable"
      :disabled="busy"
      :aria-busy="busy"
      @click="update"
    >
      <RotateClockwiseIcon />{{ busy ? "Updating…" : "Update now" }}
    </Button>
  </div>
</template>
