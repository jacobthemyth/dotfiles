#!/bin/bash
#
# Git Repositories Scanner for Status Reports
#
# Scans local git repositories for commits and activity
# in a specified date range.

set -euo pipefail

# Default values
REPOS_DIR="$HOME/Code"
GIT_EMAIL=""
START_DATE=""
END_DATE=""
OUTPUT_FILE=""

# Usage information
usage() {
    cat <<EOF
Usage: $0 --start-date YYYY-MM-DD --end-date YYYY-MM-DD --email EMAIL [OPTIONS]

Required:
  --start-date DATE     Start date in YYYY-MM-DD format
  --end-date DATE       End date in YYYY-MM-DD format
  --email EMAIL         Git author email to filter commits

Options:
  --repos-dir DIR       Directory containing git repositories (default: ~/Code)
  --output FILE         Output file path (default: stdout)
  -h, --help            Show this help message

Example:
  $0 --start-date 2025-10-01 --end-date 2025-10-31 --email dev@example.com
EOF
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --start-date)
            START_DATE="$2"
            shift 2
            ;;
        --end-date)
            END_DATE="$2"
            shift 2
            ;;
        --email)
            GIT_EMAIL="$2"
            shift 2
            ;;
        --repos-dir)
            REPOS_DIR="$2"
            shift 2
            ;;
        --output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            ;;
    esac
done

# Validate required arguments
if [[ -z "$START_DATE" ]] || [[ -z "$END_DATE" ]] || [[ -z "$GIT_EMAIL" ]]; then
    echo "Error: --start-date, --end-date, and --email are required" >&2
    usage
fi

# Expand tilde in repos directory
REPOS_DIR="${REPOS_DIR/#\~/$HOME}"

# Check if repos directory exists
if [[ ! -d "$REPOS_DIR" ]]; then
    echo "Error: Repository directory does not exist: $REPOS_DIR" >&2
    exit 1
fi

# Initialize JSON structure
json_output='{
  "commits": [],
  "repositories": [],
  "branches_without_prs": [],
  "summary": {
    "start_date": "'"$START_DATE"'",
    "end_date": "'"$END_DATE"'",
    "git_email": "'"$GIT_EMAIL"'",
    "repos_dir": "'"$REPOS_DIR"'",
    "total_commits": 0,
    "total_repos_with_activity": 0,
    "total_branches_without_prs": 0
  }
}'

# Temporary file for building JSON
temp_commits=$(mktemp)
temp_repos=$(mktemp)
temp_branches=$(mktemp)

# Cleanup on exit
trap 'rm -f "$temp_commits" "$temp_repos" "$temp_branches"' EXIT

echo "[]" > "$temp_commits"
echo "[]" > "$temp_repos"
echo "[]" > "$temp_branches"

commit_count=0
repo_count=0
branch_count=0

