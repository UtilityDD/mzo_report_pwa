#!/usr/bin/env bash
# Build the handoff zip for a new developer: the tracked files of one git ref plus
# docs/HANDOFF.md as START_HERE.md at the zip root, after a secret scan of everything staged.
#
#   scripts/tools/make_handoff.sh [options] [ref]
#
#   ref                      git ref to package (default: develop)
#   -o, --out FILE           output zip (default: vm-handoff.zip next to the repo folder)
#   --secrets-from FILE      an env file (KEY=value lines) whose values must not appear anywhere
#                            in the package; repeatable. Values are never printed, only their key.
#   --allow-key KEY          with --secrets-from: report a match of this key's value instead of
#                            failing (for values that are public by design); repeatable.
#   --keep                   keep the staging folder and print its path
#   -h, --help               this text
#
# Same ref, same zip: file order, timestamps (the commit time) and attributes are fixed.
# Exit 1 when the secret scan finds anything; nothing is written then.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REF=develop
OUT=""
KEEP=0
SECRET_FILES=()
ALLOW_KEYS=()

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="${2:?--out needs a file}"; shift 2 ;;
    --secrets-from) SECRET_FILES+=("${2:?--secrets-from needs a file}"); shift 2 ;;
    --allow-key) ALLOW_KEYS+=("${2:?--allow-key needs a key name}"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) REF="$1"; shift ;;
  esac
done
[ -n "$OUT" ] || OUT="$(cd "$ROOT/.." && pwd)/vm-handoff.zip"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
for f in ${SECRET_FILES[@]+"${SECRET_FILES[@]}"}; do [ -r "$f" ] || { echo "cannot read $f" >&2; exit 2; }; done
for tool in git zip node; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done

SHA="$(git -C "$ROOT" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
CTIME="$(git -C "$ROOT" log -1 --format=%ct "$SHA")"
echo "Packaging $REF ($SHORT)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mzo-handoff.XXXXXX")"
cleanup() { if [ "$KEEP" = 1 ]; then echo "staging kept: $STAGE"; else rm -rf "$STAGE"; fi; }
trap cleanup EXIT
PKG="$STAGE/pkg"
mkdir -p "$PKG"

# 1. Tracked files of the ref only: untracked .env, data dumps, node_modules and keys never reach git archive.
git -C "$ROOT" archive --format=tar "$SHA" | tar -x -C "$PKG"

# 2. START_HERE.md: the ref's docs/HANDOFF.md (the working tree's copy if the ref has none yet),
#    with its links rewritten from docs/ to the zip root.
if git -C "$ROOT" cat-file -e "$SHA:docs/HANDOFF.md" 2>/dev/null; then
  git -C "$ROOT" show "$SHA:docs/HANDOFF.md" > "$STAGE/handoff.md"
elif [ -f "$ROOT/docs/HANDOFF.md" ]; then
  echo "note: $REF has no docs/HANDOFF.md; using the working tree's copy" >&2
  cp "$ROOT/docs/HANDOFF.md" "$STAGE/handoff.md"
else
  echo "docs/HANDOFF.md not found in $REF or the working tree" >&2; exit 1
fi
# Sibling links (vm.md) become docs/vm.md, then ../X becomes X. URLs contain ':' and are left alone.
sed -e 's#\](\([A-Za-z0-9_][^):]*\))#](docs/\1)#g' -e 's#\](\.\./#](#g' "$STAGE/handoff.md" > "$PKG/START_HERE.md"
[ -f "$PKG/docs/HANDOFF.md" ] || cp "$STAGE/handoff.md" "$PKG/docs/HANDOFF.md"

# 3. Exclusions (defence in depth: none of these should be tracked).
find "$PKG" \( -name node_modules -o -name pb_data -o -name snapshots -o -name .tmp -o -name .state -o -name .pb \
  -o -path "$PKG/vm/pocketbase/local" -o -path "$PKG/.scratch" -o -path "$PKG/.vercel" \) -prune -exec rm -rf {} +
find "$PKG" -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.key' -o -name '*.pem' \
  -o -name '*.p12' -o -name '*.pfx' -o -name '*.log' -o -name '*.pid' -o -name '*.db' -o -name '*.sqlite' \
  -o -name '*.csv.gz' -o -name '*.csv.br' -o -name '*.tsv.gz' -o -name '*.tsv.br' -o -name '.DS_Store' \) -print -delete \
  | sed "s#^$PKG/#excluded: #"
