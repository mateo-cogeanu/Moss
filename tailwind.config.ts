import preset from "./vendor/modrinth/packages/tooling-config/tailwind/tailwind-preset";
export default {
  presets: [preset],
  content: [
    "./index.html",
    "./web/**/*.{vue,ts}",
    "./vendor/modrinth/packages/ui/src/**/*.{vue,ts}",
  ],
};
