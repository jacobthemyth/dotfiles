" Jacob Smith's .vimrc
set nocompatible      " this must be as early as possible

if filereadable(expand("~/.vimrc.bundles"))
  source ~/.vimrc.bundles
endif

" Settings {{{
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

syntax enable         " Turn on syntax highlighting allowing local overrides
set background=dark
let g:pencil_terminal_italics = 1
colorscheme pencil

let g:airline_theme = 'pencil'
let g:airline_left_sep = ' '
let g:airline_right_sep = ' '
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#show_buffers = 0
let g:airline#extensions#tabline#left_sep = ' '
let g:airline#extensions#tabline#left_alt_sep = '|'
let g:airline#extensions#tabline#right_sep = ' '
let g:airline#extensions#tabline#right_alt_sep = '|'

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

" Backup and swap files
set backup
set backupdir^=~/.vim/_backup//    " where to put backup files.
set directory^=~/.vim/_temp//      " where to put swap files.

" vspilt files to the right window
let g:netrw_altv = 1

" 30% of window for netrw, 70% for file
let g:netrw_winsize = 70

" don't write error msgs to separate window
let g:netrw_use_errorwindow = 0

" Files and directories to hide
let &wildignore = join(map(split(substitute(
  \ netrw_gitignore#Hide(), '\\.', '.', 'g'), ','), "v:val.','.v:val.'/'"), ',')
set wildignore+=.git/
set wildignore+=.DS_Store
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

" Random Commands
command! Marked !open -a Marked\ 2.app "%"

" Open binary files externally
autocmd BufRead *.png,*.jpg,*.jpeg,*.pdf silent :execute '!open ' . escape(expand('%'), ' ') . ' &'

"since we do not really open the file, go back to the previous buffer
autocmd BufEnter *.png,*.jpg,*.jpeg,*.pdf call GoBackToPreviousAndDelete()
function GoBackToPreviousAndDelete()
  b#
  bdelete#
endfunction
" }}}

" Keyboard bindings {{{
let mapleader = ","
nnoremap - , " restore , functionality

nnoremap <silent> <leader>V :so $MYVIMRC<CR>:filetype detect<CR>

" Press Space to turn off highlighting, clear messages, and redraw
nnoremap <silent> <Space> :nohlsearch<Bar>:echo<Bar>:redraw!<CR>

" Create the directory containing the file in the buffer
nmap <silent> <leader>md :!mkdir -p %:p:h<CR>

" Renames the current file
map <leader>mv :call RenameFile()<cr>

nnoremap <leader><space> :call whitespace#strip_trailing()<CR>

nnoremap <leader><leader> <c-^>
nnoremap <silent> <leader><bar> :wincmd v<CR> " open vertical split
nnoremap <silent> <leader>- :wincmd s<CR> " open horizontal split

nnoremap <leader>t :TagbarToggle<CR>
nnoremap <leader>g :GitGutterToggle<CR>
nnoremap <silent> <leader>u :GundoToggle<CR>

noremap <leader>y "*y
noremap <leader>p "*p

nnoremap <leader>d :VimFiler<CR>
nnoremap <leader>e :VimFilerExplorer<CR>

nnoremap <leader>w :Goyo<CR>
nnoremap <silent> <leader>gq :g/^/norm gqq<CR> " format all paragraphs
nnoremap <silent> <leader>gj :%norm vipJ<CR> " unformat all paragraphs

nnoremap <leader>s :OverCommandLine<CR>
" }}}

" Plugin settings {{{
" VimFiler
let g:vimfiler_as_default_explorer = 1
autocmd FileType vimfiler nunmap <buffer> <C-l>
autocmd FileType vimfiler nmap <buffer> <C-r> <Plug>(vimfiler_redraw_screen)
autocmd FileType vimfiler nmap <buffer> c <Plug>(vimfiler_mark_current_line)<Plug>(vimfiler_copy_file)
autocmd FileType vimfiler nmap <buffer> m <Plug>(vimfiler_mark_current_line)<Plug>(vimfiler_move_file)
autocmd FileType vimfiler nmap <buffer> d <Plug>(vimfiler_mark_current_line)<Plug>(vimfiler_delete_file)
autocmd FileType vimfiler nmap <buffer> <BS> <Plug>(vimfiler_close)
autocmd FileType vimfiler nmap <buffer> - <Plug>(vimfiler_switch_to_parent_directory)

" Goyo
function! s:goyo_enter()
  set noshowmode
  set noshowcmd
  set scrolloff=999
  Limelight
endfunction

function! s:goyo_leave()
  set showmode
  set showcmd
  set scrolloff=5
  set background=dark
  Limelight!
endfunction

autocmd! User GoyoEnter
autocmd! User GoyoLeave
autocmd  User GoyoEnter nested call <SID>goyo_enter()
autocmd  User GoyoLeave nested call <SID>goyo_leave()

" Syntastic
" Make syntastic ignore problematic filetypes
let syntastic_mode_map = { 'passive_filetypes': ['html', 'hbs', 'scss'] }

" Modify coffeelint options
let g:syntastic_coffee_coffeelint_args = "--csv --file ~/.coffeelint.json"

" check on open as well as save
let g:syntastic_check_on_open=1

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

" GitGutter
let g:gitgutter_enabled = 0

" Rainbow Parens
au VimEnter * RainbowParenthesesToggle
au Syntax * RainbowParenthesesLoadRound
au Syntax * RainbowParenthesesLoadSquare
au Syntax * RainbowParenthesesLoadBraces
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
  au BufRead,BufNewFile *.md setlocal textwidth=80
  autocmd FileType markdown setlocal spell

  au BufRead,BufNewFile *.scss set filetype=scss
augroup END
" }}}

" Functions {{{
function! RenameFile()
    let old_name = expand('%')
    let new_name = input('New file name: ', expand('%'), 'file')
    if new_name != '' && new_name != old_name
        exec ':saveas ' . escape(new_name, ' ')
        exec ':silent !rm ' . escape(old_name, ' ')
        redraw!
    endif
endfunction

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
