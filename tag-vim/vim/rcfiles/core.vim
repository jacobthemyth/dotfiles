" UI
if &t_Co == 256
  let base16colorspace=256
endif
colorscheme base16-eighties
set cursorline

" Indentation
set smartindent
set breakindent
let &showbreak = '→ '
set linebreak

" Search
set ignorecase  " searches are case insensitive...
set smartcase   " ... unless they contain at least one capital letter
set infercase   " Use the correct case when autocompleting

" fix & command to preserve flags
nnoremap & :&&<CR>
xnoremap & :&&<CR>

" Expand %% to current directory
cnoremap %% <C-R>=fnameescape(expand('%:h')).'/'<cr>

" automatically rebalance windows on vim resize
autocmd VimResized * wincmd =