# Find all git repositories
while IFS= read -r repo_path; do
    repo_dir=$(dirname "$repo_path")
    repo_name=$(basename "$repo_dir")

    # Get list of commit SHAs in date range for the specified author
    commit_shas=$(git -C "$repo_dir" log \
        --author="$GIT_EMAIL" \
        --since="$START_DATE 00:00:00" \
        --until="$END_DATE 23:59:59" \
        --pretty=format:'%H' \
        --no-merges 2>/dev/null || echo "")

    if [[ -n "$commit_shas" ]]; then
        ((repo_count++))

        # Process each commit SHA
        while IFS= read -r sha; do
            if [[ -n "$sha" ]]; then
                # Get commit details and build JSON safely using jq
                short_sha=$(git -C "$repo_dir" log -1 --pretty=format:'%h' "$sha" 2>/dev/null)
                date=$(git -C "$repo_dir" log -1 --pretty=format:'%ad' --date=iso "$sha" 2>/dev/null)
                subject=$(git -C "$repo_dir" log -1 --pretty=format:'%s' "$sha" 2>/dev/null)
                body=$(git -C "$repo_dir" log -1 --pretty=format:'%b' "$sha" 2>/dev/null)

                # Use jq to safely create JSON with proper escaping
                commit_json=$(jq -n \
                    --arg sha "$sha" \
                    --arg short_sha "$short_sha" \
                    --arg date "$date" \
                    --arg subject "$subject" \
                    --arg body "$body" \
                    --arg repo "$repo_name" \
                    --arg path "$repo_dir" \
                    '{sha: $sha, short_sha: $short_sha, date: $date, subject: $subject, body: $body, repository: $repo, repo_path: $path}')

                # Append to commits array
                jq ". += [$commit_json]" "$temp_commits" > "$temp_commits.tmp" && mv "$temp_commits.tmp" "$temp_commits"
                ((commit_count++))
            fi
        done <<< "$commit_shas"

        # Get repository info
        remote_url=$(git -C "$repo_dir" remote get-url origin 2>/dev/null || echo "")
        current_branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

        repo_info=$(jq -n \
            --arg name "$repo_name" \
            --arg path "$repo_dir" \
            --arg remote "$remote_url" \
            --arg branch "$current_branch" \
            --argjson commits "$commit_count" \
            '{name: $name, path: $path, remote_url: $remote, current_branch: $branch, commit_count: $commits}')

        jq ". += [$repo_info]" "$temp_repos" > "$temp_repos.tmp" && mv "$temp_repos.tmp" "$temp_repos"

        # Find branches without PRs (branches that exist locally but may not have associated PRs)
        # This is a heuristic: we'll list recent branches that have commits in the date range
        branches=$(git -C "$repo_dir" for-each-ref \
            --format='%(refname:short)|%(committerdate:iso)|%(authorname)' \
            refs/heads/ 2>/dev/null || echo "")

        while IFS='|' read -r branch_name commit_date author_name; do
            if [[ -n "$branch_name" ]] && [[ "$branch_name" != "main" ]] && [[ "$branch_name" != "master" ]]; then
                # Check if branch has commits in date range
                branch_commits=$(git -C "$repo_dir" log \
                    --author="$GIT_EMAIL" \
                    --since="$START_DATE 00:00:00" \
                    --until="$END_DATE 23:59:59" \
                    "$branch_name" \
                    --oneline \
                    --no-merges 2>/dev/null | wc -l || echo "0")

                if [[ "$branch_commits" -gt 0 ]]; then
                    branch_info=$(jq -n \
                        --arg name "$branch_name" \
                        --arg repo "$repo_name" \
                        --arg date "$commit_date" \
                        --argjson commits "$branch_commits" \
                        '{branch: $name, repository: $repo, last_commit_date: $date, commits_in_range: $commits}')

                    jq ". += [$branch_info]" "$temp_branches" > "$temp_branches.tmp" && mv "$temp_branches.tmp" "$temp_branches"
                    ((branch_count++))
                fi
            fi
        done <<< "$branches"
    fi
done < <(find "$REPOS_DIR" -name ".git" -type d 2>/dev/null)

# Build final JSON output
final_json=$(echo "$json_output" | jq \
    --slurpfile commits "$temp_commits" \
    --slurpfile repos "$temp_repos" \
    --slurpfile branches "$temp_branches" \
    --argjson total_commits "$commit_count" \
    --argjson total_repos "$repo_count" \
    --argjson total_branches "$branch_count" \
    '.commits = $commits[0] |
     .repositories = $repos[0] |
     .branches_without_prs = $branches[0] |
     .summary.total_commits = $total_commits |
     .summary.total_repos_with_activity = $total_repos |
     .summary.total_branches_without_prs = $total_branches')

# Output
if [[ -n "$OUTPUT_FILE" ]]; then
    echo "$final_json" > "$OUTPUT_FILE"
    echo "Git repository activity saved to $OUTPUT_FILE" >&2
else
    echo "$final_json"
fi
