<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Layout from "#ui/layouts/shared/files-tab/layout.vue";
import { provideFileManager } from "#ui/layouts/shared/files-tab/providers/file-manager";
import { api, current, act, notice } from "./state";
const serverId = current.value.id;
const serverApi = (route: string, options?: RequestInit) =>
  api(`/servers/${serverId}${route}`, options);
const items = ref([]),
  loading = ref(false),
  error = ref<Error | null>(null),
  currentPath = ref("/"),
  editingFile = ref(null);
const uploadState = ref({
  isUploading: false,
  currentFileName: null as string | null,
  currentFileProgress: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  completedFiles: 0,
  totalFiles: 0,
});
let uploadController: AbortController | null = null;
const url = (p: string) => "?path=" + encodeURIComponent(p);
async function refresh() {
  loading.value = true;
  try {
    items.value = await serverApi("/files" + url(currentPath.value));
    error.value = null;
  } catch (e) {
    error.value = e as Error;
    notice.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function mutate(method: string, body: any) {
  await serverApi("/files", { method, body: JSON.stringify(body) });
  await refresh();
}
provideFileManager({
  items,
  loading,
  error,
  currentPath,
  editingFile,
  navigateTo: (p) => {
    currentPath.value = p;
    refresh();
  },
  startEditing: (file) => {
    editingFile.value = file as any;
  },
  stopEditing: () => {
    editingFile.value = null;
  },
  refresh,
  createItem: (name, type) =>
    mutate("POST", { path: currentPath.value + "/" + name, type }),
  renameItem: (path, newName) =>
    mutate("POST", {
      action: "rename",
      path,
      destination: path.slice(0, path.lastIndexOf("/") + 1) + newName,
    }),
  moveItem: (source, destination) =>
    mutate("POST", { action: "move", path: source, destination }),
  deleteItem: (path, recursive) => mutate("DELETE", { path, recursive }),
  readFile: async (path) => (await serverApi("/files" + url(path))).content,
  readFileAsBlob: async (path) => {
    const r = await fetch(`/api/servers/${serverId}/download` + url(path));
    if (!r.ok) throw new Error("Could not download file.");
    return r.blob();
  },
  writeFile: (path, content) => mutate("PUT", { path, content }),
  downloadFile: async (path) => {
    const a = document.createElement("a");
    a.href = `/api/servers/${serverId}/download` + url(path);
    a.download = "";
    a.click();
  },
  uploadState,
  cancelUpload: () => uploadController?.abort(),
  uploadFiles: (files: File[]) => {
    if (uploadState.value.isUploading) return;
    const folder = currentPath.value;
    if (
      files.some((file) =>
        items.value.some((item: any) => item.name === file.name),
      ) &&
      !window.confirm("Overwrite existing files with matching names?")
    )
      return;
    uploadController = new AbortController();
    Object.assign(uploadState.value, {
      isUploading: true,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      completedFiles: 0,
      uploadedBytes: 0,
    });
    act(async () => {
      try {
        for (const file of files) {
          uploadState.value.currentFileName = file.name;
          await serverApi("/upload" + url(folder + "/" + file.name), {
            method: "PUT",
            body: file,
            signal: uploadController!.signal,
          });
          uploadState.value.completedFiles++;
          uploadState.value.uploadedBytes += file.size;
        }
        await refresh();
      } finally {
        uploadState.value.isUploading = false;
        uploadState.value.currentFileName = null;
        uploadController = null;
      }
    });
  },
  isBusy: computed(
    () => current.value?.status !== "stopped" || uploadState.value.isUploading,
  ),
  busyTooltip: computed(() => "Stop the server before changing files."),
  busyWarning: computed(() =>
    current.value?.status !== "stopped"
      ? "Stop the server to edit or upload files."
      : null,
  ),
  showInstallFromUrl: false,
  canRestart: false,
  canShareToMclogs: false,
} as any);
onMounted(refresh);
</script>
<template>
  <div class="flex flex-col gap-4">
    <p class="m-0 text-secondary">
      Upload server files here. Choose the startup JAR or install server
      software in the Installation tab.
    </p>
    <Layout :show-refresh-button="true" />
  </div>
</template>
