<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "#ui/components/base/buttons/Button.vue";
import TooltipDirective from "#ui/components/floating/TooltipDirective.vue";
import Auth from "./Auth.vue";
import Account from "./Account.vue";
import ServerAvatar from "./ServerAvatar.vue";
import Updates from "./Updates.vue";
import {
  ServerIcon,
  PlusIcon,
  PlayIcon,
  SquareIcon,
  RotateClockwiseIcon,
  LogOutIcon,
  FolderOpenIcon,
  TerminalSquareIcon,
  ArchiveIcon,
  SettingsIcon,
  DownloadIcon,
  BoxIcon,
} from "@modrinth/assets";
import { provideI18n } from "#ui/providers/i18n";
import { providePageContext } from "#ui/providers/page-context";
import { provideModalBehavior } from "#ui/providers/modal-behavior";
import { provideNotificationManager } from "#ui/providers/web-notifications";
import { provideModrinthClient } from "#ui/providers/api-client";
import { provideAppBackup } from "#ui/providers/app-backup";
import {
  clearedLogSequence,
  api,
  act,
  servers,
  current,
  logs,
  metrics,
  notice,
  authenticated,
  username,
  refreshServers,
  power,
} from "./state";
const route = useRoute(),
  router = useRouter(),
  showAccount = ref(false),
  worldFile = ref<File | null>(null),
  createStatus = ref(""),
  showCreate = ref(false),
  busy = ref(false);
