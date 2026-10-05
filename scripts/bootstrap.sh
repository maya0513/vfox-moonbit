#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile

gcc_root="$(mise where conda:gcc)"
rt_libdir="${gcc_root}/x86_64-conda-linux-gnu/sysroot/lib64"
if [[ ! -f "${rt_libdir}/librt.a" ]]; then
  echo "Pinned Lua test bootstrap currently requires Linux x86_64." >&2
  exit 1
fi

mapfile -t rock_specs < lua-rocks.lock

minor=5.1
tree=".rocks/${minor}"
lua_root="$(mise where conda:lua)"
for specification in "${rock_specs[@]}"; do
  [[ -z "$specification" || "$specification" == \#* ]] && continue
  rock="${specification%% *}"
  version="${specification#* }"
  if luarocks --lua-dir="$lua_root" --lua-version="${minor}" --tree="$tree" \
    show "$rock" "$version" >/dev/null 2>&1; then
    continue
  fi
  luarocks --lua-dir="$lua_root" --lua-version="${minor}" --tree="$tree" \
    install "$rock" "$version" --deps-mode=none RT_LIBDIR="$rt_libdir" </dev/null
done
