" Jake Smith's .vimrc
if filereadable(expand("~/.vimrc.bundles"))
  source ~/.vimrc.bundles
endif

" Basic Setup {{{
set nocompatible      " this must be as early as possible
set encoding=utf-8    " Set default encoding to UTF-8
set modelines=1
set ttyfast " Send more characters for redraws
set switchbuf+=usetab
set hidden
set autowrite

" Enable mouse use in all modes
set mouse=a
set ttymouse=xterm2
" }}}

" Colors {{{
syntax enable         " Turn on syntax highlighting allowing local overrides
set background=dark
set t_Co=16           " Use only 16 colors
let g:solarized_termcolors=16
colorscheme solarized
" }}}

" UI {{{
set number            " Show line numbers
set ruler             " Show line and column number
set showcmd
set colorcolumn=81
set scrolloff=3       " keep 3 lines visible
set showmatch " show matching brackets
set cmdheight=2
set laststatus=2  " always show the status bar
" Open new split panes to right and bottom
set splitbelow
set splitright
" }}}

" GUI {{{
if has("gui_running")
  if has("autocmd")
    " Automatically resize splits when resizing MacVim window
    autocmd VimResized * wincmd =
  endif
endif
" }}}

" Whitespace {{{
set nowrap                        " don't wrap lines
set tabstop=2                     " a tab is two spaces
set expandtab                     " use spaces, not tabs
set softtabstop=2                 " 2 space tab
set shiftwidth=2                  " an autoindent (with <<) is two spaces
set shiftround                    " round indent to shiftwidth
set backspace=indent,eol,start    " backspace through everything in insert mode

" Indentation
set autoindent
set smartindent

" List chars
set list                  " Show invisible characters
set listchars=""          " Reset the listchars
set listchars=tab:\ \     " a tab should display as "  "
set listchars+=trail:.    " show trailing spaces as dots
set listchars+=extends:>  " The character to show in the last column when wrap is
                          " off and the line continues beyond the right of the screen
set listchars+=precedes:< " The character to show in the last column when wrap is
                          " off and the line continues beyond the left of the screen
" }}}

" Folding {{{
set foldmethod=indent   " fold based on indent level
set foldnestmax=10      " max 10 depth
set foldenable          " don't fold files by default on open
set foldlevelstart=10   " start with fold level of 10
" }}}

" Searching {{{
set hlsearch    " highlight matches
set incsearch   " incremental searching
set ignorecase  " searches are case insensitive...
set smartcase   " ... unless they contain at least one capital letter
set infercase   " Use the correct case when autocompleting
" }}}

" Wild settings {{{
" TODO: Investigate the precise meaning of these settings
" set wildmode=list:longest,list:full

" Disable output and VCS files
set wildignore+=*.o,*.out,*.obj,.git,*.rbc,*.rbo,*.class,.svn,*.gem

" Disable archive files
set wildignore+=*.zip,*.tar.gz,*.tar.bz2,*.rar,*.tar.xz

