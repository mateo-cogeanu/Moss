<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Layout from "#ui/layouts/shared/installation-settings/layout.vue";
import { provideInstallationSettings } from "#ui/layouts/shared/installation-settings/providers/installation-settings";
import Combobox from "#ui/components/base/Combobox.vue";
import Button from "#ui/components/base/buttons/Button.vue";
import { api, current, act, notice } from "./state";
const id = current.value.id,
  call = (p: string, o?: RequestInit) => api(`/servers/${id}${p}`, o);
const loading = ref(true),
  busy = ref(false),
  catalogs = ref<any>({}),
  paperBuilds = ref<any>({}),
  jarInfo = ref<any>({ jars: [] }),
  jar = ref(""),
  customPlatform = ref("custom"),
  customVersion = ref("");
const platform = ref(
    current.value.installation?.platform === "custom"
      ? "vanilla"
      : current.value.installation?.platform || "vanilla",
  ),
  version = ref(current.value.installation?.version || "");
async function load() {
  loading.value = true;
  await act(async () => {
    jarInfo.value = await call("/installation");
    jar.value = jarInfo.value.jar;
    customPlatform.value = jarInfo.value.installation?.platform || "custom";
    customVersion.value = jarInfo.value.installation?.version || "";
    catalogs.value.vanilla = await call(
      "/installation/catalog?platform=vanilla",
    );
    if (!version.value)
      version.value =
        catalogs.value.vanilla.versions.find((v: any) => v.stable)?.value || "";
  });
  loading.value = false;
}
async function ensure() {
  try {
    if (!catalogs.value[platform.value])
      catalogs.value[platform.value] = await call(
        "/installation/catalog?platform=" + platform.value,
      );
    if (
      ["paper", "forge"].includes(platform.value) &&
      version.value &&
      !paperBuilds.value[platform.value + ":" + version.value]
    )
      paperBuilds.value[platform.value + ":" + version.value] = await call(
        "/installation/builds?platform=" +
          platform.value +
          "&version=" +
          encodeURIComponent(version.value),
      );
  } catch (e) {
    notice.value = (e as Error).message;
  }
}
watch([platform, version], ensure);
async function install(p: string, v: string, l: string | null) {
  if (
    !confirm(
      `Install ${p} ${v}? This changes the server startup software. Forge installation can take several minutes. Your existing JARs and world files will be kept. Back up your world before changing Minecraft versions.`,
    )
  )
    throw new Error("Installation cancelled.");
  busy.value = true;
  try {
    current.value = await call("/installation/install", {
      method: "POST",
      body: JSON.stringify({
        platform: p,
        version: v,
        loader: l,
        confirm: true,
      }),
    });
    await load();
    notice.value = "Server software installed. You can now start the server.";
  } finally {
    busy.value = false;
  }
}
async function select() {
  await act(async () => {
    current.value = await call("/installation/select", {
      method: "POST",
      body: JSON.stringify({
        jar: jar.value,
        platform: customPlatform.value,
        version: customVersion.value,
      }),
    });
    notice.value = "Startup JAR selected.";
  });
}
const unsupported = async () => {
  throw new Error("Linked modpacks are not configured.");
};
provideInstallationSettings({
  loading,
  installationInfo: computed(() => [
    {
      label: "Startup",
      value:
        current.value.installation?.launch?.argsFile ||
        current.value.jar ||
        "server.jar",
    },
    {
      label: "Source",
      value: current.value.installation?.source || "Not installed",
    },
  ]),
  isLinked: computed(() => false),
  isBusy: computed(() => busy.value || current.value.status !== "stopped"),
  busyMessage: computed(() =>
    busy.value
      ? "Installing server software… See the console for Forge installer output."
      : "Stop the server to change software.",
  ),
  modpack: ref(null),
  currentPlatform: computed(
    () => current.value.installation?.platform || "vanilla",
  ),
  currentGameVersion: computed(() => current.value.installation?.version || ""),
  currentLoaderVersion: computed(
    () => current.value.installation?.loader || "",
  ),
  requiresInstallation: computed(() => !current.value.installation),
  availablePlatforms: ["vanilla", "fabric", "forge", "paper"],
  editingPlatformRef: platform,
  editingGameVersionRef: version,
  resolveGameVersions: (p, snapshots) =>
    (catalogs.value[p]?.versions || []).filter(
      (v: any) => snapshots || v.stable,
    ),
  resolveLoaderVersions: (p, v) =>
    ["paper", "forge"].includes(p)
      ? paperBuilds.value[p + ":" + v] || []
      : catalogs.value[p]?.loaders || [],
  resolveHasSnapshots: (p) =>
    (catalogs.value[p]?.versions || []).some((v: any) => !v.stable),
  save: install,
  repair: () =>
    install(
      current.value.installation.platform,
      current.value.installation.version,
      current.value.installation.loader,
    ),
  repairing: busy,
  reinstallModpack: unsupported,
  unlinkModpack: unsupported,
  getCachedModpackVersions: () => [],
  fetchModpackVersions: async () => [],
  getVersionChangelog: async () => null,
  onModpackVersionConfirm: unsupported,
  updaterModalProps: computed(() => ({
    isApp: false,
    currentVersionId: "",
    currentGameVersion: version.value,
    currentLoader: platform.value,
  })),
  isServer: true,
  isApp: false,
} as any);
onMounted(async () => {
  await load();
  await ensure();
});
</script>
<template>
  <div class="flex flex-col gap-6">
    <div class="rounded-2xl bg-surface-2 p-6">
      <h2 class="mb-2 mt-0 text-2xl font-bold text-contrast">
        Server software
      </h2>
      <p class="text-secondary">
        Install Vanilla, Fabric, Forge (Minecraft 1.17+), or a stable Paper
        build from its official source. Forge downloads its libraries using the
        selected Java runtime. Use a Java version compatible with your selected
        release.
      </p>
      <Layout />
    </div>
    <form
      class="flex flex-col gap-4 rounded-2xl bg-surface-2 p-6"
      @submit.prevent="select"
    >
      <h2 class="m-0 text-xl font-bold text-contrast">
        Use an uploaded server JAR
      </h2>
      <p class="m-0 text-secondary">
        Upload a runnable JAR in Files, then select it here. Choose its actual
        platform and game version to filter compatible mods/plugins. A Forge
        installer JAR cannot be used here; select Forge above to install it.
      </p>
      <Combobox
        v-model="jar"
        :options="jarInfo.jars.map((j: string) => ({ value: j, label: j }))"
        placeholder="Select startup JAR"
      />
      <div class="grid gap-4 md:grid-cols-2">
        <label class="field"
          >Platform<select v-model="customPlatform">
            <option value="custom">Custom</option>
            <option value="vanilla">Vanilla</option>
            <option value="fabric">Fabric</option>
            <option value="forge">Forge (executable JAR only)</option>
            <option value="paper">Paper</option>
          </select></label
        ><label class="field"
          >Minecraft version<input
            v-model="customVersion"
            placeholder="e.g. 1.21.11"
            maxlength="80"
        /></label>
      </div>
      <Button
        native-type="submit"
        :disabled="busy || current.status !== 'stopped' || !jar"
        type="colored"
        color="green"
        >Use selected JAR</Button
      >
    </form>
  </div>
</template>
