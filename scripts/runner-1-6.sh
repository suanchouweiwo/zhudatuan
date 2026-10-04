#!/usr/bin/env bash
# Shared Runner 1.7 execution core. Both Aliyun and GitHub Hosted runners invoke this file.
set -euo pipefail

operation="${1:?operation required}"
control_root="${CONTROL_ROOT:?CONTROL_ROOT required}"
source_root="${SOURCE_ROOT:-}"
instance_path="${INSTANCE_PATH:-}"
identifier="${RELEASE_IDENTIFIER:-}"
target="${RELEASE_TARGET:-}"
node="${PHYSICAL_NODE:-}"

if [ -n "$instance_path" ] && [ -n "$source_root" ]; then
  export LK_INSTANCE_ROOT="${source_root%/}/${instance_path#/}"
fi

ssh_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zdt-runner-1-6-ssh.XXXXXX")"
cleanup() {
  rm -f -- "$ssh_dir/zdt_release" "$ssh_dir/known_hosts"
  rmdir "$ssh_dir" 2>/dev/null || true
}
trap cleanup EXIT

install -m 600 "$control_root/02_platform_pingtai/infrastructure/release/zdt-next.ssh-known-hosts" "$ssh_dir/known_hosts"
export ZDT_RELEASE_KNOWN_HOSTS_PATH="$ssh_dir/known_hosts"
if [ -n "${ZDT_RELEASE_SSH_KEY:-}" ]; then
  printf '%s\n' "$ZDT_RELEASE_SSH_KEY" > "$ssh_dir/zdt_release"
  chmod 600 "$ssh_dir/zdt_release"
  export ZDT_RELEASE_SSH_KEY_PATH="$ssh_dir/zdt_release"
fi

args=("$operation" --control-root "$control_root")
if [ -n "$source_root" ]; then args+=(--source-root "$source_root"); fi
if [ -n "$identifier" ]; then args+=(--identifier "$identifier"); fi
if [ -n "$target" ]; then args+=(--target "$target"); fi
if [ -n "$node" ]; then args+=(--node "$node"); fi
node "$control_root/04_tools/release-engine/runner-1-6.mjs" "${args[@]}"
