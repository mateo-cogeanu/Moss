<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import Button from "#ui/components/base/buttons/Button.vue";
import BackupItem from "#ui/components/servers/backups/BackupItem.vue";
import { PlusIcon } from "@modrinth/assets";
import { serverApi, current, act } from "./state";
const backups = ref<any[]>([]),
  busy = ref(false),
  stopped = computed(() => current.value?.status === "stopped");
async function refresh() {
  backups.value = await serverApi("/backups");
}
async function create() {
  busy.value = true;
  await act(async () => {
    await serverApi("/backups", {
      method: "POST",
      body: JSON.stringify({ name: "Backup " + new Date().toLocaleString() }),
    });
    await refresh();
  });
  busy.value = false;
}
async function restore(id: string) {
  if (!window.confirm("Replace all current server files with this backup?"))
    return;
  busy.value = true;
  await act(() =>
    serverApi(`/backups/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),
  );
  busy.value = false;
}
onMounted(() => act(refresh));
</script>
<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="m-0 text-2xl font-bold text-contrast">Backups</h2>
      <Button
        type="colored"
        color="green"
        :disabled="busy || !stopped"
        @click="create"
        ><PlusIcon /> Create backup</Button
      >
    </div>
    <p class="text-secondary">
      Stop the server before creating or restoring a backup. Backups include all
      server files.
    </p>
    <p v-if="!backups.length" class="rounded-2xl bg-surface-2 p-8">
      No backups yet.
    </p>
    <div
      v-for="backup in backups"
      :key="backup.id"
      class="rounded-2xl bg-surface-2 p-4"
    >
      <BackupItem :backup="backup" :preview="true" /><Button
        class="mt-3"
        :disabled="busy || !stopped"
        @click="restore(backup.id)"
        >Restore backup</Button
      >
    </div>
  </div>
</template>
