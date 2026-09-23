<script setup lang="ts">
import { ref } from "vue";
import Button from "#ui/components/base/buttons/Button.vue";
import { api, notice, username } from "./state";
const password = ref(""),
  newPassword = ref(""),
  confirm = ref(""),
  code = ref(""),
  busy = ref(false);
async function save() {
  busy.value = true;
  try {
    if (newPassword.value !== confirm.value)
      throw new Error("Passwords do not match.");
    await api("/account/password", {
      method: "POST",
      body: JSON.stringify({
        password: password.value,
        newPassword: newPassword.value,
        code: code.value,
      }),
    });
    password.value = "";
    newPassword.value = "";
    confirm.value = "";
    code.value = "";
    notice.value =
      "Password changed. Your other sessions have been signed out.";
  } catch (e) {
    notice.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form
    class="mx-auto mb-8 flex max-w-md flex-col gap-5 rounded-2xl bg-surface-2 p-8"
    @submit.prevent="save"
  >
    <h1 class="m-0 text-2xl font-bold text-contrast">Account security</h1>
    <p class="m-0">
      Signed in as <strong>{{ username }}</strong
      >. Two-factor authentication is enabled.
    </p>
    <label class="field"
      >Current password<input
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
    /></label>
    <label class="field"
      >New password<input
        v-model="newPassword"
        type="password"
        minlength="12"
        autocomplete="new-password"
        required
    /></label>
    <label class="field"
      >Confirm new password<input
        v-model="confirm"
        type="password"
        minlength="12"
        autocomplete="new-password"
        required
    /></label>
    <label class="field"
      >Two-factor code or recovery code<input
        v-model="code"
        autocomplete="one-time-code"
        required
    /></label>
    <Button native-type="submit" type="colored" color="green" :disabled="busy"
      >Change password</Button
    >
  </form>
</template>
