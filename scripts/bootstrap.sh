#!/usr/bin/env bash
set -euo pipefail

uv sync --frozen

gcc_root="$(mise where conda:gcc@16.2.0)"
rt_libdir="${gcc_root}/x86_64-conda-linux-gnu/sysroot/lib64"
if [[ ! -f "${rt_libdir}/librt.a" ]]; then
  echo "Pinned Lua test bootstrap currently requires Linux x86_64." >&2
  exit 1
fi

mapfile -t rock_specs < lua-rocks.lock

for lua_version in 5.1.5 5.4.8; do
  tree=".rocks/${lua_version%.*}"
  lua_root="$(mise where "conda:lua@${lua_version}")"
  for specification in "${rock_specs[@]}"; do
    [[ -z "$specification" || "$specification" == \#* ]] && continue
    rock="${specification%% *}"
    version="${specification#* }"
    mise exec conda:gcc@16.2.0 "conda:lua@${lua_version}" conda:luarocks@3.13.0 -- \
      luarocks --lua-dir="$lua_root" --lua-version="${lua_version%.*}" --tree="$tree" \
      install "$rock" "$version" --deps-mode=none RT_LIBDIR="$rt_libdir" </dev/null
  done
done
