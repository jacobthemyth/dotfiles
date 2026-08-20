#!/bin/bash
#
# Common functions for status-report scripts
#

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Default config file location (XDG-style, outside the skill tree)
DEFAULT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/status-report/config.json"

# Log functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Load configuration from JSON file
load_config() {
    local config_file="${1:-$DEFAULT_CONFIG}"

    if [[ ! -f "$config_file" ]]; then
        log_error "Configuration file not found: $config_file"
        return 1
    fi

    if ! command_exists jq; then
        log_error "jq is required but not installed"
        return 1
    fi

    # Remember the resolved config path so helpers like get_config_array can re-read it
    _CONFIG_FILE_PATH="$config_file"

    # Export config values as environment variables
    eval "$(jq -r '
        to_entries |
        map(
            if .value == null then
                ""
            elif .value | type == "array" then
                "export CONFIG_" + (.key | ascii_upcase) + "=\"" + (.value | @json) + "\""
            else
                "export CONFIG_" + (.key | ascii_upcase) + "=\"" + (.value | tostring) + "\""
            end
        ) |
        .[]
    ' "$config_file")"

    return 0
}

# Get config value
get_config() {
    local key="$1"
    local default="${2:-}"
    local var_name="CONFIG_$(echo "$key" | tr '[:lower:]' '[:upper:]')"

    local value="${!var_name:-$default}"
    echo "$value"
}

# Get an array config value as a JSON string (e.g., '["a","b"]')
# Bypasses the env-var export path because bash doesn't quote arrays cleanly.
get_config_array() {
    local key="$1"
    local default="${2:-[]}"
    local config_file="${_CONFIG_FILE_PATH:-$DEFAULT_CONFIG}"

    if [[ ! -f "$config_file" ]]; then
        echo "$default"
        return 0
    fi

    local value
    value=$(jq -c --arg key "$key" '
        if has($key) and (.[$key] | type) == "array" then .[$key]
        else empty
        end
    ' "$config_file" 2>/dev/null)

    if [[ -z "$value" || "$value" == "null" ]]; then
        echo "$default"
    else
        echo "$value"
    fi
}

# Expand tilde in path
expand_path() {
    local path="$1"
    echo "${path/#\~/$HOME}"
}

# Validate date format (YYYY-MM-DD)
validate_date() {
    local date="$1"

    if [[ ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        return 1
    fi

    # Check if date is valid (using date command)
    if ! date -j -f "%Y-%m-%d" "$date" >/dev/null 2>&1; then
        return 1
    fi

    return 0
}

# Get first and last day of a month (YYYY-MM format)
get_month_range() {
    local month="$1"  # Format: YYYY-MM

    if [[ ! "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
        log_error "Invalid month format. Expected YYYY-MM, got: $month"
        return 1
    fi

    local year="${month%-*}"
    local mon="${month#*-}"

    # First day of month
    local start_date="${year}-${mon}-01"

    # Last day of month (using date command)
    local last_day=$(date -j -f "%Y-%m-%d" -v+1m -v-1d "$start_date" "+%d" 2>/dev/null)

    if [[ -z "$last_day" ]]; then
        log_error "Failed to calculate last day of month"
        return 1
    fi

    local end_date="${year}-${mon}-${last_day}"

    echo "$start_date $end_date"
}

# Get last month in YYYY-MM format
get_last_month() {
    date -v-1m "+%Y-%m"
}

# Get the previous complete calendar week (Monday-Sunday) as "START END"
# Both dates in YYYY-MM-DD. Uses macOS `date`.
get_last_week() {
    local dow this_monday last_monday last_sunday
    dow=$(date "+%u")  # 1=Mon .. 7=Sun
    # Monday of the current week
    this_monday=$(date -j -v-$((dow - 1))d "+%Y-%m-%d")
    # Previous week's Monday and Sunday
    last_monday=$(date -j -f "%Y-%m-%d" -v-7d "$this_monday" "+%Y-%m-%d")
    last_sunday=$(date -j -f "%Y-%m-%d" -v+6d "$last_monday" "+%Y-%m-%d")
    echo "$last_monday $last_sunday"
}

# Create temporary directory for collector outputs
create_temp_dir() {
    local prefix="${1:-status-report}"
    local temp_dir

    temp_dir=$(mktemp -d "/tmp/${prefix}-XXXXXX")

    if [[ ! -d "$temp_dir" ]]; then
        log_error "Failed to create temporary directory"
        return 1
    fi

    echo "$temp_dir"
}

# Check required commands
check_requirements() {
    local missing=()

    for cmd in "$@"; do
        if ! command_exists "$cmd"; then
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        return 1
    fi

    return 0
}

# Merge JSON files into array
merge_json_files() {
    local output_file="$1"
    shift
    local input_files=("$@")

    if ! command_exists jq; then
        log_error "jq is required for merging JSON files"
        return 1
    fi

    # Create array with all JSON objects
    jq -s '.' "${input_files[@]}" > "$output_file"

    return $?
}

# Pretty print JSON
pretty_json() {
    if command_exists jq; then
        jq '.'
    else
        cat
    fi
}
