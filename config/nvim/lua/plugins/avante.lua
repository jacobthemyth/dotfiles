return {
  "yetone/avante.nvim",
  event = "VeryLazy",
  lazy = true,
  opts = {
    providers = {
      claude = {
        api_key_name = "cmd:llm keys get anthropic", -- the shell command must be prefixed with `^cmd:(.*)`
      }
    },
    selection = {
      hint_display = 'none',
    },
  },
  -- if you want to build from source then do `make BUILD_FROM_SOURCE=true`
  -- nvim-resign re-signs the freshly built native modules so macOS does not
  -- SIGKILL nvim on dlopen ("Code Signature Invalid"); no-op off macOS.
  build = "make && nvim-resign .",
  -- build = "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false" -- for windows
  dependencies = {
    "nvim-treesitter/nvim-treesitter",
    "stevearc/dressing.nvim",
    "nvim-lua/plenary.nvim",
    "MunifTanjim/nui.nvim",
    --- The below dependencies are optional,
    "echasnovski/mini.pick", -- for file_selector provider mini.pick
    "nvim-telescope/telescope.nvim", -- for file_selector provider telescope
    "hrsh7th/nvim-cmp", -- autocompletion for avante commands and mentions
    "ibhagwan/fzf-lua", -- for file_selector provider fzf
    "nvim-tree/nvim-web-devicons", -- or echasnovski/mini.icons
  },
}