const draft = ref({ name: "", port: 25565, memory: 4096, eula: false });
provideI18n({ locale: ref("en-US"), t: (key) => key, setLocale: () => {} });
providePageContext({
  hierarchicalSidebarAvailable: ref(false),
  showAds: ref(false),
  adConsentAvailable: ref(false),
  openExternalUrl: (url) => window.open(url, "_blank", "noopener"),
  featureFlags: { serverRamAsBytesAlwaysOn: ref(true) },
});
provideModalBehavior({ noblur: ref(false) });
provideNotificationManager({
  addNotification: (n: any) => {
    notice.value = n.text || n.title;
  },
  handleError: (e: any) => {
    notice.value = e.message;
  },
} as any);
provideModrinthClient({} as any);
provideAppBackup({
  createBackup: async () => {
    if (!current.value) throw new Error("Choose a server.");
    await api(`/servers/${current.value.id}/backups`, {
      method: "POST",
      body: JSON.stringify({ name: "Before content or software change" }),
    });
  },
});
async function create() {
  busy.value = true;
  await act(async () => {
    let worldImport;
    if (worldFile.value) {
      if (worldFile.value.size > 512 * 1024 * 1024)
        throw new Error("World ZIP limit is 512 MiB.");
      createStatus.value = "Uploading and validating your world…";
      worldImport = (
        await api("/world-imports", { method: "PUT", body: worldFile.value })
      ).id;
    }
    createStatus.value = "Creating server…";
    const s = await api("/servers", {
      method: "POST",
      body: JSON.stringify({ ...draft.value, worldImport }),
    });
    await refreshServers();
    showCreate.value = false;
    worldFile.value = null;
    await router.push("/server/" + s.id);
  });
  busy.value = false;
  createStatus.value = "";
}
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
async function poll() {
  const gen = ++generation;
  clearTimeout(timer);
  if (!authenticated.value) return;
  const id = String(route.params.id || "");
  if (!id) {
    current.value = null;
    return;
  }
  try {
    const data = await api(`/servers/${id}/snapshot`);
    if (gen !== generation) return;
    current.value = data.server;
    logs.value = data.logs.filter((l: any) => l.seq > clearedLogSequence.value);
    const prev = metrics.value;
    metrics.value = {
      current: data.stats,
      past: prev?.current || data.stats,
      graph: {
        cpu: [...(prev?.graph.cpu || []), data.stats.cpu_percent].slice(-30),
        ram: [
          ...(prev?.graph.ram || []),
          (data.stats.ram_usage_bytes /
            Math.max(1, data.stats.ram_total_bytes)) *
            100,
        ].slice(-30),
      },
    };
  } catch (e) {
    if (gen === generation) notice.value = (e as Error).message;
  } finally {
    if (gen === generation && authenticated.value)
      timer = setTimeout(poll, 2500);
  }
}
watch(
  () => route.params.id,
  () => {
    current.value = null;
    logs.value = [];
    clearedLogSequence.value = 0;
    metrics.value = null;
    poll();
  },
);
watch(authenticated, () => {
  poll();
  if (authenticated.value) act(refreshServers);
});
onMounted(async () => {
  try {
    username.value = (await api("/session")).username;
    authenticated.value = true;
  } catch {}
});
onUnmounted(() => {
  generation++;
  clearTimeout(timer);
});
async function action(action: string) {
  busy.value = true;
  await act(() => power(action));
  busy.value = false;
  poll();
}
async function logout() {
  await act(async () => {
    await api("/logout", { method: "POST" });
    authenticated.value = false;
    username.value = "";
    showAccount.value = false;
    current.value = null;
    await router.push("/");
  });
}
const tabs = [
  { label: "Overview", suffix: "", icon: TerminalSquareIcon },
  { label: "Mods & plugins", suffix: "/content", icon: BoxIcon },
  { label: "Files", suffix: "/files", icon: FolderOpenIcon },
  { label: "Installation", suffix: "/installation", icon: DownloadIcon },
  { label: "Backups", suffix: "/backups", icon: ArchiveIcon },
  { label: "Settings", suffix: "/settings", icon: SettingsIcon },
];
</script>
<template>
  <TooltipDirective />
  <header class="border-0 border-b border-solid border-surface-4 bg-surface-2">
    <div
      class="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-4"
    >
      <RouterLink
        to="/"
        class="flex items-center gap-3 text-xl font-bold text-contrast no-underline"
        ><ServerIcon class="size-7 text-green" /> Moss</RouterLink
      >
      <div class="flex flex-wrap items-center gap-3">
        <Button v-if="authenticated" @click="showAccount = !showAccount"
          ><SettingsIcon />
          <span class="max-w-[180px] truncate">{{
            showAccount ? "Close account" : username
          }}</span></Button
        ><span v-else class="text-sm text-secondary">Self hosted</span
        ><Button v-if="authenticated" @click="logout"
          ><LogOutIcon /> Sign out</Button
        >
      </div>
    </div>
  </header>
  <main class="panel">
    <div
      v-if="notice"
      role="alert"
      class="mb-6 flex items-center justify-between gap-4 rounded-xl border border-solid border-orange bg-surface-3 p-4"
    >
      <span>{{ notice }}</span
      ><Button @click="notice = ''">Dismiss</Button>
    </div>
    <Auth v-if="!authenticated" />
    <template v-else>
      <Updates />
      <Account v-if="showAccount" />
      <template v-if="!route.params.id">
        <div class="mb-6 flex items-center justify-between">
          <h1 class="m-0 text-3xl font-bold text-contrast">Your servers</h1>
          <Button type="colored" color="green" @click="showCreate = !showCreate"
            ><PlusIcon /> Create server</Button
          >
        </div>
        <form
          v-if="showCreate"
          class="mb-6 grid gap-5 rounded-2xl bg-surface-2 p-6 md:grid-cols-3"
          @submit.prevent="create"
        >
          <label class="field"
            >Server name<input
              v-model="draft.name"
              required
              maxlength="80"
              placeholder="My survival server" /></label
          ><label class="field"
            >Game port<input
              v-model.number="draft.port"
              type="number"
              min="1024"
              max="65535"
              required /></label
          ><label class="field"
            >Memory (MiB)<input
              v-model.number="draft.memory"
              type="number"
              min="512"
              max="65536"
              required /></label
          ><label class="field md:col-span-3"
            >Existing world ZIP (optional)
            <input
              type="file"
              accept=".zip,application/zip"
              :disabled="busy"
              @change="
                worldFile =
                  ($event.target as HTMLInputElement).files?.[0] || null
              "
            />
            <span class="text-sm text-secondary"
              >Upload one Java Edition world with level.dat, at the ZIP root or
              inside a folder. Up to 512 MiB zipped / 4 GiB expanded. It becomes
              this server's world. Install matching Minecraft software and mods
              before starting.</span
            > </label
          ><label class="flex items-center gap-3 md:col-span-3"
            ><input v-model="draft.eula" type="checkbox" required /> I accept
            the
            <a
              href="https://www.minecraft.net/eula"
              target="_blank"
              rel="noopener"
              >Minecraft EULA</a
            >.</label
          ><Button
            native-type="submit"
            type="colored"
            color="green"
            :disabled="busy"
            >{{
              busy ? createStatus || "Please wait…" : "Create server"
            }}</Button
          >
          <p v-if="createStatus" role="status" class="md:col-span-2">
            {{ createStatus }}
          </p>
        </form>
        <div
          v-if="!servers.length"
          class="rounded-2xl bg-surface-2 px-8 py-20 text-center"
        >
          <ServerIcon class="mx-auto mb-5 size-14 text-secondary" />
          <h2 class="text-2xl font-bold text-contrast">
            A home for your next world
          </h2>
          <p>
            Create a server, choose its software in Installation, then start
            playing.
          </p>
        </div>
        <div class="flex flex-col gap-3">
          <div
            v-for="s in servers"
            :key="s.id"
            class="flex items-center gap-5 rounded-2xl bg-surface-2 p-6 no-underline hover:bg-surface-3"
          >
            <ServerAvatar :server="s" />
            <RouterLink
              :to="'/server/' + s.id"
              class="min-w-0 flex-1 no-underline"
            >
              <h2 class="m-0 text-xl font-bold text-contrast">{{ s.name }}</h2>
              <p class="mb-0 mt-1 text-secondary">
                Java server · Port {{ s.port }} · {{ s.memory }} MiB
              </p>
            </RouterLink>
            <span
              :class="s.status === 'running' ? 'text-green' : 'text-secondary'"
              >{{ s.status }}</span
            >
          </div>
        </div>
      </template>
      <template v-else-if="current">
        <RouterLink to="/" class="mb-5 inline-block text-secondary"
          >Your servers / {{ current.name }}</RouterLink
        >
        <div class="flex flex-wrap items-center justify-between gap-5">
          <div class="flex items-center gap-4">
            <ServerAvatar :server="current" large />
            <div>
              <h1 class="m-0 text-3xl font-bold text-contrast">
                {{ current.name }}
              </h1>
              <p class="mb-0 mt-2 text-secondary">
                <span :class="current.status === 'running' ? 'text-green' : ''"
                  >● {{ current.status }}</span
                >
                · Port {{ current.port }} · {{ current.uptime }}s uptime
              </p>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button
              type="colored"
              color="green"
              :disabled="busy || current.status !== 'stopped'"
              @click="action('start')"
              ><PlayIcon /> Start</Button
            ><Button
              :disabled="busy || current.status !== 'running'"
              @click="action('restart')"
              ><RotateClockwiseIcon /> Restart</Button
            ><Button
              :disabled="busy || current.status === 'stopped'"
              @click="action('stop')"
              ><SquareIcon /> Stop</Button
            >
          </div>
        </div>
        <nav class="panel-nav overflow-auto" aria-label="Server sections">
          <RouterLink
            v-for="tab in tabs"
            :key="tab.label"
            :to="'/server/' + current.id + tab.suffix"
            class="flex items-center gap-2"
            ><component :is="tab.icon" class="size-5" />{{
              tab.label
            }}</RouterLink
          >
        </nav>
        <RouterView :key="current.id" />
      </template>
      <p v-else>Loading server…</p>
    </template>
  </main>
  <footer class="panel text-sm text-secondary">
    Built with Modrinth's open-source UI · Independent self-hosted panel ·
    <a href="https://github.com/modrinth/code" target="_blank" rel="noopener"
      >Upstream source</a
    >
  </footer>
</template>
