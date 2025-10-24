return {
  'MeanderingProgrammer/render-markdown.nvim',
  dependencies = { 'nvim-treesitter/nvim-treesitter', 'nvim-tree/nvim-web-devicons' },
  ft = { "markdown", "Avante" },
  opts = {
    file_types = { "markdown", "Avante" },

    heading = {
      width = 'block',
    },

    sign = {
      enabled = false,
    },

    code = {
      enabled = true,
      conceal_delimiters = false,
      border = 'thick',
      position = 'right',
      width = 'block',
      right_pad = 10,
      -- Inline code padding to maintain width when backticks are concealed
      inline_pad = 1, -- Adds 1 space on each side (replaces 1 backtick on each side)
    },

    link = {
      enabled = false,
    },
  },
}
