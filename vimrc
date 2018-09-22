let mapleader = " "

syntax on

" Load matchit.vim, but only if the user hasn't installed a newer version.
if !exists('g:loaded_matchit') && findfile('plugin/matchit.vim', &rtp) ==# ''
  runtime! macros/matchit.vim
endif

filetype plugin indent on

" When the type of shell script is /bin/sh, assume a POSIX-compatible
" shell for syntax highlighting purposes.
let g:is_posix = 1

" Softtabs, 2 spaces
set tabstop=2
set shiftwidth=2
set shiftround
set expandtab

" Display extra whitespace
set list listchars=tab:»·,trail:·,nbsp:·

" Use one space, not two, after punctuation.
set nojoinspaces

if executable('ag')
  " Use Ag over Grep
  set grepprg=ag\ --nogroup\ --nocolor

  " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
  let g:ctrlp_user_command = 'ag --literal --files-with-matches --nocolor --hidden -g "" %s'

  " ag is fast enough that CtrlP doesn't need to cache
  let g:ctrlp_use_caching = 0

  if !exists(":Ag")
    command -nargs=+ -complete=file -bar Ag silent! grep! <args>|cwindow|redraw!
    nnoremap \ :Ag<SPACE>
  endif
endif

set number

" Open new split panes to right and bottom, which feels more natural
set splitbelow
set splitright

if filereadable(expand("~/.vimrc.bundles"))
  source ~/.vimrc.bundles
endif

" Core {{{

" UI
set autoread
set colorcolumn=81
set cursorline
set hidden
set textwidth=0
set backspace=2   " Backspace deletes like most programs in insert mode
set nobackup
set nowritebackup
set noswapfile    " http://robots.thoughtbot.com/post/18739402579/global-gitignore#comment-458413287
set history=50
set ruler         " show the cursor position all the time
set showcmd       " display incomplete commands
set incsearch     " do incremental searching
set laststatus=2  " Always display the status line
set autowrite     " Automatically :write before running commands
set smartindent
set breakindent
let &showbreak = '→ '
set linebreak
set hlsearch
set ignorecase  " searches are case insensitive...
set smartcase   " ... unless they contain at least one capital letter
set infercase   " Use the correct case when autocompleting
set mouse=a " Enable mouse in all modes

" fix & command to preserve flags
nnoremap & :&&<CR>
xnoremap & :&&<CR>

" Expand %% to current directory
cnoremap %% <C-R>=fnameescape(expand('%:h')).'/'<cr>

" automatically rebalance windows on vim resize
autocmd VimResized * wincmd =
set foldmethod=indent
set nofoldenable       " don't fold by default

" Persistent undo
let undodir = expand('~/.vim/undo')
if !isdirectory(undodir)
  call mkdir(undodir)
endif
set undodir=~/.vim/undo
set undofile

nnoremap gr :grep! "\b<cword>\b"<CR>:cw<CR>
if filereadable(expand("~/.vim/colorscheme.vim"))
  let base16colorspace=256
  source ~/.vim/colorscheme.vim
endif
" }}}

" Mappings {{{
" Originally from vim-sensible, but <C-L> is used for TmuxNavigate
" Use <leader><C-L> to clear the highlighting of :set hlsearch.
nnoremap <silent> <leader><C-L> :nohlsearch<C-R>=has('diff')?'<Bar>diffupdate':''<CR><CR><C-L>

nnoremap <leader>d :Dispatch<CR>
nnoremap <silent><Leader>] <C-w><C-]><C-w>T

vnoremap <Leader>y "+y
vnoremap <Leader>d "+d
vnoremap <Leader>p "+p

nnoremap <Leader>y "+y
nnoremap <Leader>p "+p
nnoremap <Leader>P "+P

nnoremap <Leader>m :!open -a Marked\ 2.app %<CR><CR>

vnoremap <Leader>s :'<,'>!sort<CR>

" EasyAlign
" Start interactive EasyAlign in visual mode (e.g. vipga)
xmap ga <Plug>(EasyAlign)

" Start interactive EasyAlign for a motion/text object (e.g. gaip)
nmap ga <Plug>(EasyAlign)

" Fugitive
nnoremap <Leader>S :Gstatus<CR>
nnoremap dp dp:redraw!<CR>
nnoremap do do:redraw!<CR>

nnoremap <Leader>b :CtrlPBuffer<CR>
" }}}

