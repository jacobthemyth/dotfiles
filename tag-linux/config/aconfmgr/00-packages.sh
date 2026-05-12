# aconfmgr package manifest for Arch Linux.
#
# Populate via the seeding procedure in
# docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md.
#
# Until this file declares packages, hooks/linux/pre-up/aconfmgr-apply
# is a no-op (it only runs when the file is non-empty after stripping
# comments).
#
# Examples:
#   AddPackage base-devel
#   AddPackage git
#   AddPackage paru                # AUR helper, optional but useful
#   AddPackage aconfmgr-git        # this tool itself
#   AddPackageGroup base
