#!/usr/bin/env bash
#
# capture-with-mitmproxy.sh — HTTPS traffic capture wrapper
#
# Starts a local mitmproxy (mitmdump) instance, routes the child command's
# traffic through it, and writes the captured flows to a binary .flow file.
# Useful for comparing request/response differences between CLI tools
# (e.g. claude vs opencode).
#
# ── Prerequisites ──────────────────────────────────────────────────────
#
#   1. Install mitmproxy:
#
#        brew install mitmproxy          # macOS
#        pipx install mitmproxy          # or via pip/pipx
#
#   2. Generate and trust the CA certificate:
#
#      a) Run mitmdump once so it creates ~/.mitmproxy/mitmproxy-ca-cert.pem:
#
#           mitmdump              # then Ctrl-C after it starts
#
#      b) Trust the cert in the macOS system keychain:
#
#           sudo security add-trusted-cert -d -r trustRoot \
#             -k /Library/Keychains/System.keychain \
#             ~/.mitmproxy/mitmproxy-ca-cert.pem
#
#         Or open Keychain Access, import the cert, and set it to
#         "Always Trust".
#
#      The script also sets NODE_EXTRA_CA_CERTS so Node-based CLIs
#      (claude, opencode) trust the cert without system-level trust,
#      but browser-based OAuth flows still need the system trust step.
#
# ── Usage ──────────────────────────────────────────────────────────────
#
#   ./scripts/capture-with-mitmproxy.sh [options] -- <command> [args...]
#
#   Capture Claude Code traffic:
#     ./scripts/capture-with-mitmproxy.sh -o claude.flow -- claude -p "say hello"
#
#   Capture OpenCode traffic (on a different port to avoid conflicts):
#     ./scripts/capture-with-mitmproxy.sh -o opencode.flow -p 8081 -- opencode run "say hello"
#
# ── Inspecting results ─────────────────────────────────────────────────
#
#   Open flows in the mitmproxy web UI:
#     mitmweb -r claude.flow
#     mitmweb -r opencode.flow
#
#   Dump flows as text (filter to /v1/messages calls, full detail):
#     mitmdump -nr claude.flow  --flow-detail 4 "~u /v1/messages"
#     mitmdump -nr opencode.flow --flow-detail 4 "~u /v1/messages"
#
#   Side-by-side header comparison:
#     diff <(mitmdump -nr claude.flow --flow-detail 4 "~u /v1/messages" 2>/dev/null) \
#          <(mitmdump -nr opencode.flow --flow-detail 4 "~u /v1/messages" 2>/dev/null)
#
# ───────────────────────────────────────────────────────────────────────

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: capture-with-mitmproxy.sh [-o FLOW_FILE] [-l LOG_FILE] [-p PORT] [--mitmdump PATH] -- command [args...]

Starts mitmdump, exports proxy/certificate environment variables for the child
command, writes captured flows to a file, then shuts the proxy down.

Options:
  -o FLOW_FILE        Flow output file (default: ./mitmproxy-YYYYmmdd-HHMMSS.flow)
  -l LOG_FILE         mitmdump stdout/stderr log file (default: FLOW_FILE.log)
  -p PORT             Proxy port (default: 8080)
  --mitmdump PATH     mitmdump binary to use (default: mitmdump from PATH)
  -h, --help          Show this help

Example:
  ./capture-with-mitmproxy.sh -o claude.flow -- claude -p "say hello"
  ./capture-with-mitmproxy.sh -o opencode.flow -- opencode run "say hello"
EOF
}

port=8080
flow_file=""
log_file=""
mitmdump_bin="mitmdump"

while [[ $# -gt 0 ]]; do
	case "$1" in
	-o)
		flow_file="$2"
		shift 2
		;;
	-l)
		log_file="$2"
		shift 2
		;;
	-p)
		port="$2"
		shift 2
		;;
	--mitmdump)
		mitmdump_bin="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		shift
		break
		;;
	*)
		printf 'Unknown argument: %s\n\n' "$1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if [[ $# -eq 0 ]]; then
	printf 'Missing command to run.\n\n' >&2
	usage >&2
	exit 1
fi

if ! command -v "$mitmdump_bin" >/dev/null 2>&1; then
	printf 'Could not find mitmdump binary: %s\n' "$mitmdump_bin" >&2
	printf 'Install mitmproxy first, e.g. `brew install mitmproxy`.\n' >&2
	exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
flow_file="${flow_file:-./mitmproxy-${timestamp}.flow}"
log_file="${log_file:-${flow_file}.log}"

ca_cert_path="${HOME}/.mitmproxy/mitmproxy-ca-cert.pem"
if [[ ! -f "$ca_cert_path" ]]; then
	printf 'mitmproxy CA cert not found at %s\n' "$ca_cert_path" >&2
	printf 'Start mitmdump once or visit http://mitm.it to generate/install it.\n' >&2
	exit 1
fi

cleanup() {
	if [[ -n "${mitmdump_pid:-}" ]] && kill -0 "$mitmdump_pid" >/dev/null 2>&1; then
		kill "$mitmdump_pid" >/dev/null 2>&1 || true
		wait "$mitmdump_pid" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

"$mitmdump_bin" \
	--listen-host 127.0.0.1 \
	--listen-port "$port" \
	-w "$flow_file" \
	>"$log_file" 2>&1 &
mitmdump_pid=$!

for _ in $(seq 1 50); do
	if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
		break
	fi

	if ! kill -0 "$mitmdump_pid" >/dev/null 2>&1; then
		printf 'mitmdump exited early. Check %s\n' "$log_file" >&2
		exit 1
	fi

	sleep 0.1
done

if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
	printf 'Timed out waiting for mitmdump on port %s. Check %s\n' "$port" "$log_file" >&2
	exit 1
fi

proxy_url="http://127.0.0.1:${port}"
base_no_proxy='127.0.0.1,localhost'
if [[ -n "${NO_PROXY:-}" ]]; then
	export NO_PROXY="${base_no_proxy},${NO_PROXY}"
else
	export NO_PROXY="$base_no_proxy"
fi
export no_proxy="$NO_PROXY"

export HTTP_PROXY="$proxy_url"
export HTTPS_PROXY="$proxy_url"
export ALL_PROXY="$proxy_url"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export all_proxy="$ALL_PROXY"

export NODE_EXTRA_CA_CERTS="$ca_cert_path"
export SSL_CERT_FILE="$ca_cert_path"
export REQUESTS_CA_BUNDLE="$ca_cert_path"
export CURL_CA_BUNDLE="$ca_cert_path"

printf 'mitmdump pid: %s\n' "$mitmdump_pid"
printf 'flow file: %s\n' "$flow_file"
printf 'mitmdump log: %s\n' "$log_file"
printf 'proxy: %s\n' "$proxy_url"
printf 'ca cert: %s\n' "$ca_cert_path"

"$@"
