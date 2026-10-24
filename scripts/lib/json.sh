# shellcheck shell=bash
# Sourced by the scripts. They need only Docker on the host: Node is used when it is there, else the Node image the
# services are built from (pinned like the Dockerfile's, pulled once).

# The value at a dotted path (e.g. services.neo4j.image) of the JSON on stdin; empty when it is not there.
json_field() {
  local js='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let x=JSON.parse(s);for(const k of process.argv[1].split("."))x=x?.[k];console.log(x??"")})'
  if command -v node >/dev/null 2>&1; then node -e "$js" "$1"
  else docker run --rm -i node:26.5.0-slim node -e "$js" "$1"; fi
}
