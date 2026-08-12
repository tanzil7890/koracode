#!/bin/sh
#
# BrowserCode installer — serve-only build. Hosted at https://bcode.sh/bytecode,
# alongside (not replacing) https://bcode.sh/install, which stays the path for
# the full CLI.
#
#   curl -fsSL https://bcode.sh/bytecode | sh -s -- --no-modify-path --version 0.1.19
#
# Installs `bcode-linux-<arch>[-musl]-serve`, which provides ONLY `bcode serve`;
# run, tui, web, github and the rest are absent and exit 1. It exists for headless
# containers.
#
# POSIX sh, not bash: Alpine is a supported target here and ships no bash.
set -eu

REPO=browser-use/browsercode
DIM='\033[0;2m'
RED='\033[0;31m'
OFF='\033[0m'

say() { printf "${DIM}%s${OFF}\n" "$1" >&2; }
die() {
  printf "${RED}%s${OFF}\n" "$1" >&2
  shift
  for line in "$@"; do [ -n "$line" ] && printf "${DIM}%s${OFF}\n" "$line" >&2; done
  exit 1
}

# Reject empty and flag-shaped values: `--version "$UNSET"` would otherwise
# silently install latest, which is exactly what pinning exists to prevent.
need() {
  case $2 in
    "" | -*) die "$1 needs a value (got: ${2:-<missing>})" ;;
  esac
}

usage() {
  cat >&2 <<EOF
BrowserCode installer (serve-only build)

  -v, --version <ver>    version to install (default: latest release)
      --install-dir <d>  where to install (default: \$HOME/.bcode/bin)
      --no-modify-path   accepted for install.sh parity; this script never edits
                         shell config files
  -h, --help             show this help

Installs a bcode that provides ONLY 'bcode serve'.
For the full CLI: curl -fsSL https://bcode.sh/install | bash
EOF
}

# Namespaced on purpose: a bare VERSION is a common Dockerfile ARG, and picking
# it up here would silently install the wrong build.
version=${BCODE_VERSION:-}
# HOME is routinely unset under `--user`/runAsUser with no passwd entry.
install_dir=${BCODE_INSTALL_DIR:-${HOME:-/root}/.bcode/bin}

while [ $# -gt 0 ]; do
  case $1 in
    -v | --version) need "--version" "${2:-}"; version=$2; shift 2 ;;
    --install-dir) need "--install-dir" "${2:-}"; install_dir=$2; shift 2 ;;
    --no-modify-path) shift ;;
    # Tolerated: wrappers relaying args often forward an extra one.
    --) shift ;;
    -h | --help) usage; exit 0 ;;
    # Fail rather than warn: a typo'd flag would otherwise quietly install
    # "latest" into a build that meant to pin a version.
    *) die "Unknown option: $1" "Run with --help for usage." ;;
  esac
done

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not installed."
done

[ "$(uname -s)" = Linux ] || die \
  "The serve build is published for linux only (got $(uname -s))." \
  "Use https://bcode.sh/install for the standard cross-platform binary."

case $(uname -m) in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "Unsupported architecture: $(uname -m)." "Supported: arm64, x64." ;;
esac

# Non-baseline x64 builds need AVX2 and no baseline serve asset is published.
# Only decide when /proc/cpuinfo actually carries a flags line: emulated or
# redacted cpuinfo (qemu `--platform linux/amd64` on arm64, lxcfs, some
# hypervisors) has none, and unknown is not the same as absent.
if [ "$arch" = x64 ] && grep -qi '^flags' /proc/cpuinfo 2>/dev/null && ! grep -qwi avx2 /proc/cpuinfo; then
  die "This CPU has no AVX2 and no baseline serve build is published." \
    "Use https://bcode.sh/install, which ships a baseline binary."
fi

# A glibc binary cannot exec on musl. musl's ldd prints its banner and then exits
# non-zero, so match its output — the pipeline's status is grep's, not ldd's.
target=linux-$arch
if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
  target=$target-musl
fi
asset=bcode-$target-serve.tar.gz

if [ -n "$version" ]; then
  version=${version#v}
else
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
  [ -n "$version" ] || die "Could not resolve the latest version." "Pin one with --version <ver>."
fi
url=https://github.com/$REPO/releases/download/v$version/$asset

say "Installing bcode $version ($target, serve build)"

tmp=$(mktemp -d)
staged=
# `return 0` is load-bearing: the `&&` above it returns 1 whenever staged is
# empty, which under `set -e` would turn a clean run into a non-zero exit.
cleanup() {
  rm -rf "$tmp"
  [ -n "$staged" ] && rm -f "$staged"
  return 0
}
trap cleanup EXIT
# ash/dash do not run the EXIT trap on a signal; `docker build` cancellation
# sends TERM. Exiting from the handler routes through the EXIT trap above.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

curl -fsSL -o "$tmp/$asset" "$url" || die \
  "Could not download $asset for v$version." \
  "URL: $url" \
  "Releases published before this variant existed do not carry the asset."

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/bcode" ] || die "Archive did not contain a bcode binary."

# Stage inside the install dir, validate, then swap. Validating first means a bad
# download never replaces a working bcode; staging here rather than in /tmp avoids
# requiring an exec-capable /tmp (noexec there is common hardening) and makes the
# final step a same-filesystem rename, so the swap is atomic.
case $install_dir in
  "") die "Install directory cannot be empty." ;;
  -*) die "Install directory must not start with '-' (got: $install_dir)." ;;
esac
mkdir -p -- "$install_dir"
if [ -d "$install_dir/bcode" ]; then
  die "$install_dir/bcode is a directory; refusing to install over it."
fi
staged=$(mktemp "$install_dir/.bcode.XXXXXX")
mv "$tmp/bcode" "$staged"
chmod 755 "$staged"

# Keep the binary's own stderr: on a libc mismatch it names the missing loader,
# which is the actual diagnosis.
if ! installed=$("$staged" --version 2>"$tmp/err"); then
  die "Downloaded binary failed to run; existing install left untouched." \
    "$(cat "$tmp/err" 2>/dev/null)" \
    "If $install_dir is mounted noexec, pass --install-dir."
fi

mv "$staged" "$install_dir/bcode"
staged=

say "Installed $install_dir/bcode ($installed) — provides 'bcode serve' only"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) say "Not on PATH. Add it with: export PATH=\"$install_dir:\$PATH\"" ;;
esac
