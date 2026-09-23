<script setup lang="ts">
import { ref } from "vue";
import Button from "#ui/components/base/buttons/Button.vue";
import { current, serverApi, act, refreshServers, notice } from "./state";
const name = ref(current.value.name),
  memory = ref(current.value.memory);
async function save() {
  await act(async () => {
    current.value = await serverApi("/settings", {
      method: "PATCH",
      body: JSON.stringify({ name: name.value, memory: memory.value }),
    });
    await refreshServers();
    notice.value = "Settings saved.";
  });
}
</script>
<template>
  <form
    class="flex max-w-xl flex-col gap-5 rounded-2xl bg-surface-2 p-6"
    @submit.prevent="save"
  >
    <h2 class="m-0 text-2xl font-bold text-contrast">Server settings</h2>
    <label class="field"
      >Server name<input v-model="name" required maxlength="80" /></label
    ><label class="field"
      >Java heap limit (MiB)<input
        v-model.number="memory"
        type="number"
        min="512"
        max="65536"
        required
    /></label>
    <p class="text-secondary">
      Stop the server to save changes. Edit gameplay settings in
      <code>server.properties</code> under Files. Java heap is not a hard limit
      on total process memory.
    </p>
    <Button
      native-type="submit"
      type="colored"
      color="green"
      :disabled="current.status !== 'stopped'"
      >Save changes</Button
    >
  </form>
</template>
