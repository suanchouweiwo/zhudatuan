#!/usr/bin/env bash
# Runner 1.7 control-side dispatcher. No build, package, upload, deploy, or rollback runs here.
set -euo pipefail

operation="${1:-}"
identifier=''
target=''
physical_node=''
instance_path="${ZDT_INSTANCE_PATH:-}"
case "$operation" in
  release|status)
    if [ "$operation" = release ]; then
      { [ "$#" -ge 2 ] && [ "$(( ($# - 2) % 2 ))" -eq 0 ]; } || { echo 'Usage: delivery-dispatch.sh release <source-sha-or-release-id> [target physical-node ...]' >&2; exit 64; }
    else
      { [ "$#" -eq 1 ] || [ "$#" -eq 2 ]; } || { echo 'Usage: delivery-dispatch.sh status [source-sha-or-release-id]' >&2; exit 64; }
    fi
    identifier="${2:-}"
    { [ "$operation" = status ] && [ -z "$identifier" ]; } || [[ "$identifier" =~ ^[0-9a-f]{40}$ || "$identifier" =~ ^r16-[0-9a-f]{40}$ ]] \
      || { echo "$operation requires a full lowercase Source SHA or r16 release id" >&2; exit 64; }
    ;;
  retry)
    { [ "$#" -ge 2 ] && [ "$(( ($# - 2) % 2 ))" -eq 0 ]; } || { echo 'Usage: delivery-dispatch.sh retry <r16-release-id> [target physical-node ...]' >&2; exit 64; }
    identifier="$2"
    [[ "$identifier" =~ ^r16-[0-9a-f]{40}$ ]] \
      || { echo 'retry requires an r16 release id' >&2; exit 64; }
    ;;
  rollback)
    [ "$#" -eq 3 ] || { echo 'Usage: delivery-dispatch.sh rollback <target> <physical-node>' >&2; exit 64; }
    target="$2"
    physical_node="$3"
    ;;
  *) echo 'Runner 1.7 operations: release, status, retry, rollback' >&2; exit 64 ;;
esac

