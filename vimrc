" Jacob Smith's .vimrc
set nocompatible      " this must be as early as possible

if filereadable(expand("~/.vimrc.bundles"))
  source ~/.vimrc.bundles
endif

" Core Settings {{{
" Also note that vim-sensible sets up some nice defaults
set modelines=1 " Allow modelines (i.e. executable comments)
set switchbuf+=usetab
set hidden
set mouse+=a " Enable mouse use in all modes
if &term =~ '^screen'
    " tmux knows the extended mouse mode
    set ttymouse=xterm2
endif

" Search
set hlsearch    " highlight matches
set ignorecase  " searches are case insensitive...
set smartcase   " ... unless they contain at least one capital letter
set infercase   " Use the correct case when autocompleting

set background=dark
let g:pencil_terminal_italics = 1
colorscheme pencil

set number            " Show line numbers
set colorcolumn=81
set showmatch " show matching brackets
set cmdheight=2

" Open new split panes to right and bottom
set splitbelow
set splitright

set foldmethod=indent   " fold based on indent level
set foldnestmax=10      " max 10 depth
set foldenable          " don't fold files by default on open
set foldlevelstart=10   " start with fold level of 10

" replace last 'c' character with $
set cpoptions+=$

set t_ti= t_te= " leave vim session in terminal after quit

" Whitespace
set tabstop=2     " a tab is two spaces
set expandtab     " use spaces, not tabs
set softtabstop=2 " 2 space tab
set shiftwidth=2  " an autoindent (with <<) is two spaces
set shiftround    " round indent to shiftwidth
set list          " show invisible listchars
set nowrap

" Backup and swap files
set backup
set backupdir^=~/.vim/_backup//    " where to put backup files.
set directory^=~/.vim/_temp//      " where to put swap files.

" Files and directories to hide
set wildignore+=*.o,*.out,*.obj,.git,*.rbc,*.rbo,*.class,.svn,*.gem,.DS_Store

set lazyredraw                  " Don't update while executing macros

set title " change the terminal title
set noerrorbells " don't beep
" }}}

" Tweaks {{{
" Open quickfix after any grep
autocmd QuickFixCmdPost *grep* cwindow

" allow the . to execute once for each line of a visual selection
vnoremap . :normal .<CR>

" fix & command to preserve flags
nnoremap & :&&<CR>
xnoremap & :&&<CR>

" Expand %% to current directory
cnoremap %% <C-R>=fnameescape(expand('%:h')).'/'<cr>
" }}}

" Keyboard bindings {{{
let mapleader = "\<Space>"

nnoremap 0 ^

nnoremap <leader>h :nohlsearch<CR>
nnoremap <leader><leader> <c-^>
nnoremap <Leader>o :CtrlP<CR>
nnoremap <Leader>w :w<CR>

vnoremap <Leader>y "*y
vnoremap <Leader>d "*d
nnoremap <Leader>p "*p
nnoremap <Leader>P "*P
vnoremap <Leader>p "*p
vnoremap <Leader>P "*P

nnoremap <leader>w :Goyo<CR>
nnoremap <silent> <leader>gq :g/^/norm gqq<CR> " format all paragraphs
nnoremap <silent> <leader>gj :%norm vipJ<CR> " unformat all paragraphs

nnoremap <silent> <leader>m :!open -a Marked\ 2.app "%"<cr> " preview Markdown
nnoremap <silent> <leader>e :Explore<cr>
" }}}

" Plugin settings {{{
" Airline
let g:airline_theme = 'pencil'
let g:airline_left_sep = ' '
let g:airline_right_sep = ' '
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#show_buffers = 0
let g:airline#extensions#tabline#left_sep = ' '
let g:airline#extensions#tabline#left_alt_sep = '|'
let g:airline#extensions#tabline#right_sep = ' '
let g:airline#extensions#tabline#right_alt_sep = '|'

" indentLine
let g:indentLine_char = '¦'

" Goyo
function! s:goyo_enter()
  set noshowmode
  set noshowcmd
  set virtualedit=
  noremap  <buffer> <silent> k gk
  noremap  <buffer> <silent> j gj
  noremap  <buffer> <silent> <Home> g<Home>
  noremap  <buffer> <silent> <End>  g<End>
  inoremap <buffer> <silent> <Up>   <C-o>gk
  inoremap <buffer> <silent> <Down> <C-o>gj
  inoremap <buffer> <silent> <Home> <C-o>g<Home>
  inoremap <buffer> <silent> <End>  <C-o>g<End>
endfunction

function! s:goyo_leave()
  set showmode
  set showcmd
  set virtualedit=all
  silent! nunmap <buffer> k
  silent! nunmap <buffer> j
  silent! nunmap <buffer> <Home>
  silent! nunmap <buffer> <End>
  silent! iunmap <buffer> <Up>
  silent! iunmap <buffer> <Down>
  silent! iunmap <buffer> <Home>
  silent! iunmap <buffer> <End>
endfunction

autocmd! User GoyoEnter
autocmd! User GoyoLeave
autocmd  User GoyoEnter nested call <SID>goyo_enter()
autocmd  User GoyoLeave nested call <SID>goyo_leave()

" Syntastic
let g:syntastic_check_on_open=1 " check on open as well as save

" The Silver Searcher
if executable('ag')
  " Use Ag over Grep
  set grepprg=ag\ --nogroup\ --nocolor
endif

" CtrlP
if executable('ag')
  " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
  let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'

  " ag is fast enough that CtrlP doesn't need to cache
  let g:ctrlp_use_caching = 0
endif

" Ignore non project files
let g:ctrlp_custom_ignore = {
  \ 'dir':  '\v[\/](\.git|\.template|node_modules|development|release)$',
  \ }

let g:mustache_abbreviations = 1
" }}}

" Auto Commands {{{
augroup vimrcEx
  autocmd!

  " When editing a file, always jump to the last known cursor position.
  " Don't do it for commit messages, when the position is invalid, or when
  " inside an event handler (happens when dropping a file on gvim).
  autocmd BufReadPost *
    \ if &ft != 'gitcommit' && line("'\"") > 0 && line("'\"") <= line("$") |
    \   exe "normal g`\"" |
    \ endif

  " Markdown
  au BufRead,BufNewFile *.md set filetype=markdown
  autocmd FileType markdown setlocal wrap
  autocmd FileType markdown setlocal linebreak
  autocmd FileType markdown setlocal nolist
  autocmd FileType markdown setlocal colorcolumn=0
  autocmd FileType markdown setlocal spell

  au BufRead,BufNewFile *.scss set filetype=scss
augroup END
" }}}

" GUI {{{
" Needs to be last, to override CLI settings
if has("gui_running")
  if has("autocmd")
    " Automatically resize splits when resizing MacVim window
    autocmd VimResized * wincmd =
  endif

  set guifont=Cousine:h16
  set guioptions-=r
  set background=light
endif

if has("gui_macvim")
  macmenu Tools.Make key=<nop>
endif
" }}}
" vim: foldmethod=marker:foldlevel=0
