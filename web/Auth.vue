<script setup lang="ts">
import { ref } from "vue";
import QrcodeVue from "qrcode.vue";
import Button from "#ui/components/base/buttons/Button.vue";
import { api, authenticated, username, notice } from "./state";
const mode = ref("login"),
  busy = ref(false);
const name = ref(""),
  password = ref(""),
  confirm = ref(""),
  adminKey = ref(""),
  code = ref("");
const enrollment = ref<any>(null),
  recovery = ref<string[]>([]),
  saved = ref(false);
function switchMode() {
  mode.value = mode.value === "login" ? "register" : "login";
  enrollment.value = null;
  password.value = "";
  confirm.value = "";
  adminKey.value = "";
  code.value = "";
  notice.value = "";
}
async function submit() {
  busy.value = true;
  notice.value = "";
  try {
    if (mode.value === "login") {
      const user = await api("/login", {
        method: "POST",
        body: JSON.stringify({
          username: name.value,
          password: password.value,
          code: code.value,
        }),
      });
      password.value = "";
      code.value = "";
      username.value = user.username;
      authenticated.value = true;
    } else if (!enrollment.value) {
      if (password.value !== confirm.value)
        throw new Error("Passwords do not match.");
      enrollment.value = await api("/register/start", {
        method: "POST",
        body: JSON.stringify({
          username: name.value,
          password: password.value,
          adminKey: adminKey.value,
        }),
      });
      password.value = "";
      confirm.value = "";
      adminKey.value = "";
    } else {
      const user = await api("/register/finish", {
        method: "POST",
        body: JSON.stringify({
          enrollment: enrollment.value.enrollment,
          code: code.value,
        }),
      });
      recovery.value = user.recoveryCodes;
      username.value = user.username;
      enrollment.value = null;
      code.value = "";
    }
  } catch (e) {
    notice.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function downloadCodes() {
  const blob = new Blob(
    [
      `Moss recovery codes for ${username.value}\nEach code can be used once instead of an authenticator code. Keep these private.\n\n${recovery.value.join("\n")}\n`,
    ],
    { type: "text/plain" },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = "moss-recovery-codes.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <section
    class="mx-auto mt-12 flex max-w-md flex-col gap-5 rounded-2xl bg-surface-2 p-8"
  >
    <template v-if="recovery.length">
      <h1 class="m-0 text-2xl font-bold text-contrast">
        Save your recovery codes
      </h1>
      <p class="m-0">
        Your account is ready. Each code works once if you lose access to your
        authenticator. These codes are only shown now.
      </p>
      <div class="grid grid-cols-1 gap-2 rounded-xl bg-surface-3 p-4">
        <code v-for="item in recovery" :key="item">{{ item }}</code>
      </div>
      <Button @click="downloadCodes">Download recovery codes</Button>
      <label class="flex items-center gap-3"
        ><input v-model="saved" type="checkbox" /> I saved my recovery codes
        somewhere safe</label
      >
      <Button
        :disabled="!saved"
        type="colored"
        color="green"
        @click="
          recovery = [];
          authenticated = true;
        "
        >Continue to servers</Button
      >
    </template>
    <form v-else class="flex flex-col gap-5" @submit.prevent="submit">
      <h1 class="m-0 text-2xl font-bold text-contrast">
        {{
          enrollment
            ? "Set up two-factor authentication"
            : mode === "login"
              ? "Sign in to Moss"
              : "Create your account"
        }}
      </h1>
      <template v-if="enrollment">
        <p class="m-0">
          Scan this QR code with your authenticator app, then enter its
          six-digit code. Setup expires in 10 minutes.
        </p>
        <div class="self-center rounded-xl bg-white p-4">
          <QrcodeVue :value="enrollment.uri" :size="192" level="M" />
        </div>
        <details>
          <summary>Enter a setup key manually</summary>
          <code class="mt-3 block break-all" data-testid="totp-secret">{{
            enrollment.secret
          }}</code>
        </details>
        <label class="field"
          >Authenticator code<input
            v-model="code"
            required
            inputmode="numeric"
            pattern="[0-9]{6}"
            autocomplete="one-time-code"
            placeholder="6-digit code"
        /></label>
      </template>
      <template v-else>
        <p v-if="mode === 'register'" class="m-0">
          The host's admin key authorizes account creation. Every account can
          manage all servers. You'll set up an authenticator next.
        </p>
        <label class="field"
          >Username<input
            v-model="name"
            required
            autocomplete="username"
            minlength="3"
            maxlength="32"
            pattern="[a-zA-Z0-9_\-]+"
            placeholder="Username"
        /></label>
        <label class="field"
          >Password<input
            v-model="password"
            required
            type="password"
            :minlength="mode === 'register' ? 12 : undefined"
            :autocomplete="
              mode === 'register' ? 'new-password' : 'current-password'
            "
            placeholder="Password"
        /></label>
        <template v-if="mode === 'register'">
          <p class="m-0 text-sm text-secondary">
            Use at least 12 characters. A long, unique passphrase works well.
          </p>
          <label class="field"
            >Confirm password<input
              v-model="confirm"
              required
              type="password"
              autocomplete="new-password"
              placeholder="Confirm password"
          /></label>
          <label class="field"
            >Admin key<input
              v-model="adminKey"
              required
              type="password"
              autocomplete="off"
              placeholder="Admin key"
          /></label>
          <p class="m-0 text-sm text-secondary">
            Find the key in <code>panel-data/admin-token</code> on the host. It
            is only needed when creating an account.
          </p>
        </template>
        <label v-else class="field"
          >Two-factor code or recovery code<input
            v-model="code"
            required
            autocomplete="one-time-code"
            placeholder="Authenticator or recovery code"
        /></label>
      </template>
      <Button
        native-type="submit"
        type="colored"
        color="green"
        :disabled="busy"
        >{{
          busy
            ? "Please wait…"
            : enrollment
              ? "Verify and create account"
              : mode === "login"
                ? "Sign in"
                : "Set up authenticator"
        }}</Button
      >
      <Button :disabled="busy" @click="switchMode">{{
        mode === "login" ? "Create an account" : "Back to sign in"
      }}</Button>
    </form>
  </section>
</template>
