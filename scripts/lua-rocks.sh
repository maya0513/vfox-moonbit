#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$repository/lua-rocks.lock"
lua_root="$(mise where conda:lua)"
gcc_root="$(mise where conda:gcc)"
rt_libdir="${gcc_root}/x86_64-conda-linux-gnu/sysroot/lib64"
rock_command=(luarocks --lua-dir="$lua_root" --lua-version=5.1)
temporary=""

cleanup() {
  case "$temporary" in
    /tmp/vfox-moonbit-lua-rocks.* | /tmp/vfox-moonbit-lua-rocks-install.*)
      rm -rf -- "$temporary"
      ;;
    "") ;;
    *) echo "Refusing to remove unexpected temporary directory: $temporary" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ ! -f "${rt_libdir}/librt.a" ]]; then
  echo "Pinned Lua test bootstrap currently requires Linux x86_64." >&2
  exit 1
fi

file_hash() {
  node --input-type=module - "$1" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const path = process.argv[2];
if (path === undefined) throw new Error('file path is required');
console.log(createHash('sha256').update(await readFile(path)).digest('hex'));
NODE
}

tree_hash() {
  node --input-type=module - "$1" <<'NODE'
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const paths = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else paths.push(path);
  }
}
await visit(root);
paths.sort((left, right) => Buffer.compare(Buffer.from(relative(root, left)), Buffer.from(relative(root, right))));
const hash = createHash('sha256');
for (const path of paths) {
  const name = relative(root, path).replaceAll('\\', '/');
  const stats = await lstat(path);
  if (stats.isFile()) {
    hash.update(`file\0${name}\0`);
    hash.update(await readFile(path));
  } else if (stats.isSymbolicLink()) {
    hash.update(`link\0${name}\0${await readlink(path)}\0`);
  } else {
    throw new Error(`unsupported source entry: ${name}`);
  }
  hash.update('\0');
}
console.log(hash.digest('hex'));
NODE
}

INSPECT_ROCKSPEC_HASH=""
INSPECT_TREE_HASH=""
INSPECT_SOURCE_DIR=""
INSPECT_SOURCE_SPEC=""

inspect_rock() {
  local name="$1"
  local version="$2"
  local destination="$3"
  local expected_rockspec_hash="${4:-}"
  mkdir -p "$destination"
  (
    cd "$destination"
    "${rock_command[@]}" download --rockspec "$name" "$version" >/dev/null
  )
  local rockspec="$destination/$name-$version.rockspec"
  if [[ ! -f "$rockspec" ]]; then
    echo "LuaRocks did not download the expected rockspec: $name $version" >&2
    exit 1
  fi
  INSPECT_ROCKSPEC_HASH="$(file_hash "$rockspec")"
  if [[ -n "$expected_rockspec_hash" && "$INSPECT_ROCKSPEC_HASH" != "$expected_rockspec_hash" ]]; then
    echo "Lua rockspec verification failed before unpacking: $name $version" >&2
    exit 1
  fi
  (
    cd "$destination"
    "${rock_command[@]}" unpack "$rockspec" >/dev/null
  )
  local unpack_root="$destination/$name-$version"
  # LuaRocks copies the recipe into the immediate source directory. Repositories
  # can also contain older/nested copies; traversal order must not select those.
  INSPECT_SOURCE_SPEC="$(find "$unpack_root" -mindepth 2 -maxdepth 2 -type f -name "$name-$version.rockspec" -print -quit)"
  if [[ -z "$INSPECT_SOURCE_SPEC" ]]; then
    echo "LuaRocks did not unpack an embedded rockspec: $name $version" >&2
    exit 1
  fi
  INSPECT_SOURCE_DIR="$(dirname "$INSPECT_SOURCE_SPEC")"
  INSPECT_TREE_HASH="$(tree_hash "$INSPECT_SOURCE_DIR")"
}

latest_compatible() {
  local name="$1"
  local pattern="$2"
  local version
  version="$("${rock_command[@]}" search --porcelain "$name" | awk -F '\t' -v name="$name" -v pattern="$pattern" '$1 == name && $2 ~ pattern { print $2; exit }')"
  if [[ -z "$version" ]]; then
    echo "No compatible Lua rock found for $name ($pattern)" >&2
    exit 1
  fi
  printf '%s\n' "$version"
}