if { [ "$operation" = release ] || [ "$operation" = retry ]; } && [ "$#" -gt 2 ]; then
  arguments=("$@")
  for ((index = 2; index < ${#arguments[@]}; index += 2)); do
    [ -z "$target" ] || target+=','
    [ -z "$physical_node" ] || physical_node+=','
    target+="${arguments[index]}"
    physical_node+="${arguments[index + 1]}"
  done
fi

workflow='delivery-1-6.yml'
previous_id="$(gh run list --workflow "$workflow" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
echo "Runner 1.7 ${operation}: ${identifier:-${physical_node}/${target}}"
run_id=''
dispatch_run() {
  local after_id="$1"
  local execution_location="$2"
  local dispatch_output
  local request_id
  local dispatch_args
  request_id="$(od -An -N12 -tx1 /dev/urandom | tr -d '[:space:]')"
  dispatch_args=(workflow run "$workflow" --ref zdt-next
    -f operation="$operation" -f identifier="$identifier" -f release_target="$target" -f physical_node="$physical_node"
    -f execution_location="$execution_location" -f request_id="$request_id")
  if [ -n "$instance_path" ]; then dispatch_args+=(-f instance_path="$instance_path"); fi
  dispatch_output="$(gh "${dispatch_args[@]}")"
  [ -z "$dispatch_output" ] || printf '%s\n' "$dispatch_output"
  echo '状态：QUEUED'
  run_id=''
  if [[ "$dispatch_output" =~ /actions/runs/([0-9]+) ]]; then
    run_id="${BASH_REMATCH[1]}"
  else
    for attempt in {1..30}; do
      run_id="$(gh run list --workflow "$workflow" --event workflow_dispatch --limit 30 --json databaseId,displayTitle \
        --jq ".[] | select(.databaseId > ${after_id} and (.displayTitle | startswith(\"Runner 1.7 [${request_id}] \"))) | .databaseId" | head -1)"
      [ -z "$run_id" ] || break
      sleep "$(( attempt < 3 ? attempt : 3 ))"
    done
  fi
  [ -n "$run_id" ] || { echo 'Request was dispatched but its GitHub run was not found.' >&2; exit 1; }
}

dispatch_run "$previous_id" auto
case "$operation" in
  rollback) echo "Rollback run: $run_id" ;;
  *) echo "Release id: $identifier" ;;
esac
echo "GitHub run: $run_id"
echo '状态：RUNNING'

# Runner availability can change after routing. First wait for the route to
# exist; then bound both queue wait and pre-core setup wait.
for attempt in {1..30}; do
  execute_name="$(gh run view "$run_id" --json jobs --jq '.jobs[]? | select(.name | startswith("Execute on ")) | .name' | head -1)"
  [ -z "$execute_name" ] || break
  sleep 2
done
if [[ "${execute_name:-}" == 'Execute on '* && "$execute_name" != 'Execute on github-hosted' ]]; then
  queue_wait_started="$SECONDS"
  for attempt in {1..30}; do
    observation="$(gh run view "$run_id" --json status,jobs --jq '
      [
        (.status // ""),
        ([.jobs[]?.steps[]? | select(.startedAt != null and .name == "Mark shared release core started")] | length),
        ([.jobs[]? | select(.name | startswith("Execute on ")) | select(.name != "Execute on github-hosted") | .steps[]? | select(.startedAt != null)] | length)
      ] | @tsv
    ')"
    IFS=$'\t' read -r run_status core_steps started_steps <<< "$observation"
    [ "${core_steps:-0}" -gt 0 ] && break
    [ "$run_status" = completed ] && break
    [ "${started_steps:-0}" -eq 0 ] && [ "$((SECONDS - queue_wait_started))" -ge "${ZDT_DELIVERY_QUEUE_WAIT_SECONDS:-20}" ] && break
    sleep 2
  done
fi

if [[ "${execute_name:-}" == 'Execute on '* && "$execute_name" != 'Execute on github-hosted' ]] && [ "${core_steps:-0}" -eq 0 ] && [ "${run_status:-}" != completed ]; then
  self_hosted_failed="$(gh run view "$run_id" --json jobs --jq '[.jobs[]? | select((.name | startswith("Execute on ") and . != "Execute on github-hosted") and .conclusion == "failure")] | length')"
  if [ "${self_hosted_failed:-0}" -gt 0 ]; then
    echo '自建 Runner 任务已失败；等待同一次 GitHub 运行中的 Hosted 接管。'
  else
    self_hosted_run_id="$run_id"
    echo '自建 Runner 未及时进入发布核心；仅取消尚未开始核心的运行。'
    gh run cancel "$self_hosted_run_id" >/dev/null
    for attempt in {1..30}; do
      run_status="$(gh run view "$self_hosted_run_id" --json status --jq .status)"
      [ "$run_status" = completed ] && break
      sleep 1
    done
    [ "${run_status:-}" = completed ] || { echo 'Self-hosted run cancellation was not confirmed; Hosted fallback was not started.' >&2; exit 1; }
    core_steps="$(gh run view "$self_hosted_run_id" --json jobs --jq '[.jobs[].steps[]? | select(.startedAt != null and .name == "Mark shared release core started")] | length')"
    [ "${core_steps:-0}" -eq 0 ] || { echo 'The shared core started before cancellation; Hosted fallback was not started.' >&2; exit 1; }
    dispatch_run "$self_hosted_run_id" github-hosted
    echo "Hosted fallback run: $run_id"
  fi
fi

watch_status=0
gh run watch "$run_id" --exit-status || watch_status=$?
if [ "$watch_status" -ne 0 ]; then
  hosted_success="$(gh run view "$run_id" --json jobs --jq '[.jobs[]? | select(.name == "Retry pre-core startup on GitHub Hosted" and .conclusion == "success")] | length' 2>/dev/null || true)"
  if [ "$hosted_success" = 1 ]; then
    echo '阿里云启动失败，但同一次运行的 Hosted 接管已成功；以目标机回执为准。'
    watch_status=0
  fi
fi
run_log="$(gh run view "$run_id" --log 2>/dev/null || true)"
printf '%s\n' "$run_log" | node scripts/delivery-timings.mjs log "${ZDT_DELIVERY_STARTED_MS:-}" "$operation" \
  || printf '%s\n' "$run_log" | sed -n '/RUNNER_1_6_RESULT=/p' | tail -1
gh run view "$run_id" --json createdAt,jobs | node scripts/delivery-timings.mjs || echo 'DELIVERY_PRE_CORE_TIMINGS=unavailable'
finished_ms="$(($(date +%s) * 1000))"
end_to_end_ms="$((finished_ms - ${ZDT_DELIVERY_STARTED_MS:-finished_ms}))"
printf 'DELIVERY_COMMAND_RETURN_MS=%s\n' "$end_to_end_ms"
exit "$watch_status"
