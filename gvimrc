if has("gui_macvim")
  macmenu Tools.Make key=<nop>
  macmenu File.New\ Tab key=<D-S-T>
  macmenu File.Open\ Tab\.\.\. key=<nop>

  map <D-t> :CommandT<CR>
endif
set guifont=Sauce\ Code\ Powerline:h13
