-- Setup options that need to be set before loading lazy.nvim
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

vim.cmd("source ~/.vimrc")

require("config.lazy")
