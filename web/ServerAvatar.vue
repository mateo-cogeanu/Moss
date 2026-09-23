<script setup lang="ts">
import { ref, computed } from "vue";
import { ServerIcon, UploadIcon } from "@modrinth/assets";
import { api, current, servers, notice } from "./state";
const props = defineProps<{ server: any; large?: boolean }>();
const input = ref<HTMLInputElement | null>(null),
  busy = ref(false);
const source = computed(() =>
  props.server.iconRevision
    ? `/api/servers/${props.server.id}/icon?v=${props.server.iconRevision}`
    : null,
);
async function upload(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  element.value = "";
  if (!file) return;
  const id = props.server.id;
  busy.value = true;
  try {
    if (file.size > 5 * 1024 * 1024)
      throw new Error("Choose an image smaller than 5 MiB.");
    const updated = await api(`/servers/${id}/icon`, {
      method: "PUT",
      body: file,
    });
    if (current.value?.id === id)
      current.value = { ...current.value, iconRevision: updated.iconRevision };
    servers.value = servers.value.map((s) =>
      s.id === id ? { ...s, iconRevision: updated.iconRevision } : s,
    );
    notice.value = "Server icon updated.";
  } catch (error) {
    notice.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="shrink-0">
    <input
      ref="input"
      class="hidden"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      :aria-label="`Image file for ${server.name}`"
      @change="upload"
    />
    <button
      type="button"
      :disabled="busy"
      :aria-busy="busy"
      :aria-label="`Change icon for ${server.name}`"
      title="Upload server icon · PNG, JPEG or WebP · up to 5 MiB"
      class="group relative flex items-center justify-center overflow-hidden rounded-2xl border-0 bg-surface-3 p-0 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-green"
      :class="large ? 'size-[72px]' : 'size-16'"
      @click="input?.click()"
    >
      <img
        v-if="source"
        :src="source"
        :alt="`${server.name} icon`"
        class="h-full w-full object-cover"
      />
      <ServerIcon
        v-else
        :class="large ? 'size-10' : 'size-8'"
        class="text-green"
      />
      <span
        class="absolute inset-0 flex items-center justify-center bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        :class="{ 'opacity-100': busy }"
        ><span v-if="busy" class="text-xs">Uploading…</span
        ><UploadIcon v-else class="size-6"
      /></span>
    </button>
  </div>
</template>
