#!/usr/bin/env bash
# Run as the Linux account that owns Moss, never as root.
set -Eeuo pipefail

if [[ ${1:-} == --help ]]; then
  cat <<'HELP'
Usage: ./setup.sh
Run from a cloned Moss repository as its non-root Linux owner.
Requires Node.js 22+, npm, Git, Java and a working user systemd session.
Installs npm dependencies, builds Moss, creates/reuses the user service,
enables startup at boot (sudo may be needed for lingering), and starts Moss.
An existing service must already point at this clone; its settings are kept.
Running Minecraft servers are gracefully stopped when the service is stopped.

Fresh service settings (environment variables):
  MOSS_SERVICE_NAME=serverui.service  Service name (also used on repeat runs)
  HOST=127.0.0.1 PORT=3000           HTTP listener
  DATA_DIR=<clone>/panel-data        Persistent data directory
  JAVA_BIN=<detected java>           Java executable
  SECURE_COOKIE=false               Set true behind an HTTPS reverse proxy
  AUTO_UPDATE=false                 Opt in to automatic main-branch updates
Existing service settings and drop-ins take precedence and are not rewritten.
The script does not configure HTTPS, DNS, firewall rules or Minecraft software.
HELP
  exit 0
fi
[[ $# == 0 ]] || { echo 'Use ./setup.sh --help for usage.' >&2; exit 1; }
fail() { echo "Moss setup: $*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'This setup script requires Linux with systemd.'
[[ $EUID != 0 ]] || fail 'Run ./setup.sh as your regular server account, not sudo ./setup.sh.'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$repo"
for tool in node npm git systemctl loginctl; do
  command -v "$tool" >/dev/null || fail "Install $tool first, then rerun setup."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' ||
  fail 'Node.js 22 or newer is required. Upgrade Node (24 LTS recommended), then rerun setup.'
node_bin=$(command -v node)
java_bin=$(command -v "${JAVA_BIN:-java}") || fail 'Install Java appropriate for your Minecraft version, or set JAVA_BIN.'
"$java_bin" -version >/dev/null 2>&1 || fail 'Java could not run.'
service=${MOSS_SERVICE_NAME:-serverui.service}
[[ $service =~ ^[a-zA-Z0-9_-]+\.service$ ]] || fail 'Invalid MOSS_SERVICE_NAME.'
systemctl --user show-environment >/dev/null || fail 'No user systemd session. Connect by SSH as the server account and retry.'
[[ -f package-lock.json && -f server/main.js ]] || fail 'Incomplete Moss checkout.'
load_state=$(systemctl --user show "$service" --property=LoadState --value)
existing=false
if [[ $load_state != not-found && -n $load_state ]]; then
  [[ $load_state == loaded ]] || fail "The existing $service is not loadable; fix it before setup."
  existing=true
  working_dir=$(systemctl --user show "$service" --property=WorkingDirectory --value)
  resolved_working_dir=$(cd -- "$working_dir" 2>/dev/null && pwd -P) || resolved_working_dir=$working_dir
  [[ $resolved_working_dir == "$repo" ]] || fail "Existing $service uses $working_dir. Migrate its data/service to $repo first; setup will not guess a migration."
fi
# Validate/prepare a fresh unit before stopping anything. Node handles systemd quoting.
unit_tmp=$(mktemp)
trap 'rm -f -- "$unit_tmp"' EXIT
if [[ $existing == false ]]; then
  MOSS_SETUP_REPO="$repo" MOSS_SETUP_NODE="$node_bin" MOSS_SETUP_JAVA="$java_bin" MOSS_SETUP_SERVICE="$service" node --input-type=module > "$unit_tmp" <<'JS'
import path from 'node:path';
const env = process.env;
const quote = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Newlines/NUL are not supported in service settings.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
};
const repo = env.MOSS_SETUP_REPO;
const port = env.PORT || '3000';
if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) throw new Error('PORT must be 1024–65535.');
for (const key of ['SECURE_COOKIE', 'AUTO_UPDATE'])
  if (env[key] && !['true','false'].includes(env[key])) throw new Error(`${key} must be true or false.`);
const settings = {
  NODE_ENV: 'production', HOST: env.HOST || '127.0.0.1', PORT: port,
  DATA_DIR: path.resolve(repo, env.DATA_DIR || 'panel-data'),
  JAVA_BIN: env.MOSS_SETUP_JAVA, SECURE_COOKIE: env.SECURE_COOKIE || 'false',
  AUTO_UPDATE: env.AUTO_UPDATE || 'false', MOSS_SERVICE_NAME: env.MOSS_SETUP_SERVICE,
  PATH: env.PATH,
};
console.log(`[Unit]
Description=Moss Minecraft management
After=network.target

[Service]
WorkingDirectory=${quote(repo)}
ExecStart=${quote(env.MOSS_SETUP_NODE).replaceAll('$', '$$')} ${quote(path.join(repo, 'server/main.js')).replaceAll('$', '$$')}
${Object.entries(settings).map(([key,value]) => 'Environment=' + quote(`${key}=${value}`)).join('\n')}
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target`);
JS
fi
if systemctl --user is-active --quiet moss-update.service; then
  fail 'An automatic update is running. Wait until it finishes, then rerun setup.'
fi
# Do this before stopping Moss: a denied sudo request must leave it running.
if [[ $(loginctl show-user "$(id -un)" --property=Linger --value) != yes ]]; then
  if ! loginctl enable-linger "$(id -un)"; then
    command -v sudo >/dev/null || fail 'Ask an administrator to enable user lingering with loginctl enable-linger.'
    sudo loginctl enable-linger "$(id -un)"
  fi
fi
if [[ $existing == true ]]; then
  echo "Stopping $service gracefully (running Minecraft servers will stop too)…"
  systemctl --user stop "$service"
fi
echo 'Installing dependencies and building Moss…'
if ! npm ci --include=dev || ! npm run build; then
  fail "Build failed. Existing data and service configuration are untouched. Resolve the error and rerun ./setup.sh; Moss has not been started."
fi
if [[ $existing == false ]]; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p -- "$unit_dir"
  install -m 600 "$unit_tmp" "$unit_dir/$service"
fi
systemctl --user daemon-reload
systemctl --user enable "$service"
systemctl --user start "$service"
# Read effective settings, including any pre-existing service drop-ins.
effective_env=$(systemctl --user show "$service" --property=Environment --value)
echo "Started $service. Checking HTTP health…"
echo "If startup fails, inspect: journalctl --user -u $service -n 100 --no-pager"
MOSS_EFFECTIVE_ENV="$effective_env" node --input-type=module <<'JS'
// systemctl quotes assignments containing spaces. HOST/PORT cannot contain spaces.
const text = process.env.MOSS_EFFECTIVE_ENV;
const read = (name, fallback) => {
  const matches = [...text.matchAll(new RegExp('(?:^|\\s)"?' + name + '=([^"\\s]+)', 'g'))];
  return matches.at(-1)?.[1] || fallback;
};
let host = read('HOST', '127.0.0.1');
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
const url = `http://${host}:${read('PORT', '3000')}`;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json()).application === 'Moss') {
      console.log(`Moss is responding at ${url} on this server.`);
      process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.error('Moss did not pass its health check. Check the service journal shown below.');
process.exitCode = 1;
JS
systemctl --user is-active --quiet "$service" || fail "Service is not active. Run: journalctl --user -u $service -n 100 --no-pager"
echo "Setup complete. Existing accounts and worlds are preserved."
echo "Logs: journalctl --user -u $service -n 100 --no-pager"
echo 'Use your existing HTTPS address if configured. Start your Minecraft servers again in Moss.'
