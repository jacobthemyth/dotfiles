#!/bin/bash
#
# Status Report Collector
#
# Resolves a date range, runs the deterministic collectors (github, git,
# documents, slack), and merges their output into combined.json.
# Makes NO LLM call and does NOT touch Linear or Google Calendar — those
# are gathered by the agent via MCP.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MODE=""          # last-week | month | range
MONTH=""
START_DATE=""
END_DATE=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [--last-week | --month YYYY-MM | --start-date YYYY-MM-DD --end-date YYYY-MM-DD]

Resolves a reporting period, runs the deterministic collectors, and writes
combined.json. Defaults to --last-week if no mode is given.
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --last-week) MODE="last-week"; shift ;;
        --month) MODE="month"; MONTH="$2"; shift 2 ;;
        --start-date) START_DATE="$2"; shift 2 ;;
        --end-date) END_DATE="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) log_error "Unknown option: $1"; usage ;;
    esac
done

check_requirements jq gh git python3 || exit 1

if ! load_config; then
    log_error "Create your config at ${XDG_CONFIG_HOME:-$HOME/.config}/status-report/config.json"
    exit 1
fi

# --- Resolve date range and output filename stem ---
if [[ -n "$START_DATE" || -n "$END_DATE" ]]; then
    [[ -n "$START_DATE" && -n "$END_DATE" ]] || { log_error "Both --start-date and --end-date are required for a custom range"; exit 1; }
    validate_date "$START_DATE" || { log_error "Invalid start date: $START_DATE"; exit 1; }
    validate_date "$END_DATE"   || { log_error "Invalid end date: $END_DATE"; exit 1; }
    OUTPUT_STEM="status-report-${START_DATE}_to_${END_DATE}"
elif [[ "$MODE" == "month" ]]; then
    read -r START_DATE END_DATE <<< "$(get_month_range "$MONTH")"
    [[ -n "$START_DATE" ]] || { log_error "Failed to parse month: $MONTH"; exit 1; }
    OUTPUT_STEM="status-report-${MONTH}"
else
    # default: previous complete calendar week
    read -r START_DATE END_DATE <<< "$(get_last_week)"
    OUTPUT_STEM="status-report-$(date -j -f "%Y-%m-%d" "$START_DATE" "+%G-W%V")"
fi

log_info "Reporting period: $START_DATE to $END_DATE"

TEMP_DIR=$(create_temp_dir "status-report")
log_info "Working directory: $TEMP_DIR"

declare -a SUCCESSFUL_COLLECTORS=()

# --- GitHub ---
GITHUB_ORG=$(get_config github_org)
if [[ -n "$GITHUB_ORG" ]]; then
    log_info "Running GitHub collector..."
    if "$SCRIPT_DIR/github.py" --start-date "$START_DATE" --end-date "$END_DATE" \
        --org "$GITHUB_ORG" --output "$TEMP_DIR/github.json"; then
        SUCCESSFUL_COLLECTORS+=("github"); log_success "GitHub data collected"
    else
        log_warn "GitHub collector failed"
    fi
else
    log_warn "github_org not configured, skipping GitHub"
fi

# --- Local git ---
GIT_EMAIL=$(get_config git_email)
REPOS_DIR=$(expand_path "$(get_config repos_directory "$HOME/Code")")
if [[ -n "$GIT_EMAIL" ]]; then
    log_info "Running git repositories scanner..."
    if "$SCRIPT_DIR/git-repos.sh" --start-date "$START_DATE" --end-date "$END_DATE" \
        --email "$GIT_EMAIL" --repos-dir "$REPOS_DIR" --output "$TEMP_DIR/git.json"; then
        SUCCESSFUL_COLLECTORS+=("git"); log_success "Git repositories scanned"
    else
        log_warn "Git scanner failed"
    fi
else
    log_warn "git_email not configured, skipping git"
fi

# --- Documents ---
DOC_DIRS_JSON=$(get_config_array document_directories)
if [[ "$DOC_DIRS_JSON" != "[]" && -n "$DOC_DIRS_JSON" ]]; then
    log_info "Running documents collector..."
    DOC_DIRS=""
    while IFS= read -r d; do
        DOC_DIRS+="${DOC_DIRS:+,}$(expand_path "$d")"
    done < <(echo "$DOC_DIRS_JSON" | jq -r '.[]')

    OUTPUT_DIR_ABS=$(expand_path "$(get_config output_directory "$HOME/Desktop")")
    AUTO_EXCLUDES="$OUTPUT_DIR_ABS,$SCRIPT_DIR"
    SLACK_DIR=$(get_config slack_export_directory "")
    if [[ -n "$SLACK_DIR" && "$SLACK_DIR" != "null" ]]; then
        AUTO_EXCLUDES+=",$(expand_path "$SLACK_DIR")"
    fi
    USER_EXCLUDES=$(get_config_array document_exclude_patterns | jq -r 'join(",")')
    [[ -n "$USER_EXCLUDES" ]] && AUTO_EXCLUDES+=",$USER_EXCLUDES"
    DOC_EXTS=$(get_config_array document_extensions '["md","pdf"]' | jq -r 'join(",")')
    DOC_MAX_BYTES=$(get_config document_max_file_bytes "20000")

    if "$SCRIPT_DIR/documents.py" --start-date "$START_DATE" --end-date "$END_DATE" \
        --directories "$DOC_DIRS" --extensions "$DOC_EXTS" \
        --exclude-patterns "$AUTO_EXCLUDES" --max-file-bytes "$DOC_MAX_BYTES" \
        --output "$TEMP_DIR/documents.json"; then
        SUCCESSFUL_COLLECTORS+=("documents"); log_success "Documents collected"
    else
        log_warn "Documents collector failed"
    fi
else
    log_info "document_directories not configured, skipping documents"
fi

# Note: Slack is NOT collected here. The agent reads the week's Slack summary
# file directly (see SKILL.md), so it stays out of this scripted merge.

# --- Merge ---
COMBINED_JSON="$TEMP_DIR/combined.json"
echo "{\"date_range\":{\"start\":\"$START_DATE\",\"end\":\"$END_DATE\"}}" > "$COMBINED_JSON"
for src in github git documents; do
    if [[ -f "$TEMP_DIR/$src.json" ]]; then
        jq --slurpfile s "$TEMP_DIR/$src.json" ". + {\"$src\": \$s[0]}" \
            "$COMBINED_JSON" > "$COMBINED_JSON.tmp" && mv "$COMBINED_JSON.tmp" "$COMBINED_JSON"
    fi
done

log_success "Collected from: ${SUCCESSFUL_COLLECTORS[*]:-none}"

# --- Machine-readable output for the agent ---
echo "WORK_DIR=$TEMP_DIR"
echo "COMBINED_JSON=$COMBINED_JSON"
echo "START_DATE=$START_DATE"
echo "END_DATE=$END_DATE"
echo "OUTPUT_STEM=$OUTPUT_STEM"
