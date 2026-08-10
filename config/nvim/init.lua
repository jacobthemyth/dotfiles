-- Setup options that need to be set before loading lazy.nvim
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

-- Managed by hooks/shared/post-up/vim (uv venv --allow-existing)
vim.g.python3_host_prog = vim.fn.expand("~/.local/share/nvim/venv/bin/python3")

vim.cmd("source ~/.vimrc")

require("config.lazy")

-- Always use OSC 52 for the clipboard. Works identically locally and remotely:
-- yanks travel the escape-sequence channel through tmux/mosh/ghostty to set the
-- macOS clipboard, and (with `set-clipboard on` in tmux) populate the tmux
-- paste buffer simultaneously.
vim.keymap.set("n", "<leader>%", function()
  vim.fn.setreg("+", vim.fn.expand("%"))
end, { desc = "Copy filename to clipboard" })

vim.g.clipboard = {
  name = "OSC 52",
  copy = {
    ["+"] = require("vim.ui.clipboard.osc52").copy("+"),
    ["*"] = require("vim.ui.clipboard.osc52").copy("*"),
  },
  paste = {
    ["+"] = require("vim.ui.clipboard.osc52").paste("+"),
    ["*"] = require("vim.ui.clipboard.osc52").paste("*"),
  },
}
