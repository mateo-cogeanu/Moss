<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import Layout from "#ui/layouts/shared/content-tab/layout.vue";
import { provideContentManager } from "#ui/layouts/shared/content-tab/providers/content-manager";
import Input from "#ui/components/base/inputs/Input.vue";
import Button from "#ui/components/base/buttons/Button.vue";
import Combobox from "#ui/components/base/Combobox.vue";
import NewModal from "#ui/components/modal/NewModal.vue";
import { SearchIcon, DownloadIcon } from "@modrinth/assets";
import { api, current, act, notice } from "./state";
const id = current.value.id,
  router = useRouter(),
  call = (p: string, o?: RequestInit) => api(`/servers/${id}${p}`, o);
const items = ref<any[]>([]),
  loading = ref(true),
  error = ref<Error | null>(null),
  busy = ref(false),
  modal = ref<any>(),
  query = ref(""),
  hits = ref<any[]>([]),
  selected = ref<any>(null),
  versions = ref<any[]>([]),
  versionId = ref(""),
  plan = ref<any[]>([]);
const compatible = computed(
  () =>
    ["fabric", "paper"].includes(current.value.installation?.platform) &&
    current.value.installation?.version,
);
async function refresh() {
  loading.value = true;
  try {
    items.value = await call("/content");
    error.value = null;
  } catch (e) {
    error.value = e as Error;
  } finally {
    loading.value = false;
  }
}
async function search() {
  busy.value = true;
  await act(async () => {
    hits.value = (
      await call("/content/search?query=" + encodeURIComponent(query.value))
    ).hits;
    selected.value = null;
    plan.value = [];
  });
  busy.value = false;
}
async function choose(hit: any) {
  busy.value = true;
  await act(async () => {
    selected.value = hit;
    versions.value = await call(
      "/content/versions?project=" + encodeURIComponent(hit.project_id),
    );
    versionId.value = versions.value[0]?.id || "";
    plan.value = [];
  });
  busy.value = false;
}
async function preview() {
  busy.value = true;
  await act(async () => {
    plan.value = await call("/content/plan", {
      method: "POST",
      body: JSON.stringify({ versionId: versionId.value }),
    });
  });
  busy.value = false;
}
async function install() {
  busy.value = true;
  await act(async () => {
    await call("/content/install", {
      method: "POST",
      body: JSON.stringify({ versionId: versionId.value, confirm: true }),
    });
    notice.value = "Content and required dependencies installed.";
    plan.value = [];
    modal.value.hide();
    await refresh();
  });
  busy.value = false;
}
function browse() {
  if (!compatible.value) {
    notice.value =
      "Choose Fabric or Paper and a Minecraft version in Installation to browse compatible content.";
    router.push(`/server/${id}/installation`);
    return;
  }
  modal.value.show();
  search();
}
async function upload() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".jar";
  input.onchange = () =>
    act(async () => {
      busy.value = true;
      try {
        const folder =
          current.value.installation?.platform === "paper" ? "plugins" : "mods";
        try {
          await call("/files?path=" + folder);
        } catch {
          await call("/files", {
            method: "POST",
            body: JSON.stringify({ path: folder, type: "directory" }),
          });
        }
        for (const file of Array.from(input.files || [])) {
          if (!file.name.endsWith(".jar")) throw new Error("Choose JAR files.");
          if (
            items.value.some((x) => x.file_name === file.name) &&
            !confirm(`Replace ${file.name}?`)
          )
            continue;
          await call(
            "/upload?path=" + encodeURIComponent(folder + "/" + file.name),
            { method: "PUT", body: file },
          );
        }
        await refresh();
      } finally {
        busy.value = false;
      }
    });
  input.click();
}
provideContentManager({
  items,
  loading,
  error,
  managedContent: ref(null),
  isPackLocked: ref(false),
  isBusy: computed(() => busy.value || current.value.status !== "stopped"),
  busyMessage: computed(() =>
    busy.value
      ? "Installing content…"
      : current.value.status !== "stopped"
        ? "Stop the server before changing content."
        : null,
  ),
  contentTypeLabel: computed(() =>
    current.value.installation?.platform === "paper" ? "plugins" : "mods",
  ),
  toggleEnabled: async (item) => {
    await call("/content/toggle", {
      method: "POST",
      body: JSON.stringify({ path: item.file_path }),
    });
    await refresh();
  },
  deleteItem: async (item) => {
    await call("/files", {
      method: "DELETE",
      body: JSON.stringify({ path: item.file_path }),
    });
    await refresh();
  },
  refresh,
  browse,
  uploadFiles: upload,
  hasUpdateSupport: false,
  deletionContext: "server",
  showEnvironmentWarnings: false,
  mapToTableItem: (item) => ({ ...item, hideSwitchVersion: true }),
  filterPersistKey: "local-" + id,
} as any);
onMounted(refresh);
</script>
<template>
  <div class="flex flex-col gap-4">
    <p class="m-0 text-secondary">
      {{
        current.installation?.platform === "paper"
          ? "Paper plugins"
          : "Server mods"
      }}
      ·
      {{
        current.installation?.version ||
        "Select server software in Installation"
      }}. Stop your server to make changes.
    </p>
    <Layout />
  </div>
  <NewModal ref="modal" header="Browse Modrinth content" max-width="800px">
    <div class="flex flex-col gap-4">
      <form class="flex gap-2" @submit.prevent="search">
        <Input
          v-model="query"
          :icon="SearchIcon"
          placeholder="Search compatible mods or plugins"
          wrapper-class="flex-1"
        /><Button native-type="submit" :disabled="busy">Search</Button>
      </form>
      <p class="m-0 text-secondary">
        Filtered for {{ current.installation?.platform }} ·
        {{ current.installation?.version }}. Required dependencies are included
        in the install review.
      </p>
      <template v-if="selected"
        ><Button
          @click="
            selected = null;
            plan = [];
          "
          >Back to results</Button
        >
        <h3 class="m-0 text-xl font-bold">{{ selected.title }}</h3>
        <Combobox
          v-model="versionId"
          :options="
            versions.map((v) => ({ value: v.id, label: v.version_number }))
          "
          placeholder="Choose a version"
          @update:model-value="plan = []"
        /><Button :disabled="busy || !versionId" @click="preview"
          >Review installation</Button
        >
        <div v-if="plan.length" class="rounded-xl bg-surface-3 p-4">
          <p class="mt-0 font-bold">Files to install</p>
          <ul>
            <li v-for="entry in plan" :key="entry.versionId">
              {{ entry.title }} · {{ entry.version }}
              <span class="text-secondary">({{ entry.file.filename }})</span>
            </li>
          </ul>
          <Button type="colored" color="green" :disabled="busy" @click="install"
            ><DownloadIcon />{{
              busy ? "Installing…" : "Install these files"
            }}</Button
          >
        </div></template
      >
      <template v-else
        ><p v-if="busy">Loading…</p>
        <p v-else-if="!hits.length">No compatible projects found.</p>
        <div class="flex max-h-[440px] flex-col gap-2 overflow-auto">
          <button
            v-for="hit in hits"
            :key="hit.project_id"
            class="cursor-pointer rounded-xl border-0 bg-surface-3 p-4 text-left text-primary hover:bg-surface-4"
            @click="choose(hit)"
          >
            <strong class="block text-lg text-contrast">{{ hit.title }}</strong
            ><span>{{ hit.description }}</span>
          </button>
        </div></template
      >
    </div>
  </NewModal>
</template>