update_lock() {
  temporary="$(mktemp -d /tmp/vfox-moonbit-lua-rocks.XXXXXX)"
  local resolution_tree="$temporary/tree"
  local busted_version luacov_version luacheck_version
  busted_version="$(latest_compatible busted '^2\.')"
  luacov_version="$(latest_compatible luacov '^0\.16\.')"
  luacheck_version="$(latest_compatible luacheck '^1\.')"

  for specification in "busted $busted_version" "luacov $luacov_version" "luacheck $luacheck_version"; do
    read -r name version <<<"$specification"
    "${rock_command[@]}" --tree="$resolution_tree" install "$name" "$version" \
      --deps-mode=one RT_LIBDIR="$rt_libdir" >/dev/null
  done

  declare -A versions=()
  while IFS= read -r record; do
    local name="${record%%/*}"
    local version="${record#*/}"
    versions["$name"]="$version"
  done < <(find "$resolution_tree/lib/luarocks/rocks-5.1" -mindepth 2 -maxdepth 2 -type d -printf '%P\n' | sort)

  declare -A states=()
  local -a order=()
  visit() {
    local name="$1"
    if [[ "${states[$name]:-}" == "done" ]]; then return; fi
    if [[ "${states[$name]:-}" == "visiting" ]]; then
      echo "Lua rock dependency cycle contains $name" >&2
      exit 1
    fi
    states["$name"]="visiting"
    local line dependency
    while IFS= read -r line; do
      dependency="${line%% *}"
      if [[ -n "${versions[$dependency]+present}" ]]; then visit "$dependency"; fi
    done < <("${rock_command[@]}" --tree="$resolution_tree" show --deps --porcelain "$name" "${versions[$name]}")
    states["$name"]="done"
    order+=("$name")
  }
  for name in busted luacov luacheck; do visit "$name"; done

  declare -A previous_version=()
  declare -A previous_rockspec=()
  declare -A previous_tree=()
  while read -r name version rockspec_hash source_hash extra; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    if [[ -n "${extra:-}" ]]; then
      echo "Malformed Lua rock lock record: $name" >&2
      exit 1
    fi
    previous_version["$name"]="$version"
    previous_rockspec["$name"]="${rockspec_hash:-}"
    previous_tree["$name"]="${source_hash:-}"
  done < "$lock_file"

  local generated="$temporary/lua-rocks.lock"
  printf '# Generated by scripts/lua-rocks.sh update. Dependency order is significant.\n' > "$generated"
  for name in "${order[@]}"; do
    local version="${versions[$name]}"
    inspect_rock "$name" "$version" "$temporary/source-$name"
    if [[ "${previous_version[$name]:-}" == "$version" && -n "${previous_rockspec[$name]:-}" ]]; then
      if [[ "${previous_rockspec[$name]}" != "$INSPECT_ROCKSPEC_HASH" || "${previous_tree[$name]}" != "$INSPECT_TREE_HASH" ]]; then
        echo "Immutable Lua rock content changed: $name $version" >&2
        exit 1
      fi
    fi
    printf '%s %s %s %s\n' "$name" "$version" "$INSPECT_ROCKSPEC_HASH" "$INSPECT_TREE_HASH" >> "$generated"
  done
  mv "$generated" "$lock_file"
}

install_lock() {
  local tree="$repository/.rocks/5.1"
  local marker="$tree/.vfox-moonbit-lock-sha256"
  local lock_hash
  lock_hash="$(file_hash "$lock_file")"
  if [[ -f "$marker" && "$(<"$marker")" == "$lock_hash" ]]; then return; fi
  if [[ "$tree" != "$repository/.rocks/5.1" ]]; then
    echo "Refusing to replace unexpected Lua rock tree: $tree" >&2
    exit 1
  fi
  rm -rf -- "$tree"
  mkdir -p "$tree"
  temporary="$(mktemp -d /tmp/vfox-moonbit-lua-rocks-install.XXXXXX)"
  local count=0
  while read -r name version rockspec_hash source_hash extra; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    if [[ -n "${extra:-}" || ! "$rockspec_hash" =~ ^[0-9a-f]{64}$ || ! "$source_hash" =~ ^[0-9a-f]{64}$ ]]; then
      echo "Malformed Lua rock lock record: $name" >&2
      exit 1
    fi
    inspect_rock "$name" "$version" "$temporary/$count-$name" "$rockspec_hash"
    if [[ "$rockspec_hash" != "$INSPECT_ROCKSPEC_HASH" || "$source_hash" != "$INSPECT_TREE_HASH" ]]; then
      echo "Lua rock content verification failed: $name $version" >&2
      exit 1
    fi
    (
      cd "$INSPECT_SOURCE_DIR"
      "${rock_command[@]}" --tree="$tree" make "$INSPECT_SOURCE_SPEC" \
        --deps-mode=none RT_LIBDIR="$rt_libdir" >/dev/null
    )
    count=$((count + 1))
  done < "$lock_file"
  printf '%s\n' "$lock_hash" > "$marker"
}

case "${1:-}" in
  update) update_lock ;;
  install) install_lock ;;
  *) echo "usage: scripts/lua-rocks.sh update|install" >&2; exit 2 ;;
esac
