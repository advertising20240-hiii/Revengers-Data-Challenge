#!/usr/bin/env bash
# Repository hygiene audit. Run before every push:  npm run audit   (or: bash scripts/audit-repo.sh)
#
# Checks
#   (a) tracked or staged files must not include secret-like paths (.env, *.pem, *.key, node_modules/)
#   (b) tracked text must not contain key-like strings (Anthropic, generic sk-, AWS, GitHub, Slack tokens)
#   (c) OPTIONAL deny-lists kept OUTSIDE the repo:
#         CQA_AUDIT_PATHS_FILE  - one path glob per line; any matching tracked path fails
#         CQA_AUDIT_TERMS_FILE  - one forbidden term per line; any case-insensitive hit in tracked text fails
#   (d) OPTIONAL CQA_AUDIT_READONLY_REPO - a path to a git repo that must have a clean working tree
#   (e) prints the files that would be pushed and a summary
#
# Exit code 0 = clean, 1 = findings, 2 = usage error. Works in Git Bash (Windows) and on Ubuntu.
set -u

REPO_DIR="${CQA_AUDIT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_DIR" || { echo "audit: cannot cd to $REPO_DIR" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "audit: $REPO_DIR is not a git repository" >&2; exit 2; }

FAIL=0
fail() { FAIL=1; printf 'FAIL  %s\n' "$*"; }
ok()   { printf 'ok    %s\n' "$*"; }

# Files that are tracked or staged (what a push would carry).
FILES="$(git ls-files --cached --others --exclude-standard | sort -u)"
STAGED="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)"
ALL_FILES="$(printf '%s\n%s\n' "$FILES" "$STAGED" | sed '/^$/d' | sort -u)"

# ---------------------------------------------------------------- (a) secret-like paths
BAD_PATHS="$(printf '%s\n' "$ALL_FILES" | grep -Ei '(^|/)\.env(\..*)?$|\.pem$|\.key$|(^|/)node_modules/' | grep -Ev '(^|/)\.env\.example$' || true)"
if [ -n "$BAD_PATHS" ]; then
  fail "secret-like paths tracked or staged:"; printf '      %s\n' $BAD_PATHS
else
  ok "no .env / *.pem / *.key / node_modules in tracked or staged files"
fi

# ---------------------------------------------------------------- (b) key-like strings
# Only text files that git knows about; binary files are skipped by `git grep -I`.
KEY_PATTERNS='sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[bp]-[A-Za-z0-9-]+'
KEY_HITS="$(git grep -I -n -E -e "$KEY_PATTERNS" -- . ':(exclude)scripts/audit-repo.sh' ':(exclude)tests/audit.test.js' 2>/dev/null || true)"
if [ -n "$KEY_HITS" ]; then
  fail "key-like strings found:"; printf '%s\n' "$KEY_HITS" | sed 's/^/      /'
else
  ok "no key-like strings (sk-ant-, sk-…, AKIA…, ghp_…, xox[bp]-)"
fi

# ---------------------------------------------------------------- (c) optional external deny-lists
read_list() { # strips comments and blank lines, tolerates CRLF
  sed -e 's/\r$//' -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | sed '/^$/d'
}

if [ -n "${CQA_AUDIT_PATHS_FILE:-}" ]; then
  if [ ! -r "$CQA_AUDIT_PATHS_FILE" ]; then
    fail "CQA_AUDIT_PATHS_FILE not readable: $CQA_AUDIT_PATHS_FILE"
  else
    HITS=""
    while IFS= read -r pattern; do
      # Match the glob against the full path or against any path component (so "foo/" and "*.md" both work).
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        p="${pattern%/}"
        case "$f" in
          $p|$p/*|*/$p|*/$p/*) HITS="$HITS$f  (rule: $pattern)"$'\n' ;;
        esac
      done <<< "$ALL_FILES"
    done < <(read_list "$CQA_AUDIT_PATHS_FILE")
    if [ -n "$HITS" ]; then fail "paths matching the external deny-list:"; printf '%s' "$HITS" | sed 's/^/      /'
    else ok "no tracked path matches the external path deny-list"; fi
  fi
fi

if [ -n "${CQA_AUDIT_TERMS_FILE:-}" ]; then
  if [ ! -r "$CQA_AUDIT_TERMS_FILE" ]; then
    fail "CQA_AUDIT_TERMS_FILE not readable: $CQA_AUDIT_TERMS_FILE"
  else
    TERM_HITS=""
    while IFS= read -r term; do
      h="$(git grep -I -i -n -F -e "$term" -- . 2>/dev/null || true)"
      [ -n "$h" ] && TERM_HITS="$TERM_HITS$h"$'\n'
    done < <(read_list "$CQA_AUDIT_TERMS_FILE")
    if [ -n "$TERM_HITS" ]; then
      # Report file:line only; never echo the forbidden term itself into logs.
      fail "forbidden terms found (file:line):"; printf '%s' "$TERM_HITS" | cut -d: -f1,2 | sort -u | sed 's/^/      /'
    else ok "no hits for the external term deny-list"; fi
  fi
fi

# ---------------------------------------------------------------- (d) read-only sibling repository
if [ -n "${CQA_AUDIT_READONLY_REPO:-}" ]; then
  if [ ! -d "$CQA_AUDIT_READONLY_REPO" ]; then
    fail "CQA_AUDIT_READONLY_REPO does not exist: $CQA_AUDIT_READONLY_REPO"
  else
    RO_STATUS="$(git -C "$CQA_AUDIT_READONLY_REPO" status --porcelain 2>&1)"
    if [ -n "$RO_STATUS" ]; then fail "read-only repository has changes: $CQA_AUDIT_READONLY_REPO"; printf '%s\n' "$RO_STATUS" | sed 's/^/      /'
    else ok "read-only repository is clean"; fi
  fi
fi

# ---------------------------------------------------------------- (e) what would be pushed
echo
echo "Files that would be pushed (tracked + staged, ${CQA_AUDIT_QUIET:+summary only}):"
if [ -z "${CQA_AUDIT_QUIET:-}" ]; then printf '%s\n' "$ALL_FILES" | sed 's/^/  /'; fi
COUNT="$(printf '%s\n' "$ALL_FILES" | sed '/^$/d' | wc -l | tr -d ' ')"
UNPUSHED="$(git log --oneline '@{u}..HEAD' 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "Summary: $COUNT files, $UNPUSHED unpushed commit(s) on $(git rev-parse --abbrev-ref HEAD 2>/dev/null), HEAD $(git rev-parse --short HEAD 2>/dev/null || echo none)"
if [ "$FAIL" -ne 0 ]; then echo "AUDIT FAILED"; exit 1; fi
echo "AUDIT PASSED"
