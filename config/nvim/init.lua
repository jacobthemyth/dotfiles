-- Setup options that need to be set before loading lazy.nvim
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

vim.cmd("source ~/.vimrc")

require("config.lazy")

-- Always use OSC 52 for the clipboard. Works identically locally and remotely:
-- yanks travel the escape-sequence channel through tmux/mosh/ghostty to set the
-- macOS clipboard, and (with `set-clipboard on` in tmux) populate the tmux
-- paste buffer simultaneously.
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
