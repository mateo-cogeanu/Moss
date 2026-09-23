import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { installTooltipDirective } from "#ui/providers/tooltip";
import { notice } from "./state";
import App from "./App.vue";
import Overview from "./Overview.vue";
import Content from "./Content.vue";
import Installation from "./Installation.vue";
import Files from "./Files.vue";
import Backups from "./Backups.vue";
import Settings from "./Settings.vue";
import "./style.scss";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@xterm/xterm/css/xterm.css";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: { template: "<div />" } },
    { path: "/server/:id", component: Overview },
    { path: "/server/:id/files", component: Files },
    { path: "/server/:id/content", component: Content },
    { path: "/server/:id/installation", component: Installation },
    { path: "/server/:id/backups", component: Backups },
    { path: "/server/:id/settings", component: Settings },
  ],
});
const app = createApp(App);
app.config.errorHandler = (error) => {
  notice.value = error instanceof Error ? error.message : String(error);
};
app.use(router);
app.use(VueQueryPlugin);
installTooltipDirective(app);
app.mount("#app");