if [ -d "$PKG/data" ]; then
  # data/: only files the ref tracks
  TRACKED_DATA="$(git -C "$ROOT" ls-tree -r --name-only "$SHA" -- data)"
  (cd "$PKG" && find data -type f) | while read -r f; do
    printf '%s\n' "$TRACKED_DATA" | grep -qxF "$f" || { echo "excluded: $f"; rm -f "$PKG/$f"; }
  done
fi

# 4. Secret scan of everything staged.
SCAN_ALLOW="$(IFS=,; echo "${ALLOW_KEYS[*]-}")"
SCAN_FILES="$(printf '%s\n' ${SECRET_FILES[@]+"${SECRET_FILES[@]}"})"
if ! MZO_SCAN_ALLOW="$SCAN_ALLOW" MZO_SCAN_FILES="$SCAN_FILES" node - "$PKG" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const fail = [];
const warn = [];
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.ts']);
const BAD_NAME = /(^|\/)(\.env(\..*)?|.*\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(key|pem|p12|pfx|jks|keystore)|supabase_config\.json|portal-admin\.txt|credentials\.json|service[-_]account.*\.json)$/i;
const ALLOWED_NAME = /(\.example|\.sample)(\.json)?$/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
function b64json(part) {
  try { return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { return null; }
}
const files = walk(root).sort();
const rel = (p) => path.relative(root, p);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// Values from the given env files (never printed).
const allowKeys = new Set(String(process.env.MZO_SCAN_ALLOW || '').split(',').filter(Boolean));
const secretValues = [];
for (const f of String(process.env.MZO_SCAN_FILES || '').split('\n').filter(Boolean)) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v.length < 8 || /^https?:\/\//i.test(v) || /^(true|false|yes|no|on|off|\d+)$/i.test(v)) continue;
    secretValues.push({ key: m[1], value: v, file: path.basename(f) });
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PRIVATE_KEY = /-----BEGIN ((RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY( BLOCK)?-----/;
const SCRYPT_HASH = /scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]{16,}\$[A-Za-z0-9+/=]{16,}/;
// Secret-looking names given a literal value: ENV_STYLE=value anywhere (quoted in source files),
// and "password": "value" style keys in data files.
const ENV_ASSIGN = /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|SERVICE_ROLE_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\b\s*[:=]\s*(["']?)([^\s"'`,;)}]{8,})\2/g;
const DATA_ASSIGN = /["']?\b(password|passwd|secret|token|api_?key|apikey|service_?role(?:_key)?|private_?key|client_?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi;
const PLACEHOLDER = /(test|example|dummy|fake|sample|placeholder|changeme|local-dev)/i;
const PLACEHOLDER_SHAPE = /^(<.*>|\$\{?[A-Z_]+\}?|x{4,}|\*{4,}|\.\.\.|…|your[-_].*|changeme|example.*|process\.env.*|env\..*|null|undefined|true|false|required|optional|string)$/i;
// Long opaque tokens (non-source files): base64/base64url/hex-ish runs of 40+ chars.
const TOKEN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/g;

for (const f of files) {
  const r = rel(f);
  if (BAD_NAME.test(r) && !ALLOWED_NAME.test(r)) fail.push(`${r}: file type that holds credentials`);
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) continue; // binary
  const text = buf.toString('utf8');
  const ext = path.extname(f).toLowerCase();

  if (PRIVATE_KEY.test(text)) fail.push(`${r}:${lineOf(text, text.search(PRIVATE_KEY))}: private key block`);
  const sh = SCRYPT_HASH.exec(text);
  if (sh) fail.push(`${r}:${lineOf(text, sh.index)}: password hash (scrypt$…)`);

  for (const m of text.matchAll(JWT)) {
    const head = b64json(m[0].split('.')[0]);
    const body = b64json(m[0].split('.')[1]);
    const at = `${r}:${lineOf(text, m.index)}`;
    if (!head || !body) { fail.push(`${at}: JWT-like token that does not decode`); continue; }
    const role = body.role || '(none)';
    if (role === 'anon') warn.push(`${at}: Supabase anon key for project ${body.ref || '?'} (public by design, allowed)`);
    else fail.push(`${at}: JWT with role ${role}${body.ref ? ` for project ${body.ref}` : ''}`);
  }

  const literal = (value) => !(PLACEHOLDER.test(value) || PLACEHOLDER_SHAPE.test(value) || /^[A-Z_]+$/.test(value) || /^eyJ/.test(value));
  for (const m of text.matchAll(ENV_ASSIGN)) {
    if (SOURCE_EXT.has(ext) && !m[2]) continue; // code: only quoted literals, not expressions
    if (literal(m[3])) fail.push(`${r}:${lineOf(text, m.index)}: ${m[1]} has a literal value`);
  }
  if (!SOURCE_EXT.has(ext)) {
    for (const m of text.matchAll(DATA_ASSIGN)) {
      if (literal(m[2])) fail.push(`${r}:${lineOf(text, m.index)}: "${m[1]}" has a literal value`);
    }
  }

  if (!SOURCE_EXT.has(ext)) {
    const urlSpans = [...text.matchAll(URL_RE)].map((u) => [u.index, u.index + u[0].length]);
    const inUrl = (i) => urlSpans.some(([a, b]) => i >= a && i < b);
    for (const m of text.matchAll(TOKEN)) {
      const t = m[0];
      if (inUrl(m.index)) continue;
      if (/^[0-9a-f]+$/i.test(t)) continue;                                      // sha1/sha256 digests
      if (/^sha(1|256|384|512)-/.test(t)) continue;                             // lockfile integrity
      if (/^(1[A-Za-z0-9_-]{32,50}|2PACX-[A-Za-z0-9_-]+|AKfyc[A-Za-z0-9_-]+)$/.test(t)) continue;  // Google sheet / Apps Script ids
      if (/^eyJ/.test(t)) continue;                                              // judged by the JWT rule
      if (!(/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t))) continue;   // words, paths, identifiers
      if (/^[A-Za-z]+(_[A-Za-z0-9]+)+$/.test(t) || /\//.test(t) && !/[+=]/.test(t)) continue;    // snake_case names, paths
      fail.push(`${r}:${lineOf(text, m.index)}: long opaque token (${t.length} chars) in a non-source file`);
    }
  }

  for (const s of secretValues) {
    const i = text.indexOf(s.value);
    if (i === -1) continue;
    const msg = `${r}:${lineOf(text, i)}: the value of ${s.key} from ${s.file}`;
    if (allowKeys.has(s.key)) warn.push(`${msg} (allowed by --allow-key)`);
    else if (/^eyJ/.test(s.value) && (b64json(s.value.split('.')[1]) || {}).role === 'anon') warn.push(`${msg} (anon key, allowed)`);
    else fail.push(msg);
  }
}

console.log(`Secret scan: ${files.length} files, ${secretValues.length} env value(s) checked`);
for (const w of [...new Set(warn)]) console.log(`  allowed: ${w}`);
for (const e of [...new Set(fail)]) console.log(`  FAIL:    ${e}`);
if (fail.length) { console.log(`Secret scan FAILED (${new Set(fail).size} finding(s)); no zip written.`); process.exit(1); }
console.log('Secret scan clean.');
JS
then
  exit 1
fi

# 5. Zip: fixed timestamps (commit time), sorted names, no extra attributes.
find "$PKG" -exec touch -h -d "@$CTIME" {} + 2>/dev/null || \
  find "$PKG" -exec touch -h -t "$(TZ=UTC date -r "$CTIME" +%Y%m%d%H%M.%S)" {} +
mkdir -p "$(dirname "$OUT")"
TMPZIP="$STAGE/out.zip"
(cd "$PKG" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | TZ=UTC zip -X -q -@ "$TMPZIP")
printf 'mzo-reports %s (%s)\n' "$SHA" "$REF" | zip -q -z "$TMPZIP" >/dev/null
mv -f "$TMPZIP" "$OUT"

COUNT="$(cd "$PKG" && find . -type f | wc -l | tr -d ' ')"
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
HUMAN="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
echo "Wrote $OUT"
echo "  $COUNT files, $SIZE bytes ($HUMAN), ref $REF at $SHORT"
