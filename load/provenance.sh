# Sourced by load/run.sh: metadata for <run>-env.txt, so a result can be tied to the code and image
# it measured. Each function prints "name value" lines. A value that can't be determined is printed as
# "unknown", never as an empty field. Only bash builtins plus the named tools (git, docker, jq, free,
# nproc) are used, so tests/load-provenance.test.ts can run these with stubbed tools.

# meta CMD [ARGS...]: CMD's output, or "unknown" if CMD fails or prints nothing. CMD's stderr is
# left alone, so in load/run.sh the reason for an "unknown" lands in <run>-run.txt.
meta() {
  local value
  if value="$("$@")" && [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf 'unknown\n'
  fi
}

# git_provenance: the checkout in the current directory, at the moment it runs.
#   git_commit           HEAD's SHA
#   git_tracked_changes  tracked files modified or staged against HEAD (0 = the tracked tree is clean)
#   git_untracked_files  untracked files outside load/results/, where every run writes its own output
# All three are "unknown" if git is missing or this isn't a git checkout. GIT_OPTIONAL_LOCKS=0 keeps
# `git status` from refreshing the index, so recording this writes nothing to the repository.
git_provenance() {
  local status line tracked=0 untracked=0
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'git_commit unknown\ngit_tracked_changes unknown\ngit_untracked_files unknown\n'
    return 0
  fi
  printf 'git_commit %s\n' "$(meta git rev-parse --verify HEAD)"
  if status="$(GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=no 2>/dev/null)"; then
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then tracked=$((tracked + 1)); fi
    done <<<"$status"
    printf 'git_tracked_changes %s\n' "$tracked"
  else
    printf 'git_tracked_changes unknown\n'
  fi
  if status="$(GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all -- . ':(exclude)load/results' 2>/dev/null)"; then
    while IFS= read -r line; do
      if [[ "$line" == '??'* ]]; then untracked=$((untracked + 1)); fi
    done <<<"$status"
    printf 'git_untracked_files %s\n' "$untracked"
  else
    printf 'git_untracked_files unknown\n'
  fi
  return 0
}

# image_provenance CONTAINER: the image the container runs, and when that image was built.
# An image ID identifies the image, not the source it was built from: the build records no commit.
# Compare api_image_created with the git_* fields and with when the source last changed.
image_provenance() {
  local image
  image="$(meta docker inspect --format '{{.Image}}' "$1")"
  printf 'api_image %s\n' "$image"
  if [[ "$image" == unknown ]]; then
    printf 'api_image_created unknown\n'
  else
    printf 'api_image_created %s\n' "$(meta docker image inspect --format '{{.Created}}' "$image")"
  fi
}

# compose_image SERVICE: the image a Compose service (including the `load` profile) is configured with.
# Fails, so meta prints "unknown", if docker or jq fails or the service has no image.
compose_image() {
  local config image
  config="$(docker compose --profile load config --format json)" || return 1
  image="$(jq -r --arg service "$1" '.services[$service].image // empty' <<<"$config")" || return 1
  if [[ -z "$image" ]]; then return 1; fi
  printf '%s\n' "$image"
}

# host_memory: total RAM and swap in use, from `free -m`.
host_memory() {
  local mem
  mem="$(free -m 2>/dev/null | awk '/^Mem:/ { print "host_mem_total_mib " $2 } /^Swap:/ { print "host_swap_used_mib " $3 }')" || mem=""
  if [[ -n "$mem" ]]; then
    printf '%s\n' "$mem"
  else
    printf 'host_mem_total_mib unknown\nhost_swap_used_mib unknown\n'
  fi
}