" Plugins {{{
" airline
let g:airline_theme = 'base16_eighties'
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#tab_min_count = 2
let g:airline#extensions#tabline#show_buffers = 0
let g:airline#extensions#tabline#show_tab_type = 0
let g:airline#extensions#tabline#show_close_button = 0
let g:airline_section_y = ""       " remove fileencoding[fileformat]
let g:airline_powerline_fonts = 1

" ale
let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '']
nnoremap <Leader>af :ALEFix<CR>

" This is gross
let g:ale_javascript_eslint_executable='/bin/sh -c "cd $(dirname %) && ~/.nodenv/shims/eslint"'
let g:ale_linters = {
\   'javascript': ['eslint'],
\}
let g:ale_fixers = {
\   'javascript': ['eslint'],
\   'ruby': ['rubocop'],
\}

" ctrlp
" Ignore non project files
let g:ctrlp_custom_ignore = {
  \ 'dir':  '\v[\/](\.git|node_modules)$',
  \ }

let g:ctrlp_prompt_mappings = {
  \ 'PrtSelectMove("j")':   ['<c-j>', '<c-n>'],
  \ 'PrtSelectMove("k")':   ['<c-k>', '<c-p>'],
  \ 'PrtHistory(-1)':       ['<down>'],
  \ 'PrtHistory(1)':        ['<up>'],
  \ }

" deoplete
let g:deoplete#enable_at_startup = 1
autocmd FileType swift imap <buffer> <C-k> <Plug>(autocomplete_swift_jump_to_placeholder)

let s:default_sources = ['syntax', 'tag', 'buffer', 'file'] " TODO: ultisnips
if (exists('g:deoplete_loaded') && g:deoplete_loaded)
  call deoplete#custom#option('sources', {
  \ 'ruby': ['solargraph'] + s:default_sources,
  \})

  " https://github.com/Shougo/deoplete.nvim/issues/761
  call deoplete#custom#option('num_processes', 1)
endif

" fugitive
autocmd BufReadPost fugitive://* set bufhidden=delete

" goyo
nnoremap <leader>w :Goyo<CR>

" i18n
vmap <Leader>z :call I18nTranslateString()<CR>
vmap <Leader>dt :call I18nDisplayTranslation()<CR>

" jsx
let g:jsx_ext_required = 0

" mustache
let g:mustache_abbreviations = 1

" netrw
let g:netrw_bufsettings = 'noma nomod nu nobl nowrap ro'
augroup netrw
  autocmd!
  autocmd FileType netrw set colorcolumn=""
augroup END

" ranger
let g:ranger_map_keys = 0
map <leader>f :RangerNewTab<CR>

" sql.erb
augroup sql
  autocmd!
  autocmd BufRead,BufNewFile *.sql.erb setlocal tabstop=4
  autocmd BufRead,BufNewFile *.sql.erb setlocal shiftwidth=4
augroup END

" taskpaper
augroup taskpaper
  autocmd!
  autocmd BufRead,BufNewFile *.taskpaper set filetype=taskpaper
  autocmd FileType taskpaper setlocal noexpandtab
augroup END

" vim-rust
let g:rustfmt_autosave = 1

" tern
let g:tern_map_prefix='<Leader>'
let g:tern_map_keys=1
let g:tern_show_arguments_hints="on_hold"
let g:tern_show_signature_in_pum=1

" UltiSnips
let g:UltiSnipsExpandTrigger="<c-j>"
let g:UltiSnipsJumpForwardTrigger="<c-j>"
let g:UltiSnipsJumpBackwardTrigger="<c-k>"
let g:UltiSnipsListSnippets="<c-l>"
let g:UltiSnipsSnippetDirectories=["UltiSnips"]

autocmd FileType javascript UltiSnipsAddFiletypes javascript-jasmine-arrow
autocmd FileType coffee UltiSnipsAddFiletypes coffee-jasmine

inoremap <silent> <C-j> <C-r>=LoadUltiSnips()<cr>
function! LoadUltiSnips()
  let l:curpos = getcurpos()
  execute plug#load('ultisnips')
  call cursor(l:curpos[1], l:curpos[2])
  call UltiSnips#ExpandSnippet()
  return ""
endfunction

" vim-test
let g:test#strategy = 'dispatch'

nmap <silent> t<C-n> :TestNearest<CR>
nmap <silent> t<C-f> :TestFile<CR>
nmap <silent> t<C-s> :TestSuite<CR>
nmap <silent> t<C-l> :TestLast<CR>
nmap <silent> t<C-g> :TestVisit<CR>
" }}}

" vim: set foldmethod=marker:
