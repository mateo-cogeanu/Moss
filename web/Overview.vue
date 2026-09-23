<script setup lang="ts">
import { provideModrinthServerContext } from "#ui/providers/server-context";
import { computed } from "vue";
import ConsoleLayout from "#ui/layouts/shared/console/layout.vue";
import Stats from "#ui/components/servers/ServerManageStats.vue";
import { provideConsoleManager } from "#ui/layouts/shared/console/providers/console-manager";
import {
  clearedLogSequence,
  current,
  logs,
  metrics,
  serverApi,
  act,
} from "./state";
provideModrinthServerContext({ serverId: current.value.id } as any);
provideConsoleManager({
  logLines: logs,
  showCommandInput: true,
  disableCommandInput: computed(() => current.value?.status !== "running"),
  shareDisabled: computed(() => true),
  emptyStateType: "server",
  sendCommand: (command) => {
    act(() =>
      serverApi("/command", {
        method: "POST",
        body: JSON.stringify({ command }),
      }),
    );
  },
  onClear: () => {
    clearedLogSequence.value =
      logs.value.at(-1)?.seq || clearedLogSequence.value;
    logs.value = [];
  },
});
</script>
<template>
  <div class="flex flex-col gap-6">
    <Stats v-if="metrics" :data="metrics" :show-memory-as-bytes="true" />
    <div class="flex items-center justify-between">
      <h2 class="m-0 text-2xl font-semibold text-contrast">Console</h2>
      <span class="text-sm text-secondary">Updates every 2.5 seconds</span>
    </div>
    <div class="console-height"><ConsoleLayout /></div>
  </div>
</template>
