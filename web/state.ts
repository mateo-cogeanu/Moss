import { ref } from "vue";
export const username = ref("");
export const clearedLogSequence = ref(0);
export const servers = ref<any[]>([]),
  current = ref<any>(null),
  logs = ref<any[]>([]),
  metrics = ref<any>(null),
  notice = ref(""),
  authenticated = ref(false);
export async function api(route: string, options: RequestInit = {}) {
  const res = await fetch("/api" + route, {
    ...options,
    headers: {
      ...(typeof options.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  if (
    res.status === 401 &&
    ![
      "/login",
      "/register/start",
      "/register/finish",
      "/account/password",
    ].includes(route)
  )
    authenticated.value = false;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export async function act(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e) {
    notice.value = (e as Error).message;
  }
}
export async function refreshServers() {
  servers.value = await api("/servers");
}
export function serverApi(route: string, options: RequestInit = {}) {
  if (!current.value) throw new Error("Choose a server.");
  return api(`/servers/${current.value.id}${route}`, options);
}
export async function power(action: string) {
  await serverApi("/power", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  await refreshServers();
}
