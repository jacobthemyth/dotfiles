" Originally from vim-sensible, but <C-L> is used for TmuxNavigate
" Use <leader><C-L> to clear the highlighting of :set hlsearch.
nnoremap <silent> <leader><C-L> :nohlsearch<C-R>=has('diff')?'<Bar>diffupdate':''<CR><CR><C-L>

nnoremap <leader>d :Dispatch<CR>
