-- Used by beads
return {
  "stevearc/dressing.nvim",
  event = "VeryLazy",
  opts = {
    input = { border = "rounded" },
    select = { backend = { "telescope", "builtin" }, builtin = { border = "rounded" } },
  },
}