" Ignore bundler and sass cache
set wildignore+=*/vendor/gems/*,*/vendor/cache/*,*/.bundle/*,*/.sass-cache/*

" Ignore librarian-chef, vagrant, test-kitchen and Berkshelf cache
set wildignore+=*/tmp/librarian/*,*/.vagrant/*,*/.kitchen/*,*/vendor/cookbooks/*

" Ignore rails temporary asset caches
set wildignore+=*/tmp/cache/assets/*/sprockets/*,*/tmp/cache/assets/*/sass/*

" Disable temp and backup files
set wildignore+=*.swp,*~,._*
" }}}

" Backup and swap files {{{
set backup
set backupdir^=~/.vim/_backup//    " where to put backup files.
set directory^=~/.vim/_temp//      " where to put swap files.
" }}}

" Misc settings {{{
" fix regexes default regex handling by auto-inserting \v before every REGEX.
" Now regexs are Ruby compatible
nnoremap / /\v
vnoremap / /\v

" fix & command to preserve flags
nnoremap & :&&<CR>
xnoremap & :&&<CR>

" replace last 'c' character with $
set cpoptions+=$

set history=50 " remember lots of : commands and search patterns
set t_ti= t_te= " leave vim session in terminal after quit

" Open quickfix after any grep
autocmd QuickFixCmdPost *grep* cwindow

" Ignore non project files in ctrlp
let g:ctrlp_custom_ignore = {
  \ 'dir':  '\v[\/](\.git|\.template|node_modules|development|release)$',
  \ }
" }}}

" Misc bindings {{{
let mapleader = ","
nnoremap - , " restore , functionality
let maplocalleader = "\\"

nnoremap <silent> <leader>emv :e $MYVIMRC<CR>
nnoremap <silent> <leader>smv :so $MYVIMRC<CR>

" Press Space to turn off highlighting, clear messages, and redraw
nnoremap <silent> <Space> :nohlsearch<Bar>:echo<Bar>:redraw!<CR>

" Create the directory containing the file in the buffer
nmap <silent> <leader>md :!mkdir -p %:p:h<CR>

" Some helpers to edit mode
" " http://vimcasts.org/e/14
nmap <leader>ew :e <C-R>=expand('%:h').'/'<cr>
nmap <leader>es :sp <C-R>=expand('%:h').'/'<cr>
nmap <leader>ev :vsp <C-R>=expand('%:h').'/'<cr>
nmap <leader>et :tabe <C-R>=expand('%:h').'/'<cr>

" Underline the current line with '='
nmap <silent> <leader>ul :t.<CR>Vr=

" Yank/put to/from system clipboard
map <leader>y "+y
map <leader>p "+p

nnoremap <silent> <leader>u :GundoToggle<CR>
noremap <silent> <leader>w :call ToggleWrap()<CR>

nnoremap <leader><leader> <c-^>
map <leader>n :call RenameFile()<cr>
map <leader>d :call OpenChangedFiles()<cr>

nnoremap <silent> <Leader><CR> :call VimuxSendKeys("Enter")<CR>
noremap <Leader>vp :VimuxPromptCommand<CR>
" }}}

" Navigation bindings {{{
nnoremap <silent> H ^
nnoremap <silent> L $
" }}}

" Window bindings {{{
nnoremap <silent> <leader>v :wincmd v<CR> " open vertical split
nnoremap <silent> <leader>s :wincmd s<CR> " open split
map <Leader>= <C-w>= " Adjust viewports to the same size
" }}}

" Syntastic {{{
" Make syntastic ignore problematic filetypes
let syntastic_mode_map = { 'passive_filetypes': ['html', 'hbs', 'scss'] }

" Modify coffeelint options
let g:syntastic_coffee_coffeelint_args = "--csv --file ~/.coffeelint.json"

" check on open as well as save
let g:syntastic_check_on_open=1
" }}}

" NERDTree {{{
let NERDTreeShowLineNumbers=1
" Don't let NERDTree overwrite C-J/C-K
let g:NERDTreeMapJumpNextSibling=''
let g:NERDTreeMapJumpPrevSibling=''
" }}}

" Airline {{{
let g:airline_powerline_fonts = 1
let g:airline#extensions#tabline#enabled = 1
" }}}

" The Silver Searcher {{{
if executable('ag')
  " Use Ag over Grep
  set grepprg=ag\ --nogroup\ --nocolor

  " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
  let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'

  " ag is fast enough that CtrlP doesn't need to cache
  let g:ctrlp_use_caching = 0

  " Use ag for Ack.vim
  let g:ackprg = 'ag --nogroup --nocolor --column'
endif
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

  au bufread,BufNewFile *.md set filetype=markdown
  au bufread,BufNewFile *.scss set filetype=scss

  " Enable spellchecking for Markdown
  autocmd FileType markdown setlocal spell

  " Automatically wrap at 80 characters for Markdown
  autocmd BufRead,BufNewFile *.md setlocal textwidth=80
augroup END
" }}}

" Functions {{{
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" RENAME CURRENT FILE
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! RenameFile()
    let old_name = expand('%')
    let new_name = input('New file name: ', expand('%'), 'file')
    if new_name != '' && new_name != old_name
        exec ':saveas ' . new_name
        exec ':silent !rm ' . old_name
        redraw!
    endif
endfunction

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" OpenChangedFiles COMMAND
" Open a split for each dirty file in git
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! OpenChangedFiles()
  only " Close all windows, unless they're modified
  let status = system('git status -s | grep "^ \?\(M\|A\|UU\)" | sed "s/^.\{3\}//"')
  let filenames = split(status, "\n")
  exec "edit " . filenames[0]
  for filename in filenames[1:]
    exec "sp " . filename
  endfor
endfunction
command! OpenChangedFiles :call OpenChangedFiles()

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" InsertTime COMMAND
" Insert the current time
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
command! InsertTime :normal a<c-r>=strftime('%F %H:%M:%S.0 %z')<cr>

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" ToggleWrap
" Turn wrapping on and make navigation easier
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! ToggleWrap()
  if &wrap
    echo "Wrap OFF"
    setlocal nowrap
    set virtualedit=all
    silent! nunmap <buffer> k
    silent! nunmap <buffer> j
    silent! nunmap <buffer> <Home>
    silent! nunmap <buffer> <End>
    silent! iunmap <buffer> <Up>
    silent! iunmap <buffer> <Down>
    silent! iunmap <buffer> <Home>
    silent! iunmap <buffer> <End>
  else
    echo "Wrap ON"
    setlocal wrap linebreak nolist
    set virtualedit=
    setlocal display+=lastline
    noremap  <buffer> <silent> k gk
    noremap  <buffer> <silent> j gj
    noremap  <buffer> <silent> <Home> g<Home>
    noremap  <buffer> <silent> <End>  g<End>
    inoremap <buffer> <silent> <Up>   <C-o>gk
    inoremap <buffer> <silent> <Down> <C-o>gj
    inoremap <buffer> <silent> <Home> <C-o>g<Home>
    inoremap <buffer> <silent> <End>  <C-o>g<End>
  endif
endfunction
" }}}
" vim: foldmethod=marker:foldlevel=0
